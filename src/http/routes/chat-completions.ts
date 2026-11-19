import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProviderError } from '../../core/errors';
import { newRequestId } from '../../core/ids';
import {
  type AdapterMapEntry,
  type Candidate,
  type ExecuteMeta,
  type ExecuteOptions,
  type ExecuteStreamOptions,
} from '../../core/execute';
import type { CanonicalChunk, CanonicalRequest, CanonicalResponse } from '../../core/types';
import { resolvePolicy, type LimitPolicy } from '../../limits/policy';
import { createProviderRegistry, type ProviderRegistry } from '../../providers/registry';
import type { ProviderAdapter } from '../../providers/types';
import { type EvalTable, type LruMap } from '../../routing/select';
import { isFreeRequest, resolveFreeCandidates } from '../../routing/free-model';
import { loadEvalTable } from '../../routing/eval-table-loader';
import { ApiError, headersForError, statusForError, toEnvelope } from '../errors';
import { extractIdempotencyKey, replayResponse } from '../middleware/idempotency';
import { ChatRequest, ChatResponse } from '../schemas';
import type { ServerDeps } from '../server';
import { makeCredential } from '../../credentials/pool';
import type { Credential } from '../../providers/types';
import type { UserProviderKey } from '../../models/user-provider-key';
import { formatSseChunk, SSE_DONE, writeWithBackpressure } from '../sse';
import { buildRouterRuntime, type ChatRouterDeps, type RouterRuntime } from './router-runtime';

export type { ChatRouterDeps, RouterRuntime };

const UNSUPPORTED_FIELDS = [
  'logprobs',
  'top_logprobs',
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'modalities',
  'audio',
] as const;

const IGNORED_FIELDS = [
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'store',
  'metadata',
  'service_tier',
  'user',
] as const;

/**
 * The boundary rule, in one place.
 *
 * Harmless fields are accepted and ignored. Meaning-changing fields are rejected
 * with a named 501 rather than silently dropped. Malformed fields never reach here:
 * Fastify's schema validation rejects them first and the error handler remaps them.
 */
export function assertSupported(body: unknown, log?: (message: string) => void): void {
  if (typeof body !== 'object' || body === null) {
    throw new ApiError('client', 'request body must be a JSON object');
  }

  const raw = body as Record<string, unknown>;

  if (raw.n !== undefined && raw.n !== null) {
    const numeric = typeof raw.n === 'number' ? raw.n : Number(raw.n);
    if (Number.isFinite(numeric) && numeric > 1) {
      throw new ApiError(
        'unsupported',
        'n > 1 is not supported: the gateway returns a single choice',
      );
    }
  }

  for (const field of UNSUPPORTED_FIELDS) {
    if (raw[field] !== undefined) {
      throw new ApiError('unsupported', `${field} is not supported`);
    }
  }

  for (const field of IGNORED_FIELDS) {
    if (raw[field] !== undefined) {
      log?.(`ignoring harmless OpenAI parameter: ${field}`);
    }
  }
}

export function registerChatCompletions(
  app: FastifyInstance,
  deps: ServerDeps & ChatRouterDeps,
): RouterRuntime {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();
  const now = deps.now ?? Date.now;
  const lru: LruMap = deps.lru ?? new Map<string, number>();
  const evalTable: EvalTable = deps.evalTable ?? loadEvalTable();

  const registry = deps.registry ?? createProviderRegistry(deps.adapters ?? [deps.provider]);
  const adapterMap = buildAdapterMap(registry, deps.provider);

  const routerRuntime = buildRouterRuntime(app, deps, now, lru, evalTable);
  const idempotencyService = routerRuntime.idempotencyService;

  server.post(
    '/v1/chat/completions',
    {
      schema: { body: ChatRequest, response: { 200: ChatResponse } },
      preHandler: async (req) => {
        assertSupported(req.body, (message) => req.log.debug(message));
      },
    },
    async (req, reply) => {
      const startedAt = now();
      const idempotencyKey = extractIdempotencyKey(req.headers);
      let idempotencyContext: { token: string; completed: boolean } | undefined;

      if (idempotencyKey !== undefined && idempotencyService !== undefined) {
        const decision = await idempotencyService.process(idempotencyKey, {
          signal: req.raw.signal ?? req.signal,
        });

        if (decision.type === 'replay') {
          return replayResponse(reply, decision.response);
        }

        idempotencyContext = { token: decision.lockToken, completed: false };
      }

      const isStream = req.body.stream === true;
      const canonical: CanonicalRequest = {
        model: req.body.model,
        messages: req.body.messages,
        temperature: req.body.temperature,
        top_p: req.body.top_p,
        max_tokens: req.body.max_tokens,
        stop: req.body.stop,
        response_format: req.body.response_format,
        stream: isStream,
        user: req.body.user,
      };

      const userCredentials = await buildUserCredentials(req, deps);

      // Strict Free-Tier Policy: User requests (gk_ key auth) ALWAYS route
      // exclusively through the dynamically resolved free model pool.
      // Callers cannot bypass the pool to invoke arbitrary or paid models.
      let candidates;
      if (deps.candidates !== undefined) {
        candidates = [...deps.candidates];
      } else if (userCredentials !== undefined) {
        const freeCandidates = await resolveFreeCandidates(registry, userCredentials);
        if (canonical.model && !isFreeRequest(canonical.model)) {
          const requested = canonical.model.trim().toLowerCase();
          const matched = freeCandidates.filter(
            (c) =>
              c.modelId.toLowerCase() === requested ||
              c.modelId.toLowerCase().endsWith('/' + requested),
          );
          if (matched.length > 0) {
            const others = freeCandidates.filter((c) => !matched.includes(c));
            candidates = [...matched, ...others];
          } else {
            // Requested model is not in the free pool (e.g. "gpt-4o"):
            // Ignore the paid model and route to the best available free model.
            candidates = freeCandidates;
          }
        } else {
          candidates = freeCandidates;
        }
      } else {
        candidates = buildCandidates(deps, registry, canonical, userCredentials);
      }
      const policies = deps.policies ?? buildPolicies(candidates);

      if (isStream) {
        const clientController = new AbortController();
        const onClientClose = () => {
          if (!reply.raw.writableEnded) {
            clientController.abort();
          }
        };
        req.raw.on('close', onClientClose);
        if (req.signal) {
          req.signal.addEventListener('abort', () => clientController.abort(), { once: true });
        }

        let meta: ExecuteMeta | undefined;
        const callOptions: ExecuteStreamOptions = {
          maxAttempts: deps.maxAttempts,
          totalDeadlineMs: deps.config.requestDeadlineMs,
          attemptTimeoutMs: deps.config.attemptTimeoutMs,
          evalTable,
          lru,
          parking: routerRuntime.parking,
          clock: now,
          signal: clientController.signal,
          // Accounting: one row per terminal path, correlated to the same
          // x-request-id the caller sees. Without the store the requests table
          // stays empty and the dashboard usage strip cannot tell the truth.
          ...(deps.accountingStore !== undefined ? { accountingStore: deps.accountingStore } : {}),
          requestId: req.gatewayRequestId,
          ...(req.user !== undefined ? { userId: req.user.id } : {}),
          onFirstChunk: (completed) => {
            meta = completed;
          },
          onComplete: (completed) => {
            meta = completed;
          },
        };

        const stream = routerRuntime.runStream(
          canonical,
          candidates,
          policies,
          adapterMap,
          callOptions,
        );

        const iterator = stream[Symbol.asyncIterator]();
        let firstItem: IteratorResult<CanonicalChunk>;

        try {
          firstItem = await iterator.next();
        } catch (err) {
          req.raw.off('close', onClientClose);
          if (idempotencyContext) {
            await idempotencyService
              .release(idempotencyKey!, idempotencyContext.token)
              .catch(() => {});
          }
          if (err instanceof ProviderError) {
            const status = statusForError(err);
            const headers = headersForError(err);
            for (const [name, value] of Object.entries(headers)) {
              reply.header(name, value);
            }
            if (err.kind === 'rate_limited' && headers['retry-after'] === undefined) {
              reply.header('retry-after', '1');
            }
            const rawReply: FastifyReply = reply;
            return rawReply.status(status).send(toEnvelope(err));
          }
          throw err;
        }

        const requestId = req.gatewayRequestId ?? newRequestId();
        const providerId = meta?.providerId ?? deps.provider.id;
        const model = meta?.modelId ?? canonical.model ?? providerId;
        const attempts = meta?.attempts ?? 1;
        const latencyMs = Math.max(0, now() - startedAt);

        const sseHeadersEnabled = deps.config?.sseHeadersEnabled !== false;
        const streamHeaders: Record<string, string> = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': sseHeadersEnabled ? 'no-cache, no-transform' : 'no-cache',
          Connection: 'keep-alive',
          'x-request-id': requestId,
          'x-gateway-provider': providerId,
          'x-gateway-model': model,
          'x-gateway-attempts': String(attempts),
          'x-gateway-latency-ms': String(latencyMs),
        };

        if (sseHeadersEnabled) {
          streamHeaders['X-Accel-Buffering'] = 'no';
          streamHeaders['Content-Encoding'] = 'none';
        }

        reply.hijack();
        reply.raw.writeHead(200, streamHeaders);

        if (typeof reply.raw.flushHeaders === 'function') {
          reply.raw.flushHeaders();
        }

        const recordedChunks: string[] = [];

        if (firstItem.done) {
          recordedChunks.push(SSE_DONE);
          reply.raw.write(SSE_DONE);
          reply.raw.end();
          req.raw.off('close', onClientClose);
          if (idempotencyContext) {
            await idempotencyService.complete(idempotencyKey!, idempotencyContext.token, {
              statusCode: 200,
              headers: streamHeaders,
              isStream: true,
              chunks: recordedChunks,
            });
            idempotencyContext.completed = true;
          }
          return;
        }

        const keepaliveIntervalMs = deps.keepaliveIntervalMs ?? 15_000;
        let lastWriteTime = (deps.now ?? Date.now)();
        let keepaliveTimer: NodeJS.Timeout | undefined;

        try {
          const firstChunkStr = formatSseChunk(firstItem.value, requestId, model);
          recordedChunks.push(firstChunkStr);
          await writeWithBackpressure(reply.raw, firstChunkStr, clientController.signal);
          lastWriteTime = (deps.now ?? Date.now)();

          if (keepaliveIntervalMs > 0) {
            keepaliveTimer = setInterval(
              () => {
                if (
                  clientController.signal.aborted ||
                  reply.raw.writableEnded ||
                  reply.raw.destroyed
                ) {
                  if (keepaliveTimer !== undefined) {
                    clearInterval(keepaliveTimer);
                    keepaliveTimer = undefined;
                  }
                  return;
                }
                const current = (deps.now ?? Date.now)();
                if (current - lastWriteTime >= keepaliveIntervalMs) {
                  reply.raw.write(': keepalive\n\n');
                  lastWriteTime = current;
                }
              },
              Math.min(keepaliveIntervalMs, 1000),
            );
            keepaliveTimer.unref?.();
          }

          while (true) {
            if (clientController.signal.aborted) break;
            const nextItem = await iterator.next();
            if (nextItem.done) break;
            const chunkStr = formatSseChunk(nextItem.value, requestId, model);
            recordedChunks.push(chunkStr);
            const ok = await writeWithBackpressure(reply.raw, chunkStr, clientController.signal);
            lastWriteTime = (deps.now ?? Date.now)();
            if (!ok) break;
          }

          if (!reply.raw.writableEnded) {
            recordedChunks.push(SSE_DONE);
            await writeWithBackpressure(reply.raw, SSE_DONE, clientController.signal);
            reply.raw.end();
            if (idempotencyContext && !clientController.signal.aborted) {
              await idempotencyService.complete(idempotencyKey!, idempotencyContext.token, {
                statusCode: 200,
                headers: streamHeaders,
                isStream: true,
                chunks: recordedChunks,
              });
              idempotencyContext.completed = true;
            }
          }
        } catch (err) {
          if (!reply.raw.writableEnded) {
            const providerErr =
              err instanceof ProviderError
                ? err
                : new ProviderError('upstream', String(err), { status: 502, provider: providerId });
            reply.raw.write(`event: error\ndata: ${JSON.stringify(toEnvelope(providerErr))}\n\n`);
            reply.raw.end();
          }
        } finally {
          if (keepaliveTimer !== undefined) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = undefined;
          }
          req.raw.off('close', onClientClose);
          if (idempotencyContext && !idempotencyContext.completed) {
            await idempotencyService
              .release(idempotencyKey!, idempotencyContext.token)
              .catch(() => {});
          }
        }
        return;
      }

      let meta: ExecuteMeta | undefined;
      const callOptions: ExecuteOptions = {
        maxAttempts: deps.maxAttempts,
        totalDeadlineMs: deps.config.requestDeadlineMs,
        attemptTimeoutMs: deps.config.attemptTimeoutMs,
        evalTable,
        lru,
        parking: routerRuntime.parking,
        clock: now,
        ...(deps.accountingStore !== undefined ? { accountingStore: deps.accountingStore } : {}),
        requestId: req.gatewayRequestId,
        ...(req.user !== undefined ? { userId: req.user.id } : {}),
        onComplete: (completed) => {
          meta = completed;
        },
      };

      try {
        let response: CanonicalResponse;
        try {
          response = await routerRuntime.run(
            canonical,
            candidates,
            policies,
            adapterMap,
            callOptions,
          );
        } catch (err) {
          if (idempotencyContext) {
            await idempotencyService
              .release(idempotencyKey!, idempotencyContext.token)
              .catch(() => {});
          }
          if (err instanceof ProviderError) {
            const status = statusForError(err);
            const headers = headersForError(err);
            for (const [name, value] of Object.entries(headers)) {
              reply.header(name, value);
            }
            if (err.kind === 'rate_limited' && headers['retry-after'] === undefined) {
              reply.header('retry-after', '1');
            }
            const rawReply: FastifyReply = reply;
            return rawReply.status(status).send(toEnvelope(err));
          }
          throw err;
        }

        const requestId = req.gatewayRequestId ?? newRequestId();
        const providerId = meta?.providerId ?? deps.provider.id;
        const model = response.model || meta?.modelId || canonical.model || providerId;
        const attempts = meta?.attempts ?? 1;
        const latencyMs = Math.max(0, now() - startedAt);

        const responseHeaders: Record<string, string> = {
          'x-request-id': requestId,
          'x-gateway-provider': providerId,
          'x-gateway-model': model,
          'x-gateway-attempts': String(attempts),
          'x-gateway-latency-ms': String(latencyMs),
          'x-gateway-tokens-estimated': response.usage.estimated ? 'true' : 'false',
        };

        for (const [name, value] of Object.entries(responseHeaders)) {
          reply.header(name, value);
        }

        const responseBody = {
          id: requestId,
          object: 'chat.completion' as const,
          created: response.created,
          model,
          choices: response.choices.map((choice) => ({
            index: choice.index,
            message: { role: 'assistant' as const, content: choice.message.content },
            finish_reason: choice.finish_reason,
          })),
          usage: {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          },
        };

        if (idempotencyContext) {
          await idempotencyService.complete(idempotencyKey!, idempotencyContext.token, {
            statusCode: 200,
            headers: responseHeaders,
            isStream: false,
            body: responseBody,
          });
          idempotencyContext.completed = true;
        }

        return reply.send(responseBody);
      } finally {
        if (idempotencyContext && !idempotencyContext.completed) {
          await idempotencyService
            .release(idempotencyKey!, idempotencyContext.token)
            .catch(() => {});
        }
      }
    },
  );

  // Exposed so the composition root can hand the SAME parking instance to other
  // routes. Parking is constructed inside `buildRouterRuntime`, so without this
  // nothing outside this module can reach the only real per-credential reader.
  return routerRuntime;
}

function buildAdapterMap(
  registry: ProviderRegistry,
  fallbackProvider: ProviderAdapter,
): Map<string, AdapterMapEntry> {
  const adapterMap = new Map<string, AdapterMapEntry>();
  for (const id of registry.ids()) {
    const adapter = registry.get(id);
    if (adapter !== undefined) {
      adapterMap.set(id, { adapter, providerId: id });
    }
  }
  if (!adapterMap.has(fallbackProvider.id)) {
    adapterMap.set(fallbackProvider.id, {
      adapter: fallbackProvider,
      providerId: fallbackProvider.id,
    });
  }
  return adapterMap;
}

function buildCandidates(
  deps: ServerDeps & ChatRouterDeps,
  registry: ProviderRegistry,
  canonical: CanonicalRequest,
  userCredentials?: Credential[],
): Candidate[] {
  if (deps.candidates !== undefined) {
    return [...deps.candidates];
  }

  // Strict BYOK is enforced in buildUserCredentials(): if req.user is set
  // (gk_ key auth), it returns the user's saved keys or [] — never undefined.
  // buildCandidates then returns [] for empty list → 503 exhausted.
  // The pool/credential fallbacks below only apply to admin/test requests
  // where req.user is undefined (no gk_ key).
  if (userCredentials !== undefined) {
    // User credentials must always be resolved via resolveFreeCandidates.
    return [];
  }

  if (deps.pool !== undefined) {
    const candidates: Candidate[] = [];
    for (const providerId of registry.ids()) {
      for (const credential of deps.pool.getCandidates(providerId)) {
        candidates.push({
          modelId: canonical.model ?? providerId,
          credential,
          providerId,
          adapterId: providerId,
        });
      }
    }
    return candidates;
  }

  return [
    {
      modelId: canonical.model ?? deps.provider.id,
      credential: deps.credential,
      providerId: deps.provider.id,
      adapterId: deps.provider.id,
    },
  ];
}

function buildPolicies(candidates: ReadonlyArray<Candidate>): Map<string, LimitPolicy> {
  const policies = new Map<string, LimitPolicy>();
  for (const candidate of candidates) {
    if (!policies.has(candidate.modelId)) {
      policies.set(candidate.modelId, resolvePolicy(candidate.providerId, candidate.modelId));
    }
  }
  return policies;
}

/**
 * Exported for its unit test: the dedupe below is a budget-correctness rule, not
 * an implementation detail.
 */
export async function buildUserCredentials(
  req: FastifyRequest,
  deps: ServerDeps & ChatRouterDeps,
): Promise<Credential[] | undefined> {
  if (req.user === undefined) {
    return undefined;
  }

  const providerKeyStore = deps.providerKeyStore;
  if (providerKeyStore === undefined) {
    return undefined;
  }

  const keys: UserProviderKey[] = await providerKeyStore.listKeys(req.user.id);
  const credentials: Credential[] = [];
  // One secret is one account, and the ledger keys budgets on the credential id.
  // Two rows holding the same secret would otherwise each earn a budget for a
  // single account, so the pool would believe in headroom that does not exist.
  // The env path in `credentials/pool.ts` already dedupes for this same reason.
  const seen = new Set<string>();
  for (const key of keys) {
    const secret = await providerKeyStore.getDecryptedKey(req.user.id, key.id);
    if (secret === null || seen.has(secret)) {
      continue;
    }
    seen.add(secret);
    const provider = key.provider === 'nvidia-nim' ? 'nvidia' : key.provider;
    credentials.push(makeCredential(provider, key.id, key.id, secret));
  }
  return credentials;
}

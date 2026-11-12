import { timingSafeEqual } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProviderError } from '../../core/errors';
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
import { createDefaultEvalTable, type EvalTable, type LruMap } from '../../routing/select';
import { ApiError, headersForError, statusForError, toEnvelope } from '../errors';
import { extractIdempotencyKey, replayResponse } from '../middleware/idempotency';
import { ChatRequest, ChatResponse } from '../schemas';
import type { ServerDeps } from '../server';
import { formatSseChunk, SSE_DONE, writeWithBackpressure } from '../sse';
import { buildRouterRuntime, type ChatRouterDeps, type RouterRuntime } from './router-runtime';

export type { ChatRouterDeps, RouterRuntime };

/** Verify the admin token on protected endpoints. */
function assertAuthorized(req: FastifyRequest, expected: string): void {
  const header = req.headers.authorization;
  const match = header === undefined ? null : /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();

  if (token === undefined || token.length === 0) {
    throw new ApiError('auth', 'missing bearer token');
  }

  if (!constantTimeEqual(token, expected)) {
    throw new ApiError('auth', 'invalid gateway key');
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');

  if (a.length !== b.length) {
    // Keep the comparison cost independent of where the lengths differ.
    timingSafeEqual(a, a);
    return false;
  }

  return timingSafeEqual(a, b);
}

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
): void {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();
  const now = deps.now ?? Date.now;
  const lru: LruMap = deps.lru ?? new Map<string, number>();
  const evalTable: EvalTable = deps.evalTable ?? createDefaultEvalTable();

  const registry = deps.registry ?? createProviderRegistry(deps.adapters ?? [deps.provider]);
  const adapterMap = buildAdapterMap(registry, deps.provider);

  const routerRuntime = buildRouterRuntime(app, deps, now, lru, evalTable);
  const idempotencyService = routerRuntime.idempotencyService;

  server.post(
    '/v1/chat/completions',
    {
      schema: { body: ChatRequest, response: { 200: ChatResponse } },
      preHandler: async (req) => {
        assertAuthorized(req, deps.config.adminToken);
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

      const candidates = buildCandidates(deps, registry, canonical);
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

        const requestId = req.gatewayRequestId;
        const providerId = meta?.providerId ?? deps.provider.id;
        const model = meta?.modelId ?? canonical.model ?? providerId;
        const attempts = meta?.attempts ?? 1;
        const latencyMs = Math.max(0, now() - startedAt);

        const streamHeaders: Record<string, string> = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'x-request-id': requestId,
          'x-gateway-provider': providerId,
          'x-gateway-model': model,
          'x-gateway-attempts': String(attempts),
          'x-gateway-latency-ms': String(latencyMs),
        };

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

        try {
          const firstChunkStr = formatSseChunk(firstItem.value, requestId, model);
          recordedChunks.push(firstChunkStr);
          await writeWithBackpressure(reply.raw, firstChunkStr, clientController.signal);

          while (true) {
            if (clientController.signal.aborted) break;
            const nextItem = await iterator.next();
            if (nextItem.done) break;
            const chunkStr = formatSseChunk(nextItem.value, requestId, model);
            recordedChunks.push(chunkStr);
            const ok = await writeWithBackpressure(reply.raw, chunkStr, clientController.signal);
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

        const requestId = req.gatewayRequestId;
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
): Candidate[] {
  if (deps.candidates !== undefined) {
    return [...deps.candidates];
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

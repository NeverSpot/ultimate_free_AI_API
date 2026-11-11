import { timingSafeEqual } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProviderError } from '../../core/errors';
import {
  createExecutor,
  execute,
  type AdapterMapEntry,
  type Candidate,
  type ExecuteMeta,
  type ExecuteOptions,
} from '../../core/execute';
import type { CanonicalRequest, CanonicalResponse } from '../../core/types';
import type { CredentialPool } from '../../credentials/pool';
import { createLedger, type Ledger } from '../../limits/ledger';
import { resolvePolicy, type LimitPolicy } from '../../limits/policy';
import { createLedgerClient, type LedgerClient } from '../../limits/redis';
import { createProviderRegistry, type ProviderRegistry } from '../../providers/registry';
import type { ProviderAdapter } from '../../providers/types';
import { type Breaker, type BreakerClient } from '../../resilience/breaker';
import { createParking, type Parking } from '../../resilience/parking';
import { createDefaultEvalTable, type EvalTable, type LruMap } from '../../routing/select';
import { ApiError, headersForError, statusForError, toEnvelope } from '../errors';
import { ChatRequest, ChatResponse } from '../schemas';
import type { ServerDeps } from '../server';

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

/** Optional router wiring accepted alongside Phase A ServerDeps. */
export interface ChatRouterDeps {
  pool?: CredentialPool;
  registry?: ProviderRegistry;
  adapters?: ProviderAdapter[];
  candidates?: ReadonlyArray<Candidate>;
  policies?: Map<string, LimitPolicy>;
  redisUrl?: string;
  ledgerClient?: LedgerClient;
  breakerClient?: BreakerClient;
  ledger?: Ledger;
  breaker?: Breaker;
  parking?: Parking;
  evalTable?: EvalTable;
  lru?: LruMap;
  maxAttempts?: number;
}

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

  if (raw.stream === true) {
    throw new ApiError('unsupported', 'stream: true is not supported until Block 10');
  }

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
      const canonical: CanonicalRequest = {
        model: req.body.model,
        messages: req.body.messages,
        temperature: req.body.temperature,
        top_p: req.body.top_p,
        max_tokens: req.body.max_tokens,
        stop: req.body.stop,
        response_format: req.body.response_format,
        stream: false,
        user: req.body.user,
      };

      const candidates = buildCandidates(deps, registry, canonical);
      const policies = deps.policies ?? buildPolicies(candidates);

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

      reply.header('x-request-id', requestId);
      reply.header('x-gateway-provider', providerId);
      reply.header('x-gateway-model', model);
      reply.header('x-gateway-attempts', String(attempts));
      reply.header('x-gateway-latency-ms', String(latencyMs));
      reply.header('x-gateway-tokens-estimated', response.usage.estimated ? 'true' : 'false');

      return reply.send({
        id: requestId,
        object: 'chat.completion',
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
      });
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

function buildRouterRuntime(
  app: FastifyInstance,
  deps: ServerDeps & ChatRouterDeps,
  now: () => number,
  lru: LruMap,
  evalTable: EvalTable,
): {
  parking: Parking | undefined;
  run: (
    req: CanonicalRequest,
    candidates: ReadonlyArray<Candidate>,
    policies: Map<string, LimitPolicy>,
    adapterMap: Map<string, AdapterMapEntry>,
    options: ExecuteOptions,
  ) => Promise<CanonicalResponse>;
} {
  let ownedRedisClient: LedgerClient | undefined;
  let ledgerClient = deps.ledgerClient;
  let breakerClient = deps.breakerClient;

  if (deps.redisUrl !== undefined && (ledgerClient === undefined || breakerClient === undefined)) {
    ownedRedisClient = createLedgerClient(deps.redisUrl);
    ledgerClient ??= ownedRedisClient;
    breakerClient ??= ownedRedisClient;
    app.addHook('onClose', async () => {
      ownedRedisClient?.disconnect();
    });
  }

  if (deps.ledger !== undefined || deps.breaker !== undefined) {
    const ledger = deps.ledger ?? createLedger(noopClient());
    const breaker = deps.breaker ?? passThroughBreaker();
    return {
      parking: deps.parking,
      run: (req, candidates, policies, adapterMap, options) =>
        execute(req, candidates, ledger, policies, adapterMap, breaker, options),
    };
  }

  if (ledgerClient !== undefined && breakerClient !== undefined) {
    const executor = createExecutor(ledgerClient, breakerClient, {
      totalDeadlineMs: deps.config.requestDeadlineMs,
      attemptTimeoutMs: deps.config.attemptTimeoutMs,
      evalTable,
      lru,
      clock: now,
    });
    const parking = deps.parking ?? createParking(ledgerClient);
    return {
      parking,
      run: (req, candidates, policies, adapterMap, options) =>
        executor.execute(req, candidates, policies, adapterMap, options),
    };
  }

  // Hermetic Phase A fallback when no Redis client is wired (e.g. unit http.test.ts).
  const ledger = createLedger(noopClient());
  const breaker = passThroughBreaker();
  return {
    parking: deps.parking,
    run: (req, candidates, policies, adapterMap, options) =>
      execute(req, candidates, ledger, policies, adapterMap, breaker, options),
  };
}

function noopClient(): LedgerClient {
  return {
    defineCommand() {
      throw new Error('chat-completions: Redis LedgerClient is required for enforced limits');
    },
    disconnect() {},
  };
}

function passThroughBreaker(): Breaker {
  return {
    allow: async () => ({ allowed: true }),
    recordSuccess: async () => {},
    recordFailure: async () => {},
  };
}

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

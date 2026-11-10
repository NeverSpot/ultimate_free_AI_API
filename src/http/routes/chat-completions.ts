import { timingSafeEqual } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CanonicalRequest } from '../../core/types';
import { ApiError } from '../errors';
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

export function registerChatCompletions(app: FastifyInstance, deps: ServerDeps): void {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();
  const now = deps.now ?? Date.now;

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

      const response = await chatWithTimeout(deps, canonical, deps.config.attemptTimeoutMs);

      const requestId = req.gatewayRequestId;
      const model = response.model || canonical.model || deps.provider.id;
      const latencyMs = Math.max(0, now() - startedAt);

      reply.header('x-request-id', requestId);
      reply.header('x-gateway-provider', deps.provider.id);
      reply.header('x-gateway-model', model);
      reply.header('x-gateway-attempts', '1');
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

async function chatWithTimeout(
  deps: ServerDeps,
  canonical: CanonicalRequest,
  timeoutMs: number,
): Promise<Awaited<ReturnType<ServerDeps['provider']['chat']>>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError('timeout', `provider attempt timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      deps.provider.chat(canonical, deps.credential, controller.signal),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

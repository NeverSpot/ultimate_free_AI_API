import { ProviderError } from '../core/errors';
import { makeCredential } from '../credentials/pool';
import type { ModelInfo, ProviderAdapter } from './types';

/**
 * One live check of a stored provider key.
 *
 * The keys screen needs to answer "is this key actually working?" without the
 * user writing a client first. The cheapest honest answer is a real upstream
 * call: list the provider's models, choose one that advertises itself as free,
 * and send a tiny chat completion. The gateway router is deliberately not used
 * here — it would test whichever provider had capacity, not the key in the row.
 */
export interface KeyTestResult {
  ok: boolean;
  provider: string;
  model: string | null;
  /** Duration of the chat call only; model discovery is not the key's latency. */
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  reply: string | null;
  error: string | null;
  error_kind: string | null;
  http_status: number | null;
}

export interface KeyTestOptions {
  now?: () => number;
  timeoutMs?: number;
  /** The prompt is tiny on purpose; this is a connectivity check, not a benchmark. */
  prompt?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REPLY_CHARS = 120;
const MAX_ERROR_CHARS = 300;

/** Pick a free model when the provider says one is free, otherwise the first credible one. */
function pickModel(models: ModelInfo[]): ModelInfo | undefined {
  return (
    models.find((model) => model.is_free === true) ??
    models.find((model) => model.is_free !== false) ??
    models[0]
  );
}

/** A result for a provider this host has no adapter for. */
export function testKeyUnavailable(provider: string, reason: string): KeyTestResult {
  return {
    ok: false,
    provider,
    model: null,
    latency_ms: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    reply: null,
    error: reason,
    error_kind: 'unsupported',
    http_status: null,
  };
}

export async function testProviderKey(
  adapter: ProviderAdapter,
  secret: string,
  options: KeyTestOptions = {},
): Promise<KeyTestResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const provider = adapter.id;
  const credential = makeCredential(provider, `test-${now()}`, 'key test', secret);

  let models: ModelInfo[];
  try {
    models = await adapter.listModels(credential);
  } catch (error) {
    return failure(provider, null, 0, error, secret);
  }

  const model = pickModel(models);
  if (model === undefined) {
    return {
      ok: false,
      provider,
      model: null,
      latency_ms: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      reply: null,
      error: 'the provider returned no models',
      error_kind: 'model_gone',
      http_status: null,
    };
  }

  const startedAt = now();
  try {
    const response = await adapter.chat(
      {
        model: model.id,
        messages: [
          {
            role: 'user',
            content: options.prompt ?? 'Reply with the single word: ok',
          },
        ],
        max_tokens: 8,
        temperature: 0,
      },
      credential,
      AbortSignal.timeout(timeoutMs),
    );

    return {
      ok: true,
      provider,
      model: model.id,
      latency_ms: Math.max(0, now() - startedAt),
      prompt_tokens: response.usage.prompt_tokens,
      completion_tokens: response.usage.completion_tokens,
      reply: truncate(response.choices[0]?.message.content ?? null, MAX_REPLY_CHARS),
      error: null,
      error_kind: null,
      http_status: 200,
    };
  } catch (error) {
    return failure(provider, model.id, Math.max(0, now() - startedAt), error, secret);
  }
}

function failure(
  provider: string,
  model: string | null,
  latencyMs: number,
  error: unknown,
  secret: string,
): KeyTestResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    provider,
    model,
    latency_ms: latencyMs,
    prompt_tokens: 0,
    completion_tokens: 0,
    reply: null,
    error: truncate(message.replaceAll(secret, '[redacted]'), MAX_ERROR_CHARS),
    error_kind: error instanceof ProviderError ? error.kind : 'upstream',
    http_status: error instanceof ProviderError ? (error.status ?? null) : null,
  };
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

import { newRequestId } from '../core/ids';
import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  FinishReason,
  Usage,
} from '../core/types';
import type { Credential, ModelInfo, ProviderAdapter, ProviderId } from './types';
import { ProviderError, type ErrorKind } from '../core/errors';

/** The one OpenRouter endpoint. OpenAI-compatible. */
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Live OpenRouter ids are `400`s with this message, never `404`s. */
const INVALID_MODEL_ID_PATTERN = /is not a valid model ID/i;

interface OpenRouterChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string | null }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  response_format?: { type: 'text' | 'json_object' };
  stream?: boolean;
  user?: string;
}

interface OpenRouterChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      reasoning?: string | null;
      refusal?: string | null;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
    is_byok?: boolean;
    cost_details?: Record<string, number>;
  };
}

interface OpenRouterModelListResponse {
  data: Array<{
    id: string;
    name?: string;
    created?: number;
    context_length?: number | null;
    pricing?: Record<string, unknown>;
  }>;
}

interface OpenRouterErrorResponse {
  error?: {
    message?: string;
    /** OpenRouter sends a number here, unlike OpenAI's string codes. */
    code?: number | string;
  };
}

/** Coerces a live pricing value (string or number) to a number, or `null` if unparseable. */
function num(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    if (value.trim() === '') {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * OpenRouter's free rule: positive evidence only.
 *
 * `true` iff prompt and completion are exactly `0` and every other *numeric* pricing
 * field is `<= 0`; otherwise `null`. Never `false`: `"-1"` is a variable-pricing
 * sentinel meaning unknown, not free.
 */
function isFreePricing(pricing: Record<string, unknown> | undefined): boolean | null {
  if (!pricing) {
    return null;
  }

  if (num(pricing.prompt) !== 0 || num(pricing.completion) !== 0) {
    return null;
  }

  for (const [key, value] of Object.entries(pricing)) {
    if (key === 'prompt' || key === 'completion') {
      continue;
    }
    // Non-numeric fields (`overrides`, labels) are not prices: they neither prove nor deny.
    const price = num(value);
    if (price !== null && price > 0) {
      return null;
    }
  }

  return true;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** OpenRouter provider adapter (OpenAI-compatible). */
export class OpenRouterAdapter implements ProviderAdapter {
  readonly id: ProviderId = 'openrouter';
  readonly supportsStreaming = false;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private buildRequestBody(req: CanonicalRequest): OpenRouterChatCompletionRequest {
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    return {
      model: req.model ?? '',
      messages,
      temperature: req.temperature,
      top_p: req.top_p,
      max_tokens: req.max_tokens,
      stop: req.stop,
      response_format: req.response_format,
      stream: req.stream,
      user: req.user,
    };
  }

  private mapFinishReason(reason: string | null): FinishReason {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'error';
    }
  }

  private parseRetryAfterMs(headers?: Headers): number | undefined {
    const retryAfter = headers?.get('Retry-After');
    if (!retryAfter) {
      return undefined;
    }

    const seconds = Number.parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds)) {
      return Math.max(seconds, 0) * 1000;
    }

    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(date - Date.now(), 0);
    }

    return undefined;
  }

  private mapError(
    status: number,
    body: OpenRouterErrorResponse,
    headers?: Headers,
  ): ProviderError {
    const upstreamMessage = body.error?.message;
    let kind: ErrorKind;

    switch (status) {
      case 400:
        // Live OpenRouter reports unknown model ids as 400, not 404.
        kind =
          upstreamMessage !== undefined && INVALID_MODEL_ID_PATTERN.test(upstreamMessage)
            ? 'model_gone'
            : 'client';
        break;
      case 401:
      case 402:
        // 402 is per-credential funding state: retrying the same key never succeeds.
        kind = 'auth';
        break;
      case 404:
        kind = 'model_gone';
        break;
      case 429:
        kind = 'rate_limited';
        break;
      default:
        kind = 'upstream';
    }

    return new ProviderError(kind, upstreamMessage ?? `HTTP ${status}`, {
      status,
      provider: this.id,
      retryAfterMs: this.parseRetryAfterMs(headers),
    });
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (isAbortError(error)) {
        throw new ProviderError('timeout', 'Request aborted by caller', {
          provider: this.id,
          cause: error,
        });
      }
      throw error;
    }
  }

  async chat(
    req: CanonicalRequest,
    cred: Credential,
    signal?: AbortSignal,
  ): Promise<CanonicalResponse> {
    if (signal?.aborted) {
      throw new ProviderError('timeout', 'Request aborted by caller', {
        provider: this.id,
      });
    }

    const body = this.buildRequestBody(req);

    const response = await this.send(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cred.secret}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    let responseBody: OpenRouterChatCompletionResponse | OpenRouterErrorResponse;
    try {
      responseBody = (await response.json()) as
        OpenRouterChatCompletionResponse | OpenRouterErrorResponse;
    } catch {
      // Non-JSON body: classify by status, never leak the raw payload.
      throw this.mapError(response.status, {}, response.headers);
    }

    if (!response.ok) {
      throw this.mapError(
        response.status,
        responseBody as OpenRouterErrorResponse,
        response.headers,
      );
    }

    const data = responseBody as OpenRouterChatCompletionResponse;

    const choice = data.choices[0];
    if (!choice) {
      throw new ProviderError('upstream', 'No choices in response', {
        status: response.status,
        provider: this.id,
      });
    }

    const usage: Usage = data.usage
      ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
          estimated: false,
        }
      : {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          estimated: true,
        };

    return {
      id: newRequestId(),
      model: data.model,
      created: data.created ?? Math.floor(Date.now() / 1000),
      choices: [
        {
          index: choice.index,
          message: {
            role: choice.message.role as 'system' | 'user' | 'assistant',
            // Reasoning-only replies carry `content: null`; keep it null, never "".
            content: choice.message.content ?? null,
          },
          finish_reason: this.mapFinishReason(choice.finish_reason),
        },
      ],
      usage,
    };
  }

  async *stream(
    _req: CanonicalRequest,
    _cred: Credential,
    _signal?: AbortSignal,
  ): AsyncIterable<CanonicalChunk> {
    throw new ProviderError('unsupported', 'Streaming not supported by OpenRouter adapter', {
      provider: this.id,
    });
    // Unreachable yield to satisfy require-yield
    yield undefined as never;
  }

  async listModels(cred: Credential): Promise<ModelInfo[]> {
    const response = await this.send(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cred.secret}`,
      },
    });

    if (!response.ok) {
      let errorBody: OpenRouterErrorResponse;
      try {
        errorBody = (await response.json()) as OpenRouterErrorResponse;
      } catch {
        throw this.mapError(response.status, {}, response.headers);
      }
      throw this.mapError(response.status, errorBody, response.headers);
    }

    const data = (await response.json()) as OpenRouterModelListResponse;

    return data.data.map((model) => ({
      id: model.id,
      provider: this.id,
      context_window: model.context_length ?? null,
      is_free: isFreePricing(model.pricing),
    }));
  }
}

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

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

interface NvidiaChatCompletionRequest {
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

interface NvidiaChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      refusal?: string | null;
      reasoning_content?: string;
    };
    finish_reason: string | null;
    logprobs?: unknown;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens: number };
    completion_tokens_details?: { reasoning_tokens: number };
  };
}

interface NvidiaModelListResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }>;
}

interface NvidiaErrorResponse {
  status?: number;
  title?: string;
  detail?: string;
  message?: string;
  type?: string;
  code?: number | string;
  error?: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
}

/** NVIDIA NIM provider adapter (OpenAI-compatible). */
export class NvidiaNimAdapter implements ProviderAdapter {
  readonly id: ProviderId = 'nvidia';
  readonly supportsStreaming = false;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private buildRequestBody(req: CanonicalRequest): NvidiaChatCompletionRequest {
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

  private mapError(status: number, body: NvidiaErrorResponse, headers?: Headers): ProviderError {
    let kind: ErrorKind;
    let message: string;
    let retryAfterMs: number | undefined;

    // Extract Retry-After header if present
    if (headers) {
      const retryAfter = headers.get('Retry-After');
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds)) {
          retryAfterMs = seconds * 1000;
        }
      }
    }

    switch (status) {
      case 400:
        kind = 'client';
        message = body.error?.message ?? body.message ?? body.detail ?? 'Bad request';
        break;
      case 401:
        kind = 'auth';
        message = body.error?.message ?? body.detail ?? body.title ?? 'Unauthorized';
        break;
      case 404:
        kind = 'model_gone';
        message = body.error?.message ?? body.detail ?? 'Model not found';
        break;
      case 429:
        kind = 'rate_limited';
        message = body.error?.message ?? body.detail ?? 'Rate limited';
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        kind = 'upstream';
        message = body.error?.message ?? body.detail ?? 'Upstream error';
        break;
      default:
        kind = 'upstream';
        message = body.error?.message ?? body.detail ?? `HTTP ${status}`;
    }

    return new ProviderError(kind, message, {
      status,
      provider: this.id,
      retryAfterMs,
    });
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

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cred.secret}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    let responseBody: NvidiaChatCompletionResponse | NvidiaErrorResponse;
    try {
      responseBody = (await response.json()) as NvidiaChatCompletionResponse | NvidiaErrorResponse;
    } catch {
      // If JSON parsing fails, check if it's a 404 (plain text "404 page not found")
      if (response.status === 404) {
        throw this.mapError(404, {}, response.headers);
      }
      throw new ProviderError('upstream', 'Invalid JSON response from provider', {
        status: response.status,
        provider: this.id,
      });
    }

    if (!response.ok) {
      throw this.mapError(response.status, responseBody as NvidiaErrorResponse, response.headers);
    }

    const data = responseBody as NvidiaChatCompletionResponse;

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
            content: choice.message.content,
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
    throw new ProviderError('unsupported', 'Streaming not supported by NVIDIA NIM adapter', {
      provider: this.id,
    });
    // Unreachable yield to satisfy require-yield
    yield undefined as never;
  }

  async listModels(cred: Credential): Promise<ModelInfo[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cred.secret}`,
      },
    });

    if (!response.ok) {
      let errorBody: NvidiaErrorResponse;
      try {
        errorBody = (await response.json()) as NvidiaErrorResponse;
      } catch {
        throw new ProviderError('upstream', 'Failed to list models', {
          status: response.status,
          provider: this.id,
        });
      }
      throw this.mapError(response.status, errorBody, response.headers);
    }

    const data = (await response.json()) as NvidiaModelListResponse;

    return data.data.map((model) => ({
      id: model.id,
      provider: this.id,
      owned_by: model.owned_by,
      context_window: null,
      is_free: null,
    }));
  }
}

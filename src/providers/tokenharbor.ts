import { newRequestId } from '../core/ids';
import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  FinishReason,
  Usage,
} from '../core/types';
import type { Credential, ModelInfo, ProviderAdapter, ProviderId } from './types';
import { ProviderError } from '../core/errors';
import { ERROR_PROFILES, classifyStatus, parseErrorBody } from '../resilience/classify';

/** The one Token Harbor endpoint. OpenAI-compatible. */
const DEFAULT_BASE_URL = 'https://tokenharbor.ai/v1';

const FREE_SUFFIX = ':free';

interface TokenHarborChatCompletionRequest {
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

interface TokenHarborChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface TokenHarborModelListResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
    label?: string;
    blurb?: string;
    tier?: string;
    pricing?: Record<string, unknown>;
    context_length?: number | null;
    tool_call?: boolean;
  }>;
}

/** Token Harbor provider adapter (OpenAI-compatible). */
export class TokenHarborAdapter implements ProviderAdapter {
  readonly id: ProviderId = 'tokenharbor';
  readonly supportsStreaming = false;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private buildRequestBody(req: CanonicalRequest): TokenHarborChatCompletionRequest {
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

    const text = await response.text();
    const parsed = parseErrorBody(response.status, text);

    if (!response.ok) {
      throw classifyStatus(response.status, parsed, response.headers, {
        provider: this.id,
        profile: ERROR_PROFILES[this.id],
      });
    }

    let data: TokenHarborChatCompletionResponse;
    try {
      data = JSON.parse(text) as TokenHarborChatCompletionResponse;
    } catch {
      throw new ProviderError('upstream', 'Invalid JSON response from provider', {
        status: response.status,
        provider: this.id,
      });
    }

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
    throw new ProviderError('unsupported', 'Streaming not supported by Token Harbor adapter', {
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

    const text = await response.text();
    const parsed = parseErrorBody(response.status, text);

    if (!response.ok) {
      throw classifyStatus(response.status, parsed, response.headers, {
        provider: this.id,
        profile: ERROR_PROFILES[this.id],
      });
    }

    const data = JSON.parse(text) as TokenHarborModelListResponse;

    return data.data.map((model) => ({
      id: model.id,
      provider: this.id,
      owned_by: model.owned_by,
      context_window: model.context_length ?? null,
      is_free: model.id.endsWith(FREE_SUFFIX) ? true : null,
    }));
  }
}

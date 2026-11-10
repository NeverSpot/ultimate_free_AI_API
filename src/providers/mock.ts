import { newRequestId } from '../core/ids';
import type { CanonicalRequest, CanonicalResponse, FinishReason, Usage } from '../core/types';
import type { Credential, ModelInfo, ProviderAdapter, ProviderId } from './types';

export interface MockAdapterOptions {
  id?: ProviderId;
  model?: string;
  content?: string;
  finishReason?: FinishReason;
  usage?: Partial<Usage>;
  now?: () => number;
}

/**
 * Minimal deterministic adapter.
 *
 * Block 2 only needs a successful, canned completion so the HTTP layer can be tested
 * without a network. Block 1's remaining behavioural surface (RPM ceiling, latency,
 * injectable failures) is added on top of this class, not instead of it.
 */
export class MockProviderAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly supportsStreaming = false;

  private readonly model: string;
  private readonly content: string;
  private readonly finishReason: FinishReason;
  private readonly usage: Partial<Usage>;
  private readonly now: () => number;

  constructor(options: MockAdapterOptions = {}) {
    this.id = options.id ?? 'mock';
    this.model = options.model ?? 'mock-model';
    this.content = options.content ?? 'Hello from the mock adapter.';
    this.finishReason = options.finishReason ?? 'stop';
    this.usage = options.usage ?? {};
    this.now = options.now ?? Date.now;
  }

  async chat(
    req: CanonicalRequest,
    _cred: Credential,
    signal?: AbortSignal,
  ): Promise<CanonicalResponse> {
    if (signal?.aborted) {
      throw new Error('mock adapter aborted before completion');
    }

    const promptTokens = countTokens(req.messages.map((m) => m.content ?? '').join(' '));
    const completionTokens = countTokens(this.content);
    const usage: Usage = {
      prompt_tokens: this.usage.prompt_tokens ?? promptTokens,
      completion_tokens: this.usage.completion_tokens ?? completionTokens,
      total_tokens:
        this.usage.total_tokens ??
        (this.usage.prompt_tokens ?? promptTokens) +
          (this.usage.completion_tokens ?? completionTokens),
      estimated: this.usage.estimated ?? true,
    };

    return {
      id: newRequestId(),
      model: req.model ?? this.model,
      created: Math.floor(this.now() / 1000),
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: this.content },
          finish_reason: this.finishReason,
        },
      ],
      usage,
    };
  }

  async listModels(_cred: Credential): Promise<ModelInfo[]> {
    return [
      {
        id: this.model,
        provider: this.id,
        owned_by: this.id,
        context_window: null,
        is_free: true,
      },
    ];
  }
}

function countTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

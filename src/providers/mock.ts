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

export interface MockFailure {
  kind: ErrorKind;
  /** How many times this failure fires. Default 1. */
  times?: number;
  /** Optional predicate: inject only when true. */
  when?: (callIndex: number, cred: Credential) => boolean;
  /** Optional override for retryAfterMs on rate_limited. */
  retryAfterMs?: number;
  /** Optional HTTP status override. */
  status?: number;
}

export interface MockAdapterOptions {
  id?: ProviderId;
  model?: string;
  content?: string;
  finishReason?: FinishReason;
  usage?: Partial<Usage>;
  /** @deprecated Use `clock` instead. Kept for backwards compatibility with existing tests. */
  now?: () => number;
  /** Time source for window expiry. Defaults to Date.now. */
  clock?: () => number;
  /** Per-credential requests-per-minute ceiling. */
  rpmCeiling?: number;
  /** Window length in milliseconds. Default 60000. */
  windowMs?: number;
  /** Simulated latency per call in ms. */
  latencyMs?: number;
  /** Sleep implementation. Defaults to real setTimeout. Tests inject a recorder. */
  sleep?: (ms: number) => Promise<void>;
  /** Deterministic failure injection sequence. */
  failures?: MockFailure[];
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
  private readonly usageOverride: Partial<Usage>;
  private readonly clock: () => number;
  private readonly rpmCeiling: number | undefined;
  private readonly windowMs: number;
  private readonly latencyMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly failures: MockFailure[];

  /** Per-credential request timestamps for RPM tracking. */
  private readonly requestTimestamps: Map<string, number[]> = new Map();
  /** Call counter for deterministic failure injection. */
  private callCount = 0;
  /** Failure consumption state: index into failures array and per-failure fire count. */
  private failureIndex = 0;
  private failureFireCounts: number[] = [];

  constructor(options: MockAdapterOptions = {}) {
    this.id = options.id ?? 'mock';
    this.model = options.model ?? 'mock-model';
    this.content = options.content ?? 'Hello from the mock adapter.';
    this.finishReason = options.finishReason ?? 'stop';
    this.usageOverride = options.usage ?? {};
    // Backwards compatibility: `now` is kept, but `clock` takes precedence.
    this.clock = options.clock ?? options.now ?? Date.now;
    this.rpmCeiling = options.rpmCeiling;
    this.windowMs = options.windowMs ?? 60_000;
    this.latencyMs = options.latencyMs ?? 0;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.failures = options.failures ?? [];
  }

  /** Returns the number of chat calls made so far. */
  getCallCount(): number {
    return this.callCount;
  }

  /** Returns per-credential request counts in the current window (for testing/assertions). */
  getRequestCounts(): Map<string, number> {
    const now = this.clock();
    const windowStart = now - this.windowMs;
    const counts = new Map<string, number>();
    for (const [credId, timestamps] of this.requestTimestamps) {
      const recent = timestamps.filter((ts) => ts > windowStart);
      counts.set(credId, recent.length);
    }
    return counts;
  }

  async chat(
    req: CanonicalRequest,
    cred: Credential,
    signal?: AbortSignal,
  ): Promise<CanonicalResponse> {
    // Check abort signal first
    if (signal?.aborted) {
      throw new ProviderError('timeout', 'Request aborted by caller', {
        provider: this.id,
      });
    }

    // Handle latency
    if (this.latencyMs > 0) {
      await this.sleep(this.latencyMs);
      // Re-check abort after sleep
      if (signal?.aborted) {
        throw new ProviderError('timeout', 'Request aborted by caller', {
          provider: this.id,
        });
      }
    }

    // RPM ceiling check
    if (this.rpmCeiling !== undefined) {
      const now = this.clock();
      const windowStart = now - this.windowMs;
      const timestamps = this.requestTimestamps.get(cred.id) ?? [];
      const recent = timestamps.filter((ts) => ts > windowStart);

      if (recent.length >= this.rpmCeiling) {
        // Compute retryAfterMs from the oldest request in the window
        const oldest = recent[0];
        if (oldest === undefined) {
          throw new ProviderError('rate_limited', 'Rate limit exceeded', {
            provider: this.id,
            retryAfterMs: this.windowMs,
          });
        }
        const retryAfterMs = Math.max(1, oldest + this.windowMs - now);
        throw new ProviderError('rate_limited', 'Rate limit exceeded', {
          provider: this.id,
          retryAfterMs,
        });
      }

      // Record this request
      recent.push(now);
      this.requestTimestamps.set(cred.id, recent);
    }

    // Deterministic failure injection
    const currentCallIndex = this.callCount;
    this.callCount++;

    // Ensure failure tracking arrays are sized
    while (this.failureFireCounts.length < this.failures.length) {
      this.failureFireCounts.push(0);
    }

    // Check failures in order, consuming them deterministically
    for (let i = 0; i < this.failures.length; i++) {
      const failure = this.failures[i];
      if (!failure) continue;
      const fired = this.failureFireCounts[i] ?? 0;
      const maxTimes = failure.times ?? 1;

      if (fired < maxTimes) {
        const shouldFire = failure.when === undefined || failure.when(currentCallIndex, cred);
        if (shouldFire) {
          this.failureFireCounts[i] = fired + 1;
          throw new ProviderError(failure.kind, `Injected failure: ${failure.kind}`, {
            provider: this.id,
            retryAfterMs: failure.retryAfterMs,
            status: failure.status,
          });
        }
      }
    }

    const promptTokens = countTokens(req.messages.map((m) => m.content ?? '').join(' '));
    const completionTokens = countTokens(this.content);
    const usage: Usage = {
      prompt_tokens: this.usageOverride.prompt_tokens ?? promptTokens,
      completion_tokens: this.usageOverride.completion_tokens ?? completionTokens,
      total_tokens:
        this.usageOverride.total_tokens ??
        (this.usageOverride.prompt_tokens ?? promptTokens) +
          (this.usageOverride.completion_tokens ?? completionTokens),
      estimated: this.usageOverride.estimated ?? true,
    };

    return {
      id: newRequestId(),
      model: req.model ?? this.model,
      created: Math.floor(this.clock() / 1000),
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

  async *stream(
    _req: CanonicalRequest,
    _cred: Credential,
    _signal?: AbortSignal,
  ): AsyncIterable<CanonicalChunk> {
    throw new ProviderError('unsupported', 'streaming lands in Block 10', {
      provider: this.id,
    });
    // Unreachable yield to satisfy require-yield
    yield undefined as never;
  }
}

function countTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

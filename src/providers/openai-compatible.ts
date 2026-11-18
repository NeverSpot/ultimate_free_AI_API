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
import type { FreeModelRule } from './catalog';

/**
 * One adapter for every provider that speaks the OpenAI `/chat/completions` dialect.
 *
 * Most of the free-tier catalog is that dialect with a different host, so the
 * alternative was fifteen near-identical copies of this file. What genuinely
 * differs between providers is only *how free is expressed*, and that is the
 * `freeRule` argument: the mapping code stays shared, the evidence rule does not.
 */

export interface OpenAiCompatibleOptions {
  id: ProviderId;
  baseUrl: string;
  /** How `listModels` decides `is_free`. Defaults to "no signal" (`null`). */
  freeRule?: FreeModelRule;
  /** Provider-specific headers, e.g. an app name some providers require. */
  extraHeaders?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
  /**
   * Set when required configuration is missing (a Cloudflare account id, say).
   * Every call then fails with a clear auth error instead of a confusing 404.
   */
  unavailableReason?: string;
}

interface ChatCompletionResponse {
  id?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Every shape a `/models` response has been seen to take across these providers. */
interface ModelListResponse {
  data?: Array<{
    id?: string;
    name?: string;
    context_length?: number | null;
    context_window?: number | null;
    pricing?: Record<string, unknown>;
  }>;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Positive evidence only: `true` when pricing is exactly zero, else `null`. */
function isZeroPriced(pricing: Record<string, unknown> | undefined): boolean | null {
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
    const price = num(value);
    if (price !== null && price > 0) {
      return null;
    }
  }
  return true;
}

/**
 * Apply a provider's free rule to one catalog row.
 *
 * `null` means "no evidence", never "paid": reporting `false` would let the router
 * permanently skip a provider whose free allowance is real but unpublishable.
 */
export function isFreeByRule(
  rule: FreeModelRule,
  model: { id: string; pricing?: Record<string, unknown> },
): boolean | null {
  switch (rule.kind) {
    case 'all':
      return true;
    case 'suffix':
      return model.id.endsWith(rule.suffix) ? true : null;
    case 'id-includes':
      return model.id.toLowerCase().includes(rule.value) ? true : null;
    case 'id-prefix':
      return rule.prefixes.some((prefix) => model.id.toLowerCase().startsWith(prefix))
        ? true
        : null;
    case 'pricing-zero':
      return isZeroPriced(model.pricing);
    case 'unknown':
      return null;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
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

/** OpenAI-compatible adapter parameterised by provider id, host and free rule. */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly supportsStreaming = false;

  private readonly baseUrl: string;
  private readonly freeRule: FreeModelRule;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly unavailableReason: string | undefined;

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.freeRule = options.freeRule ?? { kind: 'unknown' };
    this.extraHeaders = options.extraHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.unavailableReason = options.unavailableReason;
  }

  private guard(): void {
    if (this.unavailableReason !== undefined) {
      throw new ProviderError('auth', this.unavailableReason, { provider: this.id });
    }
  }

  private headers(cred: Credential, withBody: boolean): Record<string, string> {
    return {
      ...(withBody ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${cred.secret}`,
      ...this.extraHeaders,
    };
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

  private fail(status: number, text: string, headers: Headers): never {
    const parsed = parseErrorBody(status, text);
    throw classifyStatus(status, parsed, headers, {
      provider: this.id,
      profile: ERROR_PROFILES[this.id],
    });
  }

  async chat(
    req: CanonicalRequest,
    cred: Credential,
    signal?: AbortSignal,
  ): Promise<CanonicalResponse> {
    this.guard();
    if (signal?.aborted) {
      throw new ProviderError('timeout', 'Request aborted by caller', { provider: this.id });
    }

    const body = {
      model: req.model ?? '',
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature,
      top_p: req.top_p,
      max_tokens: req.max_tokens,
      stop: req.stop,
      response_format: req.response_format,
      stream: false,
      user: req.user,
    };

    const response = await this.send(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(cred, true),
      body: JSON.stringify(body),
      signal,
    });

    const text = await response.text();
    if (!response.ok) {
      this.fail(response.status, text, response.headers);
    }

    let data: ChatCompletionResponse;
    try {
      data = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new ProviderError('upstream', 'Invalid JSON response from provider', {
        status: response.status,
        provider: this.id,
      });
    }

    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new ProviderError('upstream', 'No choices in response', {
        status: response.status,
        provider: this.id,
      });
    }

    const usage: Usage = data.usage
      ? {
          prompt_tokens: data.usage.prompt_tokens ?? 0,
          completion_tokens: data.usage.completion_tokens ?? 0,
          total_tokens:
            data.usage.total_tokens ??
            (data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0),
          estimated: false,
        }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated: true };

    return {
      id: newRequestId(),
      model: data.model ?? req.model ?? '',
      created: data.created ?? Math.floor(Date.now() / 1000),
      choices: [
        {
          index: choice.index ?? 0,
          message: {
            role: (choice.message.role as 'system' | 'user' | 'assistant') ?? 'assistant',
            content: choice.message.content ?? null,
          },
          finish_reason: mapFinishReason(choice.finish_reason),
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
    throw new ProviderError('unsupported', `Streaming not supported by the ${this.id} adapter`, {
      provider: this.id,
    });
    // Unreachable yield to satisfy require-yield.
    yield undefined as never;
  }

  async listModels(cred: Credential): Promise<ModelInfo[]> {
    this.guard();

    const response = await this.send(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: this.headers(cred, false),
    });

    const text = await response.text();
    if (!response.ok) {
      this.fail(response.status, text, response.headers);
    }

    let data: ModelListResponse;
    try {
      data = JSON.parse(text) as ModelListResponse;
    } catch {
      throw new ProviderError('upstream', 'Invalid JSON model list from provider', {
        status: response.status,
        provider: this.id,
      });
    }

    const rows = Array.isArray(data.data) ? data.data : [];
    const models: ModelInfo[] = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id === '') {
        continue;
      }
      models.push({
        id: row.id,
        provider: this.id,
        context_window: row.context_length ?? row.context_window ?? null,
        is_free: isFreeByRule(this.freeRule, { id: row.id, pricing: row.pricing }),
      });
    }
    return models;
  }
}

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

/**
 * Replicate adapter.
 *
 * Replicate does not speak `/chat/completions`: a call names a *model* and posts a
 * prediction whose `input` schema is the model's own. There is no chat template to
 * borrow, so this adapter joins the canonical messages into one `prompt` and sends
 * `system_prompt` separately, which is the shape the Llama/Mistral-family models
 * hosted there accept. Anything with a different input schema rejects the request
 * with a 422 — an honest failure, not a silent wrong answer.
 *
 * `Prefer: wait` makes the call synchronous. Without it Replicate answers 201 with a
 * queued prediction and the gateway would have to poll, which would burn the
 * request's whole timeout budget on one attempt.
 */

const DEFAULT_BASE_URL = 'https://api.replicate.com/v1';
const WAIT_SECONDS = 60;

interface Prediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: string | null;
  metrics?: { predict_time?: number };
}

interface ModelListResponse {
  results?: Array<{ owner?: string; name?: string; description?: string | null }>;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** Replicate returns a string, an array of tokens, or a URL depending on the model. */
function outputToText(output: unknown): string | null {
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    if (output.every((part) => typeof part === 'string')) {
      return output.join('');
    }
    // Some models answer with structured JSON per item: keep it, rather than drop it.
    return JSON.stringify(output);
  }
  if (output === null || output === undefined) {
    return null;
  }
  return JSON.stringify(output);
}

function estimateTokens(text: string): number {
  // Same rough ratio the rest of the gateway uses when usage is unavailable.
  return Math.max(1, Math.ceil(text.length / 4));
}

export class ReplicateAdapter implements ProviderAdapter {
  readonly id: ProviderId = 'replicate';
  readonly supportsStreaming = false;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
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

  private buildPrompt(req: CanonicalRequest): { prompt: string; systemPrompt?: string } {
    const system = req.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content ?? '')
      .join('\n\n')
      .trim();
    const prompt = req.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        const content = message.content ?? '';
        return message.role === 'assistant' ? `Assistant: ${content}` : content;
      })
      .join('\n\n');

    return system === '' ? { prompt } : { prompt, systemPrompt: system };
  }

  async chat(
    req: CanonicalRequest,
    cred: Credential,
    signal?: AbortSignal,
  ): Promise<CanonicalResponse> {
    if (signal?.aborted) {
      throw new ProviderError('timeout', 'Request aborted by caller', { provider: this.id });
    }
    const model = req.model ?? '';
    if (model === '') {
      throw new ProviderError('client', 'Replicate requires a model id (owner/name)', {
        provider: this.id,
      });
    }

    const { prompt, systemPrompt } = this.buildPrompt(req);
    const input: Record<string, unknown> = { prompt };
    if (systemPrompt !== undefined) input.system_prompt = systemPrompt;
    if (req.max_tokens !== undefined) input.max_tokens = req.max_tokens;
    if (req.temperature !== undefined) input.temperature = req.temperature;
    if (req.top_p !== undefined) input.top_p = req.top_p;

    const response = await this.send(`${this.baseUrl}/models/${model}/predictions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cred.secret}`,
        Prefer: `wait=${WAIT_SECONDS}`,
      },
      body: JSON.stringify({ input }),
      signal,
    });

    const text = await response.text();
    if (!response.ok) {
      this.fail(response.status, text, response.headers);
    }

    let data: Prediction;
    try {
      data = JSON.parse(text) as Prediction;
    } catch {
      throw new ProviderError('upstream', 'Invalid JSON response from Replicate', {
        status: response.status,
        provider: this.id,
      });
    }

    if (data.status !== undefined && data.status !== 'succeeded') {
      // `starting`/`processing` means the wait window expired; the prediction is still
      // running upstream but this request has nothing to return.
      throw new ProviderError(
        'timeout',
        `Replicate prediction ended with status "${data.status}"${data.error ? `: ${data.error}` : ''}`,
        { status: response.status, provider: this.id },
      );
    }

    const content = outputToText(data.output);
    if (content === null) {
      throw new ProviderError('upstream', 'Replicate returned no output', {
        status: response.status,
        provider: this.id,
      });
    }

    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(content);
    const usage: Usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      estimated: true,
    };

    const finishReason: FinishReason = 'stop';

    return {
      id: data.id ?? newRequestId(),
      model,
      created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
      usage,
    };
  }

  async *stream(
    _req: CanonicalRequest,
    _cred: Credential,
    _signal?: AbortSignal,
  ): AsyncIterable<CanonicalChunk> {
    throw new ProviderError('unsupported', 'Streaming not supported by the Replicate adapter', {
      provider: this.id,
    });
    // Unreachable yield to satisfy require-yield.
    yield undefined as never;
  }

  async listModels(cred: Credential): Promise<ModelInfo[]> {
    const response = await this.send(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cred.secret}` },
    });

    const text = await response.text();
    if (!response.ok) {
      this.fail(response.status, text, response.headers);
    }

    let data: ModelListResponse;
    try {
      data = JSON.parse(text) as ModelListResponse;
    } catch {
      throw new ProviderError('upstream', 'Invalid JSON model list from Replicate', {
        status: response.status,
        provider: this.id,
      });
    }

    const models: ModelInfo[] = [];
    for (const row of data.results ?? []) {
      if (typeof row.owner !== 'string' || typeof row.name !== 'string') {
        continue;
      }
      models.push({
        id: `${row.owner}/${row.name}`,
        provider: this.id,
        // Replicate bills per second of compute; every model is reachable on credit.
        is_free: true,
        context_window: null,
      });
    }
    return models;
  }
}

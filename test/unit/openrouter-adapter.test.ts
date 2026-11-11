import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { OpenRouterAdapter } from '../../src/providers/openrouter';
import type { Credential } from '../../src/providers/types';
import { ProviderError } from '../../src/core/errors';
import type { CanonicalRequest } from '../../src/core/types';

const NOW = 1_731_250_000_000;
const BASE_URL = 'https://openrouter.ai/api/v1';

function makeCredential(id = 'cred-1'): Credential {
  return { id, provider: 'openrouter', secret: 'test-secret-key' };
}

function makeReq(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

function makeChatResponse(
  overrides: Partial<{
    id: string;
    model: string;
    created: number;
    choices: Array<{
      index: number;
      message: { role: string; content: string | null; reasoning?: string | null };
      finish_reason: string | null;
    }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }> = {},
) {
  return {
    id: overrides.id ?? 'gen-123',
    object: 'chat.completion',
    created: overrides.created ?? Math.floor(NOW / 1000),
    model: overrides.model ?? 'deepseek/deepseek-v4.1-flash',
    choices: overrides.choices ?? [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello! How can I help?' },
        finish_reason: 'stop',
      },
    ],
    usage: overrides.usage ?? {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
  };
}

interface ModelFixture {
  id: string;
  context_length?: number;
  pricing?: Record<string, unknown>;
}

/** Mirrors the live `GET /models` shape: id, context_length, string pricing. */
function makeModelListResponse(models: Array<ModelFixture>) {
  return {
    data: models.map((m) => ({
      id: m.id,
      name: m.id,
      created: 1_731_250_000,
      context_length: m.context_length ?? 131_072,
      pricing: m.pricing ?? { prompt: '0', completion: '0' },
    })),
  };
}

describe('openrouter adapter', () => {
  let fetchMock: typeof fetch;
  let capturedRequests: Array<{ url: string; init: RequestInit }> = [];
  let adapter: OpenRouterAdapter;

  beforeEach(() => {
    capturedRequests = [];
    fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedRequests.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ error: { message: 'unmocked', code: 500 } }), {
        status: 500,
      });
    };
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });
  });

  test('openrouter adapter: successful chat maps to CanonicalResponse with estimated=false', async () => {
    const responseBody = makeChatResponse();
    fetchMock = async () => new Response(JSON.stringify(responseBody), { status: 200 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const result = await adapter.chat(makeReq(), makeCredential());

    assert.ok(result.id.startsWith('chatcmpl-'));
    assert.equal(result.model, 'deepseek/deepseek-v4.1-flash');
    assert.equal(typeof result.created, 'number');
    assert.equal(result.choices.length, 1);
    assert.ok(result.choices[0] !== undefined);
    const choice = result.choices[0]!;
    assert.equal(choice.index, 0);
    assert.equal(choice.message.role, 'assistant');
    assert.equal(choice.message.content, 'Hello! How can I help?');
    assert.equal(choice.finish_reason, 'stop');
    assert.equal(result.usage.prompt_tokens, 10);
    assert.equal(result.usage.completion_tokens, 20);
    assert.equal(result.usage.total_tokens, 30);
    assert.equal(result.usage.estimated, false);
  });

  test('openrouter adapter: forwards the canonical optional fields in the request body', async () => {
    const responseBody = makeChatResponse();
    fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedRequests.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(responseBody), { status: 200 });
    };
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    await adapter.chat(
      makeReq({ temperature: 0.2, top_p: 0.9, max_tokens: 64, stop: ['\n'], user: 'user-1' }),
      makeCredential(),
    );

    const sent = JSON.parse(capturedRequests[0]!.init.body as string) as Record<string, unknown>;
    assert.equal(sent.model, 'deepseek/deepseek-v4.1-flash');
    assert.equal(sent.temperature, 0.2);
    assert.equal(sent.top_p, 0.9);
    assert.equal(sent.max_tokens, 64);
    assert.deepEqual(sent.stop, ['\n']);
    assert.equal(sent.user, 'user-1');
    assert.deepEqual(sent.messages, [{ role: 'user', content: 'Hello' }]);
  });

  test('openrouter adapter: null content is tolerated for reasoning-only replies', async () => {
    const responseBody = makeChatResponse({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, reasoning: 'thinking…' },
          finish_reason: 'length',
        },
      ],
    });
    fetchMock = async () => new Response(JSON.stringify(responseBody), { status: 200 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const result = await adapter.chat(makeReq(), makeCredential());

    assert.equal(result.choices[0]!.message.content, null);
    assert.equal(result.choices[0]!.finish_reason, 'length');
    assert.equal(result.usage.estimated, false);
  });

  test('openrouter adapter: unknown finish_reason maps to error', async () => {
    const responseBody = makeChatResponse({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'partial' },
          finish_reason: 'tool_calls',
        },
      ],
    });
    fetchMock = async () => new Response(JSON.stringify(responseBody), { status: 200 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const result = await adapter.chat(makeReq(), makeCredential());

    assert.equal(result.choices[0]!.finish_reason, 'error');
  });

  test('openrouter adapter: 400 maps to client', async () => {
    const errorBody = {
      error: {
        message: 'Input required: specify "prompt" or "messages"',
        code: 400,
      },
    };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 400 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq({ messages: [] }), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'client');
      assert.equal(err.status, 400);
      assert.equal(err.provider, 'openrouter');
      assert.match(err.message, /Input required/);
    }
  });

  test('openrouter adapter: 400 with "is not a valid model ID" maps to model_gone', async () => {
    const errorBody = {
      error: {
        message: 'nope/not-a-model is not a valid model ID',
        code: 400,
      },
      user_id: 'user_123',
    };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 400 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq({ model: 'nope/not-a-model' }), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'model_gone');
      assert.equal(err.status, 400);
      assert.equal(err.provider, 'openrouter');
      assert.match(err.message, /is not a valid model ID/);
    }
  });

  test('openrouter adapter: 401 maps to auth', async () => {
    const errorBody = { error: { message: 'User not found.', code: 401 } };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 401 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 401);
      assert.equal(err.provider, 'openrouter');
      assert.match(err.message, /User not found/);
    }
  });

  test('openrouter adapter: 402 maps to auth', async () => {
    const errorBody = { error: { message: 'Insufficient credits.', code: 402 } };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 402 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 402);
      assert.equal(err.provider, 'openrouter');
    }
  });

  test('openrouter adapter: 404 maps to model_gone', async () => {
    const errorBody = { error: { message: 'No such model', code: 404 } };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 404 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq({ model: 'unknown/model' }), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'model_gone');
      assert.equal(err.status, 404);
      assert.equal(err.provider, 'openrouter');
    }
  });

  test('openrouter adapter: 429 maps to rate_limited with retryAfterMs from Retry-After', async () => {
    const errorBody = { error: { message: 'Rate limit exceeded', code: 429 } };
    fetchMock = async () =>
      new Response(JSON.stringify(errorBody), {
        status: 429,
        headers: { 'Retry-After': '30' },
      });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'rate_limited');
      assert.equal(err.status, 429);
      assert.equal(err.provider, 'openrouter');
      assert.equal(err.retryAfterMs, 30_000);
    }
  });

  test('openrouter adapter: 429 without Retry-After stays rate_limited with no retryAfterMs', async () => {
    const errorBody = { error: { message: 'Rate limit exceeded', code: 429 } };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 429 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'rate_limited');
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, undefined);
    }
  });

  test('openrouter adapter: 5xx maps to upstream', async () => {
    const errorBody = { error: { message: 'Provider is overloaded', code: 503 } };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 503 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'upstream');
      assert.equal(err.status, 503);
      assert.equal(err.provider, 'openrouter');
      assert.match(err.message, /Provider is overloaded/);
    }
  });

  test('openrouter adapter: aborted signal maps to timeout without calling fetch', async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await adapter.chat(makeReq(), makeCredential(), controller.signal);
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'timeout');
      assert.equal(err.provider, 'openrouter');
      assert.equal(capturedRequests.length, 0);
    }
  });

  test('openrouter adapter: AbortError from fetch maps to timeout', async () => {
    fetchMock = async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    };
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential(), new AbortController().signal);
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'timeout');
      assert.equal(err.provider, 'openrouter');
    }
  });

  test('openrouter adapter: stream() rejects with unsupported and yields nothing', async () => {
    try {
      for await (const _chunk of adapter.stream(makeReq(), makeCredential())) {
        assert.fail('Should not yield');
      }
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'unsupported');
      assert.equal(err.provider, 'openrouter');
      assert.match(err.message, /streaming not supported/i);
    }
    assert.equal(adapter.supportsStreaming, false);
  });

  test('openrouter adapter: listModels maps id, provider and context_window', async () => {
    const modelsData = makeModelListResponse([
      { id: 'deepseek/deepseek-v4.1-flash', context_length: 163_840 },
      { id: 'no-context/model' },
    ]);
    const responseBody = modelsData;
    // @ts-expect-error - deliberately omit context_length on the second entry
    delete responseBody.data[1].context_length;
    fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedRequests.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(responseBody), { status: 200 });
    };
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const models = await adapter.listModels(makeCredential());

    assert.equal(capturedRequests[0]!.url, `${BASE_URL}/models`);
    assert.equal(models.length, 2);
    assert.equal(models[0]!.id, 'deepseek/deepseek-v4.1-flash');
    assert.equal(models[0]!.provider, 'openrouter');
    assert.equal(models[0]!.context_window, 163_840);
    assert.equal(models[1]!.context_window, null);
  });

  test('openrouter adapter: listModels marks a "0"/"0" priced model free', async () => {
    const modelsData = makeModelListResponse([
      {
        id: 'deepseek/deepseek-r1:free',
        pricing: { prompt: '0', completion: '0', request: '0', image: '0', overrides: {} },
      },
    ]);
    fetchMock = async () => new Response(JSON.stringify(modelsData), { status: 200 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const models = await adapter.listModels(makeCredential());

    assert.equal(models.length, 1);
    assert.equal(models[0]!.is_free, true);
  });

  test('openrouter adapter: listModels marks a "-1" priced model unknown, never false', async () => {
    const modelsData = makeModelListResponse([
      { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
    ]);
    fetchMock = async () => new Response(JSON.stringify(modelsData), { status: 200 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const models = await adapter.listModels(makeCredential());

    assert.equal(models.length, 1);
    assert.equal(models[0]!.is_free, null);
    assert.notEqual(models[0]!.is_free, false);
  });

  test('openrouter adapter: listModels marks paid pricing unknown, never false', async () => {
    const modelsData = makeModelListResponse([
      {
        id: 'anthropic/claude-sonnet',
        pricing: { prompt: '0.000003', completion: '0.000015' },
      },
      // Half-zero: prompt > 0, completion "0" — correctly not free.
      {
        id: 'scaledown/summarize',
        pricing: { prompt: '0.0000001', completion: '0' },
      },
    ]);
    fetchMock = async () => new Response(JSON.stringify(modelsData), { status: 200 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const models = await adapter.listModels(makeCredential());

    assert.equal(models.length, 2);
    assert.equal(models[0]!.is_free, null);
    assert.notEqual(models[0]!.is_free, false);
    assert.equal(models[1]!.is_free, null);
    assert.notEqual(models[1]!.is_free, false);
  });

  test('openrouter adapter: outgoing request carries only the credential secret as Bearer auth', async () => {
    const responseBody = makeChatResponse();
    fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedRequests.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(responseBody), { status: 200 });
    };
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const cred = makeCredential('cred-test');
    await adapter.chat(makeReq(), cred);

    assert.equal(capturedRequests.length, 1);
    const request = capturedRequests[0]!;
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${cred.secret}`);
    assert.deepEqual(Object.keys(headers).sort(), ['Authorization', 'Content-Type']);
    assert.equal(request.url, `${BASE_URL}/chat/completions`);
    assert.ok(!request.url.includes(cred.secret));
  });

  test('openrouter adapter: default base URL is https://openrouter.ai/api/v1', async () => {
    const responseBody = makeChatResponse();
    fetchMock = async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedRequests.push({ url, init: {} });
      return new Response(JSON.stringify(responseBody), { status: 200 });
    };
    adapter = new OpenRouterAdapter({ fetchImpl: fetchMock });

    await adapter.chat(makeReq(), makeCredential());

    assert.equal(capturedRequests[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
  });

  test('openrouter adapter: listModels 401 maps to auth', async () => {
    const errorBody = { error: { message: 'No auth credentials found', code: 401 } };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 401 });
    adapter = new OpenRouterAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.listModels(makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 401);
      assert.equal(err.provider, 'openrouter');
    }
  });
});

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { NvidiaNimAdapter } from '../../src/providers/nvidia-nim';
import type { Credential } from '../../src/providers/types';
import { ProviderError } from '../../src/core/errors';
import type { CanonicalRequest } from '../../src/core/types';

const NOW = 1_731_250_000_000;
const BASE_URL = 'https://integrate.api.nvidia.com/v1';

function makeCredential(id = 'cred-1'): Credential {
  return { id, provider: 'nvidia', secret: 'test-secret-key' };
}

function makeReq(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'deepseek-ai/deepseek-v4.1-flash',
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
      message: { role: string; content: string | null };
      finish_reason: string | null;
    }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }> = {},
) {
  return {
    id: overrides.id ?? 'chatcmpl-123',
    object: 'chat.completion',
    created: overrides.created ?? Math.floor(NOW / 1000),
    model: overrides.model ?? 'deepseek-ai/deepseek-v4.1-flash',
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

function makeModelListResponse(models: Array<{ id: string; owned_by: string }> = []) {
  return {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created: 735790403,
      owned_by: m.owned_by,
    })),
  };
}

describe('nvidia adapter', () => {
  let fetchMock: typeof fetch;
  let capturedRequests: Array<{ url: string; init: RequestInit }> = [];
  let adapter: NvidiaNimAdapter;

  beforeEach(() => {
    capturedRequests = [];
    fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedRequests.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ error: 'unmocked' }), { status: 500 });
    };
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });
  });

  test('nvidia adapter: successful chat maps to CanonicalResponse with usage and estimated=false', async () => {
    const responseBody = makeChatResponse();
    fetchMock = async () => new Response(JSON.stringify(responseBody), { status: 200 });
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const result = await adapter.chat(makeReq(), makeCredential());

    assert.ok(result.id.startsWith('chatcmpl-'));
    assert.equal(result.model, 'deepseek-ai/deepseek-v4.1-flash');
    assert.equal(typeof result.created, 'number');
    assert.equal(result.choices.length, 1);
    assert.ok(result.choices[0] !== undefined);
    const choice = result.choices[0]!;
    assert.equal(choice.message.role, 'assistant');
    assert.equal(choice.message.content, 'Hello! How can I help?');
    assert.equal(choice.finish_reason, 'stop');
    assert.equal(result.usage.prompt_tokens, 10);
    assert.equal(result.usage.completion_tokens, 20);
    assert.equal(result.usage.total_tokens, 30);
    assert.equal(result.usage.estimated, false);
  });

  test('nvidia adapter: 429 maps to rate_limited and carries retryAfterMs when Retry-After header present', async () => {
    const errorBody = {
      error: {
        message: 'Rate limit exceeded',
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limit_exceeded',
      },
    };
    fetchMock = async () =>
      new Response(JSON.stringify(errorBody), {
        status: 429,
        headers: { 'Retry-After': '30' },
      });
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'rate_limited');
      assert.equal(err.retryAfterMs, 30_000);
    }
  });

  test('nvidia adapter: 401 maps to auth', async () => {
    const errorBody = { status: 401, title: 'Unauthorized', detail: 'Invalid JWT serialization' };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 401 });
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 401);
    }
  });

  test('nvidia adapter: 404 maps to model_gone', async () => {
    // NVIDIA returns plain text for 404
    fetchMock = async () => new Response('404 page not found', { status: 404 });
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq({ model: 'unknown/model' }), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'model_gone');
      assert.equal(err.status, 404);
    }
  });

  test('nvidia adapter: 400 maps to client', async () => {
    const errorBody = {
      message: 'Validation: messages cannot be empty',
      type: 'Bad Request',
      code: 400,
    };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 400 });
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq({ messages: [] }), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'client');
      assert.equal(err.status, 400);
    }
  });

  test('nvidia adapter: 500 maps to upstream', async () => {
    const errorBody = {
      error: {
        message: 'Internal server error',
        type: 'internal_error',
        param: null,
        code: 'internal',
      },
    };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 500 });
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'upstream');
      assert.equal(err.status, 500);
    }
  });

  test('nvidia adapter: listModels maps models with is_free === null (not false)', async () => {
    const modelsData = makeModelListResponse([
      { id: 'deepseek-ai/deepseek-v4.1-flash', owned_by: 'deepseek-ai' },
      { id: '01-ai/yi-large', owned_by: '01-ai' },
    ]);
    fetchMock = async () => new Response(JSON.stringify(modelsData), { status: 200 });
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const models = await adapter.listModels(makeCredential());

    assert.equal(models.length, 2);
    assert.ok(models[0] !== undefined);
    assert.ok(models[1] !== undefined);
    const model0 = models[0]!;
    const model1 = models[1]!;
    assert.equal(model0.id, 'deepseek-ai/deepseek-v4.1-flash');
    assert.equal(model0.provider, 'nvidia');
    assert.equal(model0.owned_by, 'deepseek-ai');
    assert.equal(model0.context_window, null);
    assert.equal(model0.is_free, null);
    assert.equal(model1.id, '01-ai/yi-large');
    assert.equal(model1.is_free, null);
    // Explicitly assert it is NOT false
    assert.notEqual(model0.is_free, false);
    assert.notEqual(model1.is_free, false);
  });

  test('nvidia adapter: aborted signal maps to timeout', async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await adapter.chat(makeReq(), makeCredential(), controller.signal);
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'timeout');
    }
  });

  test('nvidia adapter: stream() rejects with unsupported', async () => {
    try {
      for await (const _chunk of adapter.stream(makeReq(), makeCredential())) {
        assert.fail('Should not yield');
      }
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'unsupported');
      assert.match(err.message, /streaming not supported/i);
    }
  });

  test('nvidia adapter: passes credential secret as Bearer token in Authorization header', async () => {
    const responseBody = makeChatResponse();
    fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedRequests.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(responseBody), { status: 200 });
    };
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const cred = makeCredential('cred-test');
    await adapter.chat(makeReq(), cred);

    assert.equal(capturedRequests.length, 1);
    assert.ok(capturedRequests[0] !== undefined);
    const req = capturedRequests[0]!;
    const authHeader = req.init.headers as Record<string, string>;
    assert.equal(authHeader.Authorization, `Bearer ${cred.secret}`);
  });

  test('nvidia adapter: missing usage in response yields estimated=true', async () => {
    const responseBody = makeChatResponse();
    // @ts-expect-error - deliberately omit usage field to test missing usage handling
    delete responseBody.usage;
    fetchMock = async () => new Response(JSON.stringify(responseBody), { status: 200 });
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const result = await adapter.chat(makeReq(), makeCredential());

    assert.equal(result.usage.estimated, true);
    assert.equal(result.usage.prompt_tokens, 0);
    assert.equal(result.usage.completion_tokens, 0);
    assert.equal(result.usage.total_tokens, 0);
  });

  test('nvidia adapter: non-JSON error response handled gracefully', async () => {
    fetchMock = async () => new Response('Internal Server Error', { status: 500 });
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'upstream');
    }
  });

  test('nvidia adapter: listModels 401 maps to auth', async () => {
    const errorBody = { status: 401, title: 'Unauthorized', detail: 'Invalid key' };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 401 });
    adapter = new NvidiaNimAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.listModels(makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'auth');
    }
  });

  test('nvidia adapter: custom baseUrl is used', async () => {
    const customUrl = 'https://custom.example.com/v1';
    const responseBody = makeChatResponse();
    fetchMock = async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      assert.equal(url, `${customUrl}/chat/completions`);
      return new Response(JSON.stringify(responseBody), { status: 200 });
    };
    adapter = new NvidiaNimAdapter({ baseUrl: customUrl, fetchImpl: fetchMock });

    await adapter.chat(makeReq(), makeCredential());
  });
});

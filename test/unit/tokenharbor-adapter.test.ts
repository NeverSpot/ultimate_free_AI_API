import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { TokenHarborAdapter } from '../../src/providers/tokenharbor';
import type { Credential } from '../../src/providers/types';
import { ProviderError } from '../../src/core/errors';
import type { CanonicalRequest } from '../../src/core/types';

const NOW = 1_731_250_000_000;
const BASE_URL = 'https://tokenharbor.ai/v1';

function makeCredential(id = 'cred-1'): Credential {
  return { id, provider: 'tokenharbor', secret: 'test-secret-key' };
}

function makeReq(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'deepseek-v4.1-flash',
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
    model: overrides.model ?? 'deepseek-v4.1-flash',
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
  owned_by: string;
  context_length?: number;
}

/** Mirrors the live `GET /models` shape: label/blurb/tier/pricing/context_length/tool_call. */
function makeModelListResponse(models: Array<ModelFixture>) {
  return {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created: 735790403,
      owned_by: m.owned_by,
      label: m.id,
      blurb: 'A model served by Token Harbor.',
      tier: m.id.endsWith(':free') ? 'free' : 'standard',
      pricing: { prompt: '0', completion: '0' },
      context_length: m.context_length ?? 131_072,
      tool_call: true,
    })),
  };
}

function make82StyleModels(): ModelFixture[] {
  const models: ModelFixture[] = [
    { id: 'deepseek-v4.1-flash', owned_by: 'deepseek', context_length: 163_840 },
    { id: 'qwen3-coder:free', owned_by: 'qwen', context_length: 262_144 },
  ];
  for (let i = models.length; i < 82; i++) {
    models.push({ id: `model-${i}`, owned_by: 'tokenharbor', context_length: 32_768 });
  }
  return models;
}

describe('tokenharbor adapter', () => {
  let fetchMock: typeof fetch;
  let capturedRequests: Array<{ url: string; init: RequestInit }> = [];
  let adapter: TokenHarborAdapter;

  beforeEach(() => {
    capturedRequests = [];
    fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedRequests.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ error: { message: 'unmocked' } }), { status: 500 });
    };
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });
  });

  test('tokenharbor adapter: successful chat maps to CanonicalResponse', async () => {
    const responseBody = makeChatResponse();
    fetchMock = async () => new Response(JSON.stringify(responseBody), { status: 200 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const result = await adapter.chat(makeReq(), makeCredential());

    assert.ok(result.id.startsWith('chatcmpl-'));
    assert.equal(result.model, 'deepseek-v4.1-flash');
    assert.equal(typeof result.created, 'number');
    assert.equal(result.choices.length, 1);
    assert.ok(result.choices[0] !== undefined);
    const choice = result.choices[0]!;
    assert.equal(choice.index, 0);
    assert.equal(choice.message.role, 'assistant');
    assert.equal(choice.message.content, 'Hello! How can I help?');
    assert.equal(choice.finish_reason, 'stop');
  });

  test('tokenharbor adapter: provider usage is mapped with estimated=false', async () => {
    const responseBody = makeChatResponse();
    fetchMock = async () => new Response(JSON.stringify(responseBody), { status: 200 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const result = await adapter.chat(makeReq(), makeCredential());

    assert.equal(result.usage.prompt_tokens, 10);
    assert.equal(result.usage.completion_tokens, 20);
    assert.equal(result.usage.total_tokens, 30);
    assert.equal(result.usage.estimated, false);
  });

  test('tokenharbor adapter: missing usage in response yields estimated=true', async () => {
    const responseBody = makeChatResponse();
    // @ts-expect-error - deliberately omit usage field to test missing usage handling
    delete responseBody.usage;
    fetchMock = async () => new Response(JSON.stringify(responseBody), { status: 200 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const result = await adapter.chat(makeReq(), makeCredential());

    assert.equal(result.usage.estimated, true);
    assert.equal(result.usage.prompt_tokens, 0);
    assert.equal(result.usage.completion_tokens, 0);
    assert.equal(result.usage.total_tokens, 0);
  });

  test('tokenharbor adapter: passes credential secret as Bearer token in Authorization header', async () => {
    const responseBody = makeChatResponse();
    fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedRequests.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(responseBody), { status: 200 });
    };
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const cred = makeCredential('cred-test');
    await adapter.chat(makeReq(), cred);

    assert.equal(capturedRequests.length, 1);
    assert.ok(capturedRequests[0] !== undefined);
    const req = capturedRequests[0]!;
    const authHeader = req.init.headers as Record<string, string>;
    assert.equal(authHeader.Authorization, `Bearer ${cred.secret}`);
  });

  test('tokenharbor adapter: 400 maps to client', async () => {
    const errorBody = {
      error: {
        message: 'messages is required and must be a non-empty array.',
        type: 'invalid_request_error',
        code: 'invalid_request_error',
      },
    };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 400 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq({ messages: [] }), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'client');
      assert.equal(err.status, 400);
      assert.match(err.message, /messages is required/);
    }
  });

  test('tokenharbor adapter: 401 maps to auth', async () => {
    const errorBody = {
      error: {
        message: 'No valid API key found. Please check your key and try again.',
        type: 'invalid_api_key',
        code: 'invalid_api_key',
      },
    };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 401 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 401);
      assert.match(err.message, /No valid API key/);
    }
  });

  test('tokenharbor adapter: 403 maps to auth', async () => {
    const errorBody = { error: { message: 'Forbidden', type: 'permission_error' } };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 403 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 403);
    }
  });

  test('tokenharbor adapter: 404 maps to model_gone', async () => {
    const errorBody = {
      error: {
        message: "Model 'unknown-model' is not available on this endpoint.",
        type: 'model_not_found',
        code: 'model_not_found',
      },
    };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 404 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq({ model: 'unknown-model' }), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'model_gone');
      assert.equal(err.status, 404);
      assert.match(err.message, /not available/);
    }
  });

  test('tokenharbor adapter: 429 maps to rate_limited with retryAfterMs from Retry-After', async () => {
    const errorBody = { error: { type: 'free_tier_limit_reached' } };
    fetchMock = async () =>
      new Response(JSON.stringify(errorBody), {
        status: 429,
        headers: { 'Retry-After': '3600' },
      });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq({ model: 'deepseek-v4.1-flash:free' }), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'rate_limited');
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 3_600_000);
    }
  });

  test('tokenharbor adapter: 5xx maps to upstream', async () => {
    const errorBody = { error: { message: 'Upstream capacity exhausted', type: 'server_error' } };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 503 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'upstream');
      assert.equal(err.status, 503);
      assert.match(err.message, /Upstream capacity exhausted/);
    }
  });

  test('tokenharbor adapter: non-JSON error body maps to upstream with the status line', async () => {
    fetchMock = async () => new Response('Internal Server Error', { status: 500 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.chat(makeReq(), makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'upstream');
      assert.equal(err.status, 500);
      assert.equal(err.message, 'HTTP 500');
    }
  });

  test('tokenharbor adapter: aborted signal maps to timeout without calling fetch', async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await adapter.chat(makeReq(), makeCredential(), controller.signal);
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'timeout');
      assert.equal(capturedRequests.length, 0);
    }
  });

  test('tokenharbor adapter: stream() rejects with unsupported', async () => {
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

  test('tokenharbor adapter: listModels maps the 82-model payload', async () => {
    const modelsData = makeModelListResponse(make82StyleModels());
    fetchMock = async () => new Response(JSON.stringify(modelsData), { status: 200 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const models = await adapter.listModels(makeCredential());

    assert.equal(models.length, 82);
    assert.ok(models[0] !== undefined);
    const model0 = models[0]!;
    assert.equal(model0.id, 'deepseek-v4.1-flash');
    assert.equal(model0.provider, 'tokenharbor');
    assert.equal(model0.owned_by, 'deepseek');
    assert.equal(model0.context_window, 163_840);
    assert.equal(models[81]?.id, 'model-81');
  });

  test('tokenharbor adapter: listModels marks a :free id as is_free true', async () => {
    const modelsData = makeModelListResponse([
      { id: 'qwen3-coder:free', owned_by: 'qwen' },
      { id: 'deepseek-v4.1-flash:free', owned_by: 'deepseek' },
    ]);
    fetchMock = async () => new Response(JSON.stringify(modelsData), { status: 200 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const models = await adapter.listModels(makeCredential());

    assert.equal(models.length, 2);
    assert.ok(models[0] !== undefined);
    assert.ok(models[1] !== undefined);
    assert.equal(models[0]!.id, 'qwen3-coder:free');
    assert.equal(models[0]!.is_free, true);
    assert.equal(models[1]!.is_free, true);
  });

  test('tokenharbor adapter: listModels marks a non-suffixed id as is_free null, never false', async () => {
    const modelsData = makeModelListResponse([
      { id: 'deepseek-v4.1-flash', owned_by: 'deepseek' },
      { id: 'freeform-model', owned_by: 'tokenharbor' },
    ]);
    fetchMock = async () => new Response(JSON.stringify(modelsData), { status: 200 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    const models = await adapter.listModels(makeCredential());

    assert.equal(models.length, 2);
    assert.ok(models[0] !== undefined);
    assert.ok(models[1] !== undefined);
    assert.equal(models[0]!.is_free, null);
    assert.equal(models[1]!.is_free, null);
    assert.notEqual(models[0]!.is_free, false);
    assert.notEqual(models[1]!.is_free, false);
  });

  test('tokenharbor adapter: listModels 401 maps to auth', async () => {
    const errorBody = {
      error: {
        message: 'No valid API key found.',
        type: 'invalid_api_key',
        code: 'invalid_api_key',
      },
    };
    fetchMock = async () => new Response(JSON.stringify(errorBody), { status: 401 });
    adapter = new TokenHarborAdapter({ baseUrl: BASE_URL, fetchImpl: fetchMock });

    try {
      await adapter.listModels(makeCredential());
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 401);
    }
  });

  test('tokenharbor adapter: custom baseUrl is used', async () => {
    const customUrl = 'https://custom.example.com/v1';
    const responseBody = makeChatResponse();
    fetchMock = async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      assert.equal(url, `${customUrl}/chat/completions`);
      return new Response(JSON.stringify(responseBody), { status: 200 });
    };
    adapter = new TokenHarborAdapter({ baseUrl: customUrl, fetchImpl: fetchMock });

    await adapter.chat(makeReq(), makeCredential());
  });
});

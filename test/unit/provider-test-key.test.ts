import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../src/core/errors';
import type { CanonicalChunk, CanonicalRequest, CanonicalResponse } from '../../src/core/types';
import type { Credential, ModelInfo, ProviderAdapter } from '../../src/providers/types';
import { testKeyUnavailable, testProviderKey } from '../../src/providers/test-key';

/**
 * The key test is the only place the gateway spends a user's provider quota just
 * to answer "does this key work?". It must choose a free model, keep the call
 * tiny, and never echo the secret back in an error string.
 */

interface FakeAdapterOptions {
  models?: ModelInfo[];
  listModelsError?: unknown;
  chatError?: unknown;
  onChat?: (req: CanonicalRequest, cred: Credential) => void;
}

function fakeAdapter(options: FakeAdapterOptions = {}): ProviderAdapter {
  return {
    id: 'openrouter',
    supportsStreaming: true,
    async listModels() {
      if (options.listModelsError !== undefined) throw options.listModelsError;
      return (
        options.models ?? [
          { id: 'paid/model', is_free: false },
          { id: 'free/model', is_free: true },
        ]
      );
    },
    async chat(req, cred): Promise<CanonicalResponse> {
      options.onChat?.(req, cred);
      if (options.chatError !== undefined) throw options.chatError;
      return {
        id: 'chatcmpl-test',
        model: req.model ?? 'free/model',
        created: 1_700_000_000,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
      };
    },
    stream(): AsyncIterable<CanonicalChunk> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true as const, value: undefined }),
        }),
      };
    },
  };
}

test('key test: uses a free model and times only the chat call', async () => {
  let clock = 1_000;
  let seen:
    { model: string | undefined; secret: string; maxTokens: number | undefined } | undefined;

  const result = await testProviderKey(
    fakeAdapter({
      onChat: (req, cred) => {
        clock = 1_042;
        seen = { model: req.model, secret: cred.secret, maxTokens: req.max_tokens };
      },
    }),
    'sk-or-secret',
    { now: () => clock },
  );

  assert.equal(result.ok, true);
  assert.equal(result.model, 'free/model', 'a free model must win over the first listed model');
  assert.equal(result.latency_ms, 42);
  assert.deepEqual(
    { prompt: result.prompt_tokens, completion: result.completion_tokens, reply: result.reply },
    { prompt: 9, completion: 1, reply: 'ok' },
  );
  assert.ok(seen);
  assert.equal(seen.model, 'free/model');
  assert.equal(seen.secret, 'sk-or-secret', 'the stored secret must reach the adapter unchanged');
  assert.equal(seen.maxTokens, 8, 'the probe must stay cheap');
});

test('key test: redacts the secret from an upstream error', async () => {
  const error = new ProviderError('auth', 'invalid key sk-or-secret-123 rejected', {
    status: 401,
    provider: 'openrouter',
  });

  const result = await testProviderKey(fakeAdapter({ chatError: error }), 'sk-or-secret-123', {
    now: () => 1_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_kind, 'auth');
  assert.equal(result.http_status, 401);
  assert.equal(result.error?.includes('sk-or-secret-123'), false);
  assert.match(result.error ?? '', /\[redacted\]/);
});

test('key test: model discovery failure is reported without a chat attempt', async () => {
  let chatted = false;
  const result = await testProviderKey(
    fakeAdapter({
      listModelsError: new ProviderError('rate_limited', 'slow down', { status: 429 }),
      onChat: () => {
        chatted = true;
      },
    }),
    'sk-or-secret',
    { now: () => 1_000 },
  );

  assert.equal(result.ok, false);
  assert.equal(result.model, null);
  assert.equal(result.latency_ms, 0);
  assert.equal(result.error_kind, 'rate_limited');
  assert.equal(chatted, false, 'a provider that cannot list models must not be chatted at');
});

test('key test: an empty model list is a model_gone failure', async () => {
  const result = await testProviderKey(fakeAdapter({ models: [] }), 'sk-or-secret', {
    now: () => 1_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.model, null);
  assert.equal(result.error_kind, 'model_gone');
});

test('key test: unavailable providers answer unsupported, not a fake pass', () => {
  const result = testKeyUnavailable('hyperbolic', 'no adapter on this host');

  assert.equal(result.ok, false);
  assert.equal(result.provider, 'hyperbolic');
  assert.equal(result.error_kind, 'unsupported');
  assert.equal(result.error, 'no adapter on this host');
  assert.equal(result.http_status, null);
});

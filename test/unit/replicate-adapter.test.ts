import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplicateAdapter } from '../../src/providers/replicate';
import type { Credential } from '../../src/providers/types';
import type { CanonicalRequest } from '../../src/core/types';
import { ProviderError } from '../../src/core/errors';

const BASE_URL = 'https://api.replicate.com/v1';
const cred: Credential = { id: 'cred-1', provider: 'replicate', secret: 'r8-secret' };

function makeReq(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'meta/meta-llama-3-70b-instruct',
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Hello' },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('replicate: chat posts a prediction with a synchronous wait', async () => {
  let seenUrl = '';
  let seenHeaders: Record<string, string> | undefined;
  let seenBody: unknown;

  const adapter = new ReplicateAdapter({
    baseUrl: BASE_URL,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = init?.headers as Record<string, string>;
      seenBody = JSON.parse(String(init?.body)) as unknown;
      return jsonResponse({
        id: 'pred-1',
        status: 'succeeded',
        output: ['Hel', 'lo'],
      });
    }) as typeof fetch,
  });

  const result = await adapter.chat(makeReq(), cred);

  assert.equal(seenUrl, `${BASE_URL}/models/meta/meta-llama-3-70b-instruct/predictions`);
  assert.equal(seenHeaders?.Authorization, 'Bearer r8-secret');
  assert.equal(seenHeaders?.Prefer, 'wait=60');
  assert.deepEqual((seenBody as { input: unknown }).input, {
    prompt: 'Hello',
    system_prompt: 'Be terse.',
  });
  assert.equal(result.choices[0]?.message.content, 'Hello');
  assert.equal(result.choices[0]?.finish_reason, 'stop');
  assert.equal(result.usage.estimated, true);
});

test('replicate: a prediction that did not finish is a timeout, not an answer', async () => {
  const adapter = new ReplicateAdapter({
    baseUrl: BASE_URL,
    fetchImpl: (async () =>
      jsonResponse({ id: 'pred-2', status: 'processing', output: null })) as typeof fetch,
  });

  await assert.rejects(
    () => adapter.chat(makeReq(), cred),
    (error: unknown) => error instanceof ProviderError && error.kind === 'timeout',
  );
});

test('replicate: a 402 is an exhausted credential', async () => {
  const adapter = new ReplicateAdapter({
    baseUrl: BASE_URL,
    fetchImpl: (async () => jsonResponse({ detail: 'Insufficient credit' }, 402)) as typeof fetch,
  });

  await assert.rejects(
    () => adapter.chat(makeReq(), cred),
    (error: unknown) => error instanceof ProviderError && error.kind === 'auth',
  );
});

test('replicate: listModels returns owner/name ids', async () => {
  const adapter = new ReplicateAdapter({
    baseUrl: BASE_URL,
    fetchImpl: (async () =>
      jsonResponse({
        results: [
          { owner: 'meta', name: 'meta-llama-3-70b-instruct' },
          { owner: 'mistralai', name: 'mixtral-8x7b-instruct-v0.1' },
          { owner: 'missing-name' },
        ],
      })) as typeof fetch,
  });

  const models = await adapter.listModels(cred);

  assert.deepEqual(
    models.map((model) => model.id),
    ['meta/meta-llama-3-70b-instruct', 'mistralai/mixtral-8x7b-instruct-v0.1'],
  );
  assert.equal(models[0]?.provider, 'replicate');
  assert.equal(models[0]?.is_free, true);
});

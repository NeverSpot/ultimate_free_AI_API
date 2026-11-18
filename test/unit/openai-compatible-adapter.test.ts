import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAiCompatibleAdapter, isFreeByRule } from '../../src/providers/openai-compatible';
import type { Credential } from '../../src/providers/types';
import type { CanonicalRequest } from '../../src/core/types';
import { ProviderError } from '../../src/core/errors';

const BASE_URL = 'https://api.groq.com/openai/v1';
const cred: Credential = { id: 'cred-1', provider: 'groq', secret: 'secret-value' };

function makeReq(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return { model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'Hello' }], ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('openai-compatible: chat maps the canonical request onto /chat/completions', async () => {
  let seenUrl = '';
  let seenHeaders: Record<string, string> | undefined;
  let seenBody: unknown;

  const adapter = new OpenAiCompatibleAdapter({
    id: 'groq',
    baseUrl: BASE_URL,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = init?.headers as Record<string, string>;
      seenBody = JSON.parse(String(init?.body)) as unknown;
      return jsonResponse({
        id: 'chatcmpl-1',
        model: 'llama-3.3-70b',
        created: 1_731_250_000,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    }) as typeof fetch,
  });

  const result = await adapter.chat(makeReq(), cred);

  assert.equal(seenUrl, `${BASE_URL}/chat/completions`);
  assert.equal((seenHeaders as Record<string, string>).Authorization, 'Bearer secret-value');
  assert.deepEqual((seenBody as { messages: unknown }).messages, [
    { role: 'user', content: 'Hello' },
  ]);
  assert.equal(result.choices[0]?.message.content, 'Hi');
  assert.equal(result.choices[0]?.finish_reason, 'stop');
  assert.equal(result.usage.total_tokens, 6);
  assert.equal(result.usage.estimated, false);
});

test('openai-compatible: a 401 is an auth failure, not a caller error', async () => {
  const adapter = new OpenAiCompatibleAdapter({
    id: 'groq',
    baseUrl: BASE_URL,
    fetchImpl: (async () =>
      jsonResponse(
        { error: { message: 'Invalid API Key', code: 'invalid_api_key' } },
        401,
      )) as typeof fetch,
  });

  await assert.rejects(
    () => adapter.chat(makeReq(), cred),
    (error: unknown) => error instanceof ProviderError && error.kind === 'auth',
  );
});

test('openai-compatible: a 402 on a credit provider fails the credential over', async () => {
  const adapter = new OpenAiCompatibleAdapter({
    id: 'together',
    baseUrl: 'https://api.together.xyz/v1',
    fetchImpl: (async () =>
      jsonResponse({ error: { message: 'credit balance is zero' } }, 402)) as typeof fetch,
  });

  await assert.rejects(
    () => adapter.chat(makeReq(), cred),
    (error: unknown) => error instanceof ProviderError && error.kind === 'auth',
  );
});

test('openai-compatible: missing configuration fails loudly instead of calling upstream', async () => {
  let called = false;
  const adapter = new OpenAiCompatibleAdapter({
    id: 'cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts//ai/v1',
    unavailableReason: 'CLOUDFLARE_ACCOUNT_ID is not set',
    fetchImpl: (async () => {
      called = true;
      return jsonResponse({});
    }) as typeof fetch,
  });

  await assert.rejects(
    () => adapter.listModels(cred),
    (error: unknown) => error instanceof ProviderError && error.kind === 'auth',
  );
  assert.equal(called, false);
});

test('openai-compatible: listModels applies the provider free rule', async () => {
  const models = [
    { id: 'glm-4.7-flash', context_length: 200_000 },
    { id: 'glm-4.6', context_length: 200_000 },
    { id: 'glm-4.5-flash', context_length: 128_000 },
  ];

  const adapter = new OpenAiCompatibleAdapter({
    id: 'zai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    freeRule: { kind: 'id-includes', value: 'flash' },
    fetchImpl: (async () => jsonResponse({ data: models })) as typeof fetch,
  });

  const listed = await adapter.listModels(cred);

  assert.deepEqual(
    listed.map((model) => [model.id, model.is_free]),
    [
      ['glm-4.7-flash', true],
      ['glm-4.6', null],
      ['glm-4.5-flash', true],
    ],
  );
  assert.equal(listed[0]?.provider, 'zai');
  assert.equal(listed[0]?.context_window, 200_000);
});

test('free-rule: unknown reports no evidence rather than "paid"', () => {
  assert.equal(isFreeByRule({ kind: 'unknown' }, { id: 'anything' }), null);
  assert.equal(isFreeByRule({ kind: 'all' }, { id: 'anything' }), true);
  assert.equal(isFreeByRule({ kind: 'suffix', suffix: ':free' }, { id: 'x:free' }), true);
  assert.equal(isFreeByRule({ kind: 'suffix', suffix: ':free' }, { id: 'x' }), null);
  assert.equal(
    isFreeByRule({ kind: 'id-prefix', prefixes: ['gemini-2.5-flash'] }, { id: 'gemini-2.5-pro' }),
    null,
  );
  assert.equal(
    isFreeByRule({ kind: 'pricing-zero' }, { id: 'a', pricing: { prompt: '0', completion: '0' } }),
    true,
  );
  assert.equal(
    isFreeByRule(
      { kind: 'pricing-zero' },
      { id: 'a', pricing: { prompt: '0.5', completion: '0' } },
    ),
    null,
  );
});

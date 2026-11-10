import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../src/core/errors';
import type { CanonicalChunk, CanonicalRequest, CanonicalResponse } from '../../src/core/types';
import { loadCredentialPool } from '../../src/credentials/pool';
import type { CredentialPool } from '../../src/credentials/pool';
import type { Credential, ModelInfo, ProviderAdapter, ProviderId } from '../../src/providers/types';
import {
  formatSummary,
  formatTable,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  runSmoke,
} from '../../scripts/smoke';
import type { SmokeRow } from '../../scripts/smoke';

function model(id: string, isFree: boolean | null = null): ModelInfo {
  return { id, is_free: isFree };
}

function makePool(
  providers: ProviderId[] = ['nvidia', 'openrouter', 'tokenharbor'],
): CredentialPool {
  const raw: NodeJS.ProcessEnv = {};
  if (providers.includes('nvidia')) {
    raw.NVIDIA_NIM_KEYS = 'fake-nvidia-key';
  }
  if (providers.includes('openrouter')) {
    raw.OPENROUTER_KEYS = 'fake-openrouter-key';
  }
  if (providers.includes('tokenharbor')) {
    raw.TOKENHARBOR_KEYS = 'fake-tokenharbor-key';
  }
  return loadCredentialPool(raw);
}

function makeResponse(modelId: string, totalTokens = 24): CanonicalResponse {
  return {
    id: 'response-1',
    model: modelId,
    created: 0,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'PONG' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 8,
      completion_tokens: totalTokens - 8,
      total_tokens: totalTokens,
      estimated: false,
    },
  };
}

interface FakeAdapterOptions {
  id: ProviderId;
  models?: ModelInfo[];
  listModels?: (cred: Credential) => Promise<ModelInfo[]>;
  chat?: (
    req: CanonicalRequest,
    cred: Credential,
    signal?: AbortSignal,
  ) => Promise<CanonicalResponse>;
}

interface FakeAdapter {
  adapter: ProviderAdapter;
  chatRequests: CanonicalRequest[];
  listCalls: () => number;
}

function makeAdapter(options: FakeAdapterOptions): FakeAdapter {
  const chatRequests: CanonicalRequest[] = [];
  let listCalls = 0;

  const adapter: ProviderAdapter = {
    id: options.id,
    supportsStreaming: false,
    async listModels(cred) {
      listCalls += 1;
      return options.listModels === undefined ? (options.models ?? []) : options.listModels(cred);
    },
    async chat(req, cred, signal) {
      chatRequests.push(req);
      return options.chat === undefined
        ? makeResponse(req.model ?? 'model')
        : options.chat(req, cred, signal);
    },
    async *stream(): AsyncIterable<CanonicalChunk> {
      throw new ProviderError('unsupported', 'not used by the smoke script');
      yield undefined as never;
    },
  };

  return { adapter, chatRequests, listCalls: () => listCalls };
}

function outputLines(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

test('smoke plan: formatter aligns columns, preserves provider order, and ends with the exact summary', () => {
  const rows: SmokeRow[] = [
    {
      provider: 'nvidia',
      creds: 1,
      models: 84,
      free: 0,
      model: 'meta/llama-3.1-8b-instruct',
      tokens: 24,
      estimated: false,
      ms: 812,
      status: 'ok',
    },
    {
      provider: 'openrouter',
      creds: 1,
      models: 433,
      free: 118,
      model: 'liquid/lfm-2.5-2.6b:free',
      tokens: 19,
      estimated: false,
      ms: 604,
      status: 'ok',
    },
    {
      provider: 'tokenharbor',
      creds: 1,
      models: 82,
      free: 4,
      model: 'deepseek-v4.1-flash:free',
      tokens: 18,
      estimated: false,
      ms: 431,
      status: 'ok',
    },
  ];

  const lines = formatTable(rows, 2400).split('\n');

  assert.equal(lines.length, 5);
  assert.deepEqual(
    lines.slice(0, 4).map((line) => line.trim().split(/\s{2,}/).length),
    [9, 9, 9, 9],
  );
  assert.deepEqual(
    lines.slice(1, 4).map((line) => line.trim().split(/\s{2,}/)[0]),
    ['nvidia', 'openrouter', 'tokenharbor'],
  );
  assert.equal(lines.at(-1), '3 providers: 3 ok, 0 failed (2.4s)');
  assert.equal(formatSummary(rows, 2400), '3 providers: 3 ok, 0 failed (2.4s)');
});

test('smoke plan: all selected providers succeeding exits 0', async () => {
  const pool = makePool();
  const adapters = new Map<ProviderId, ProviderAdapter>();
  for (const id of ['nvidia', 'openrouter', 'tokenharbor']) {
    adapters.set(id, makeAdapter({ id, models: [model('model-a', true)] }).adapter);
  }
  const output = outputLines();

  const code = await runSmoke({
    pool,
    adapters,
    write: output.write,
    now: () => 0,
  });

  assert.equal(code, 0);
  assert.equal(output.lines.at(-1), '3 providers: 3 ok, 0 failed (0.0s)');
  assert.equal(output.lines.filter((line) => line.trimEnd().endsWith(' ok')).length, 3);
});

test('smoke plan: a ProviderError auth failure exits 1 and shows FAILED auth', async () => {
  const failing = makeAdapter({
    id: 'openrouter',
    listModels: async () => {
      throw new ProviderError('auth', 'invalid key');
    },
  });
  const output = outputLines();

  const code = await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', failing.adapter]]),
    providers: ['openrouter'],
    write: output.write,
    now: () => 0,
  });

  assert.equal(code, 1);
  assert.ok(output.lines.some((line) => line.includes('FAILED auth')));
  assert.ok(output.lines.some((line) => line.includes('error[auth] openrouter')));
});

test('smoke plan: a provider returning zero models exits 1 and never calls chat', async () => {
  const empty = makeAdapter({ id: 'openrouter', models: [] });
  const output = outputLines();

  const code = await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', empty.adapter]]),
    providers: ['openrouter'],
    write: output.write,
    now: () => 0,
  });

  assert.equal(code, 1);
  assert.equal(empty.chatRequests.length, 0);
  assert.ok(output.lines.some((line) => line.includes('FAILED no_models')));
});

test('smoke plan: a provider with no credentials exits 1 without calling the adapter', async () => {
  const adapter = makeAdapter({ id: 'openrouter', models: [model('model-a', true)] });
  const output = outputLines();

  const code = await runSmoke({
    pool: makePool(['nvidia']),
    adapters: new Map([['openrouter', adapter.adapter]]),
    providers: ['openrouter'],
    write: output.write,
    now: () => 0,
  });

  assert.equal(code, 1);
  assert.equal(adapter.listCalls(), 0);
  assert.ok(output.lines.some((line) => line.includes('FAILED no_credential')));
});

test('smoke plan: --provider selection prints only that row and exits 0', async () => {
  const nvidia = makeAdapter({ id: 'nvidia', models: [model('nvidia-model', true)] });
  const openrouter = makeAdapter({ id: 'openrouter', models: [model('openrouter-model', true)] });
  const tokenharbor = makeAdapter({
    id: 'tokenharbor',
    models: [model('tokenharbor-model', true)],
  });
  const output = outputLines();

  const code = await runSmoke({
    pool: makePool(),
    adapters: new Map([
      ['nvidia', nvidia.adapter],
      ['openrouter', openrouter.adapter],
      ['tokenharbor', tokenharbor.adapter],
    ]),
    providers: ['openrouter'],
    write: output.write,
    now: () => 0,
  });

  assert.equal(code, 0);
  assert.equal(nvidia.chatRequests.length, 0);
  assert.equal(openrouter.chatRequests.length, 1);
  assert.equal(tokenharbor.chatRequests.length, 0);
  assert.equal(output.lines.filter((line) => line.startsWith('openrouter')).length, 1);
  assert.equal(
    output.lines.some((line) => line.startsWith('nvidia')),
    false,
  );
  assert.equal(
    output.lines.some((line) => line.startsWith('tokenharbor')),
    false,
  );
  assert.equal(output.lines.at(-1), '1 provider: 1 ok, 0 failed (0.0s)');
});

test('smoke plan: a failing adapter never leaks its secret', async () => {
  const secret = 'sk-smoke-secret-do-not-print';
  const failing = makeAdapter({
    id: 'openrouter',
    listModels: async () => {
      throw new ProviderError('auth', `invalid key ${secret}`);
    },
  });
  const output = outputLines();

  const code = await runSmoke({
    pool: loadCredentialPool({ OPENROUTER_KEYS: secret }),
    adapters: new Map([['openrouter', failing.adapter]]),
    providers: ['openrouter'],
    write: output.write,
    now: () => 0,
  });

  const text = output.lines.join('\n');
  assert.equal(code, 1);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('Authorization'), false);
  assert.match(text, /FAILED auth/);
});

test('smoke plan: a non-provider error is reduced to unknown and never echoed', async () => {
  const secret = 'sk-smoke-secret-do-not-print';
  const failing = makeAdapter({
    id: 'openrouter',
    listModels: async () => {
      throw new Error(`fetch failed with ${secret}`);
    },
  });
  const output = outputLines();

  const code = await runSmoke({
    pool: loadCredentialPool({ OPENROUTER_KEYS: secret }),
    adapters: new Map([['openrouter', failing.adapter]]),
    providers: ['openrouter'],
    write: output.write,
    now: () => 0,
  });

  const text = output.lines.join('\n');
  assert.equal(code, 1);
  assert.equal(text.includes(secret), false);
  assert.match(text, /FAILED unknown/);
});

test('smoke plan: model choice is explicit, then first free, then first listed', async () => {
  const models = [
    model('paid-first', false),
    model('free-second', true),
    model('free-third', true),
  ];

  const fromEnv = makeAdapter({ id: 'openrouter', models });
  await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', fromEnv.adapter]]),
    providers: ['openrouter'],
    env: { SMOKE_MODEL_OPENROUTER: 'free-second' },
    write: () => {},
    now: () => 0,
  });
  assert.equal(fromEnv.chatRequests[0]?.model, 'free-second');

  const defaulted = makeAdapter({ id: 'openrouter', models });
  await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', defaulted.adapter]]),
    providers: ['openrouter'],
    write: () => {},
    now: () => 0,
  });
  assert.equal(defaulted.chatRequests[0]?.model, DEFAULT_MODEL.openrouter);

  const noFree = makeAdapter({
    id: 'openrouter',
    models: [model('paid-a', false), model('paid-b', null)],
    chat: async (req) => {
      throw new ProviderError('model_gone', req.model ?? 'gone');
    },
  });
  await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', noFree.adapter]]),
    providers: ['openrouter'],
    write: () => {},
    now: () => 0,
  });
  assert.deepEqual(
    noFree.chatRequests.map((request) => request.model),
    [DEFAULT_MODEL.openrouter, 'paid-a', 'paid-b'],
  );

  const explicit = makeAdapter({ id: 'openrouter', models });
  await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', explicit.adapter]]),
    providers: ['openrouter'],
    model: 'forced-model',
    write: () => {},
    now: () => 0,
  });
  const request = explicit.chatRequests[0];
  assert.equal(request?.model, 'forced-model');
  assert.equal(request?.max_tokens, 16);
  assert.deepEqual(request?.messages, [{ role: 'user', content: 'Reply with exactly: PONG' }]);
});

test('smoke plan: --model is the whole chain and is never retried', async () => {
  const adapter = makeAdapter({
    id: 'openrouter',
    models: [model('free-a', true), model('free-b', true)],
    chat: async (req) => {
      throw new ProviderError('model_gone', req.model ?? 'gone');
    },
  });
  const output = outputLines();

  const code = await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', adapter.adapter]]),
    providers: ['openrouter'],
    model: 'forced-model',
    env: { SMOKE_MODEL_OPENROUTER: 'env-model' },
    write: output.write,
    now: () => 0,
  });

  const text = output.lines.join('\n');
  assert.equal(code, 1);
  assert.deepEqual(
    adapter.chatRequests.map((request) => request.model),
    ['forced-model'],
  );
  assert.match(text, /error\[model_gone\] openrouter$/m);
  assert.equal(text.includes('after'), false);
});

test('smoke plan: the env override leads, then free models, then the first listed models', async () => {
  const models = [
    model('paid-first', false),
    model('free-a', true),
    model('free-b', true),
    model('free-c', true),
  ];
  const adapter = makeAdapter({
    id: 'openrouter',
    models,
    chat: async (req) => {
      throw new ProviderError('model_gone', req.model ?? 'gone');
    },
  });

  await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', adapter.adapter]]),
    providers: ['openrouter'],
    env: { SMOKE_MODEL_OPENROUTER: 'env-model' },
    write: () => {},
    now: () => 0,
  });

  assert.deepEqual(
    adapter.chatRequests.map((request) => request.model),
    ['env-model', 'free-a', 'free-b', 'paid-first'],
  );
});

test('smoke plan: without an override the built-in default leads the chain', async () => {
  const models = [
    model('paid-first', false),
    model('free-a', true),
    model('free-b', true),
    model('free-c', true),
  ];
  const adapter = makeAdapter({
    id: 'openrouter',
    models,
    chat: async (req) => {
      throw new ProviderError('model_gone', req.model ?? 'gone');
    },
  });

  await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', adapter.adapter]]),
    providers: ['openrouter'],
    env: {},
    write: () => {},
    now: () => 0,
  });

  assert.deepEqual(
    adapter.chatRequests.map((request) => request.model),
    [DEFAULT_MODEL.openrouter, 'free-a', 'free-b', 'paid-first'],
  );
});

test('smoke plan: retryable failures fall through to the next candidate and can succeed', async () => {
  const adapter = makeAdapter({
    id: 'openrouter',
    models: [model('x'), model('y'), model('z')],
    chat: async (req) => {
      if (req.model === 'a') {
        throw new ProviderError('model_gone', 'gone');
      }
      if (req.model === 'x') {
        throw new ProviderError('rate_limited', 'limited');
      }
      return makeResponse(req.model ?? 'model');
    },
  });
  const output = outputLines();

  const code = await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', adapter.adapter]]),
    providers: ['openrouter'],
    env: { SMOKE_MODEL_OPENROUTER: 'a' },
    write: output.write,
    now: () => 0,
  });

  const row = output.lines.find((line) => line.startsWith('openrouter'));
  assert.equal(code, 0);
  assert.equal(adapter.chatRequests.length, 3);
  assert.deepEqual(
    adapter.chatRequests.map((request) => request.model),
    ['a', 'x', 'y'],
  );
  assert.ok(row?.includes('y'));
  assert.equal(output.lines.at(-1), '1 provider: 1 ok, 0 failed (0.0s)');
  assert.equal(
    output.lines.some((line) => line.startsWith('error[')),
    false,
  );
});

test('smoke plan: a non-retryable auth failure stops the chain after one call', async () => {
  const adapter = makeAdapter({
    id: 'openrouter',
    models: [model('x'), model('y'), model('z')],
    chat: async () => {
      throw new ProviderError('auth', 'invalid key');
    },
  });
  const output = outputLines();

  const code = await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', adapter.adapter]]),
    providers: ['openrouter'],
    env: { SMOKE_MODEL_OPENROUTER: 'a' },
    write: output.write,
    now: () => 0,
  });

  const text = output.lines.join('\n');
  assert.equal(code, 1);
  assert.equal(adapter.chatRequests.length, 1);
  assert.match(text, /FAILED auth/);
  assert.match(text, /error\[auth\] openrouter$/m);
  assert.equal(text.includes('after'), false);
});

test('smoke plan: the failure line reports the number of models only when it is above one', async () => {
  const adapter = makeAdapter({
    id: 'openrouter',
    models: [model('x'), model('y'), model('z')],
    chat: async () => {
      throw new ProviderError('upstream', 'boom');
    },
  });
  const output = outputLines();

  const code = await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', adapter.adapter]]),
    providers: ['openrouter'],
    env: { SMOKE_MODEL_OPENROUTER: 'a' },
    write: output.write,
    now: () => 0,
  });

  const text = output.lines.join('\n');
  assert.equal(code, 1);
  assert.equal(adapter.chatRequests.length, 3);
  assert.match(text, /error\[upstream\] openrouter after 3 models/);
});

test('smoke plan: the default timeout is 60 seconds', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 60_000);
});

test('smoke plan: a hung provider is reported as a timeout failure', async () => {
  const hung = makeAdapter({
    id: 'openrouter',
    listModels: () => new Promise<ModelInfo[]>(() => {}),
  });
  const output = outputLines();

  const code = await runSmoke({
    pool: makePool(),
    adapters: new Map([['openrouter', hung.adapter]]),
    providers: ['openrouter'],
    write: output.write,
    now: () => 0,
    timeoutMs: 10,
  });

  assert.equal(code, 1);
  assert.ok(output.lines.some((line) => line.includes('FAILED timeout')));
});

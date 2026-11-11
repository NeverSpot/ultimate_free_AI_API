import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config/env';
import { buildServer } from '../../src/http/server';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';

const NOW = 1_731_250_000_000;

const config: Config = {
  port: 0,
  adminToken: 'test-admin-token',
  maxBodyBytes: 2 * 1024 * 1024,
  attemptTimeoutMs: 10_000,
  requestDeadlineMs: 30_000,
  logLevel: 'silent',
  nodeEnv: 'test',
};

const provider = new MockProviderAdapter({
  id: 'mock',
  model: 'mock-model',
  content: 'Hello from the mock adapter.',
  now: () => NOW,
});

const credential: Credential = {
  id: 'credential-1',
  provider: 'mock',
  secret: 'not-a-real-key',
};

const validBody = {
  model: 'mock-model',
  messages: [{ role: 'user', content: 'Say hello.' }],
};

const authorized = { authorization: `Bearer ${config.adminToken}` };

function makeApp(): FastifyInstance {
  return buildServer({ config, provider, credential, now: () => NOW, logger: false });
}

async function post(
  app: FastifyInstance,
  body: unknown,
  headers: Record<string, string> = authorized,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body as Record<string, unknown>,
  });
}

interface ErrorEnvelope {
  error: {
    message: string;
    type: string;
    code: string;
    param: string | null;
  };
}

function assertErrorEnvelope(payload: unknown): asserts payload is ErrorEnvelope {
  assert.equal(typeof payload, 'object');
  assert.notEqual(payload, null);

  const body = payload as { error?: Record<string, unknown> };
  assert.equal(typeof body.error, 'object');
  assert.notEqual(body.error, null);

  const error = body.error as Record<string, unknown>;
  assert.equal(typeof error.message, 'string');
  assert.equal(typeof error.type, 'string');
  assert.equal(typeof error.code, 'string');
  assert.ok(error.param === null || typeof error.param === 'string');
}

test('http: 200 returns an OpenAI-shaped body and exact keys', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await post(app, validBody);
  assert.equal(res.statusCode, 200);

  const body = res.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    'choices',
    'created',
    'id',
    'model',
    'object',
    'usage',
  ]);
  assert.equal(body.object, 'chat.completion');
  assert.match(String(body.id), /^chatcmpl-/);
  assert.equal(body.model, 'mock-model');
  assert.equal(typeof body.created, 'number');

  const choices = body.choices as Array<Record<string, unknown>>;
  assert.equal(choices.length, 1);
  const [choice] = choices;
  assert.ok(choice);
  assert.deepEqual(Object.keys(choice).sort(), ['finish_reason', 'index', 'message']);
  assert.equal(choice.finish_reason, 'stop');

  const message = choice.message as Record<string, unknown>;
  assert.deepEqual(Object.keys(message).sort(), ['content', 'role']);
  assert.equal(message.role, 'assistant');
  assert.equal(typeof message.content, 'string');

  const usage = body.usage as Record<string, unknown>;
  assert.deepEqual(Object.keys(usage).sort(), [
    'completion_tokens',
    'prompt_tokens',
    'total_tokens',
  ]);
  assert.equal(typeof usage.prompt_tokens, 'number');
  assert.equal(typeof usage.completion_tokens, 'number');
  assert.equal(typeof usage.total_tokens, 'number');
  assert.equal('estimated' in usage, false);
});

test('http: 401 when the bearer token is missing', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await post(app, validBody, {});
  assert.equal(res.statusCode, 401);

  const body = res.json();
  assertErrorEnvelope(body);
  assert.equal(body.error.type, 'authentication_error');
  assert.equal(body.error.code, 'invalid_api_key');
});

test('http: 401 when the bearer token is wrong', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await post(app, validBody, { authorization: 'Bearer definitely-wrong' });
  assert.equal(res.statusCode, 401);

  const body = res.json();
  assertErrorEnvelope(body);
  assert.equal(body.error.type, 'authentication_error');
});

test('http: 400 when messages is missing', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await post(app, { model: 'mock-model' });
  assert.equal(res.statusCode, 400);

  const body = res.json();
  assertErrorEnvelope(body);
  assert.equal(body.error.type, 'invalid_request_error');
});

test('http: 400 when temperature is the wrong type', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await post(app, { ...validBody, temperature: 'hot' });
  assert.equal(res.statusCode, 400);

  const body = res.json();
  assertErrorEnvelope(body);
  assert.equal(body.error.type, 'invalid_request_error');
});

test('http: 501 when stream is true', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await post(app, { ...validBody, stream: true });
  assert.equal(res.statusCode, 501);

  const body = res.json();
  assertErrorEnvelope(body);
  assert.equal(body.error.code, 'unsupported');
});

test('http: 501 when n is greater than 1', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await post(app, { ...validBody, n: 2 });
  assert.equal(res.statusCode, 501);

  const body = res.json();
  assertErrorEnvelope(body);
  assert.equal(body.error.code, 'unsupported');
});

test('http: boundary accepts and ignores seed and presence_penalty', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await post(app, { ...validBody, seed: 42, presence_penalty: 0.7 });
  assert.equal(res.statusCode, 200);

  const body = res.json() as Record<string, unknown>;
  assert.equal('seed' in body, false);
  assert.equal('presence_penalty' in body, false);
  assert.equal(body.object, 'chat.completion');
});

test('http: response carries the full x-gateway-* header set', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await post(app, validBody);
  assert.equal(res.statusCode, 200);

  assert.match(String(res.headers['x-request-id']), /^chatcmpl-/);
  assert.equal(res.headers['x-gateway-provider'], 'mock');
  assert.equal(res.headers['x-gateway-model'], 'mock-model');
  assert.equal(res.headers['x-gateway-attempts'], '1');
  assert.match(String(res.headers['x-gateway-latency-ms']), /^\d+$/);
  assert.equal(res.headers['x-gateway-tokens-estimated'], 'true');
  assert.equal(res.headers['retry-after'], undefined);
});

test('http: every non-2xx returns the OpenAI error envelope', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const cases = [
    { body: validBody, headers: {}, status: 401 },
    { body: { model: 'mock-model' }, headers: authorized, status: 400 },
    { body: { ...validBody, temperature: 'hot' }, headers: authorized, status: 400 },
    { body: { ...validBody, stream: true }, headers: authorized, status: 501 },
    { body: { ...validBody, tools: [] }, headers: authorized, status: 501 },
  ];

  for (const scenario of cases) {
    const res = await post(app, scenario.body, scenario.headers);
    assert.equal(res.statusCode, scenario.status);
    assertErrorEnvelope(res.json());
  }

  const notFound = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
  assert.equal(notFound.statusCode, 404);
  assertErrorEnvelope(notFound.json());
});

test('http: healthz marks unwired probes unknown rather than ok', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);

  const body = res.json() as {
    status: string;
    checks: Record<string, string>;
    version: string;
    uptime_s: number;
  };
  assert.equal(body.status, 'ok');
  // A fabricated 'ok' here would hide a dead Redis behind a green dashboard.
  assert.deepEqual(body.checks, { redis: 'unknown', postgres: 'unknown' });
  assert.equal(typeof body.version, 'string');
  assert.equal(typeof body.uptime_s, 'number');
});

test('http: healthz returns 503 down when the redis probe reports down', async (t) => {
  const app = buildServer({
    config,
    provider,
    credential,
    now: () => NOW,
    logger: false,
    probes: { redis: () => 'down', postgres: () => 'ok' },
  });
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 503);

  const body = res.json() as { status: string; checks: Record<string, string> };
  assert.equal(body.status, 'down');
  assert.equal(body.checks.redis, 'down');
});

test('http: healthz reports degraded with 200 when a non-fatal probe fails', async (t) => {
  // Postgres unavailable degrades accounting but must not stop serving traffic:
  // the probe declares its own severity by returning 'degraded' rather than 'down'.
  const app = buildServer({
    config,
    provider,
    credential,
    now: () => NOW,
    logger: false,
    probes: { redis: () => 'ok', postgres: () => 'degraded' },
  });
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);

  const body = res.json() as { status: string; checks: Record<string, string> };
  assert.equal(body.status, 'degraded');
  assert.equal(body.checks.postgres, 'degraded');
});

test('http: unknown route returns 404 in the OpenAI error envelope', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(res.statusCode, 404);

  const body = res.json();
  assertErrorEnvelope(body);
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.code, 'invalid_request');
});

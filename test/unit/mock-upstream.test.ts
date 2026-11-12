import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Server } from 'node:http';
import {
  createMockUpstreamServer,
  startMockUpstreamServer,
  checkRateLimit,
  injectError,
  config,
  resetState,
} from '../../load/mock-upstream';
import { HttpMockUpstreamAdapter, isPortAvailable, findAvailablePort } from '../../load/run';
import type { Credential, ProviderId } from '../../src/providers/types';
import type { CanonicalRequest } from '../../src/core/types';
import { ProviderError } from '../../src/core/errors';

interface HealthResponse {
  status: string;
}

interface ModelsResponse {
  object: string;
  data: Array<{ id: string; object: string }>;
}

interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

interface ChatResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface AdminConfigResponse {
  latencyMs: number;
  errorRate: number;
  errorType: string;
  rpmCeiling: number;
  slowClientMode: boolean;
}

describe('mock upstream service', () => {
  let server: Server;
  const PORT = 9123;
  const BASE_URL = `http://127.0.0.1:${PORT}`;

  before(async () => {
    server = createMockUpstreamServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(PORT, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    resetState();
  });

  it('default configuration has 60ms latency, zero errors, unlimited RPM', () => {
    assert.equal(config.latencyMs, 60);
    assert.equal(config.errorRate, 0);
    assert.equal(config.errorType, '500');
    assert.equal(config.rpmCeiling, 0);
    assert.equal(config.slowClientMode, false);
  });

  it('GET /health returns 200 ok', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as HealthResponse;
    assert.equal(data.status, 'ok');
  });

  it('GET /v1/models returns model list including gpt-4o-mini', async () => {
    const res = await fetch(`${BASE_URL}/v1/models`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as ModelsResponse;
    assert.equal(data.object, 'list');
    assert.ok(data.data.some((m) => m.id === 'gpt-4o-mini'));
  });

  it('checkRateLimit enforces per-credential RPM ceiling', () => {
    config.rpmCeiling = 3;
    const now = 100000;

    assert.equal(checkRateLimit('Bearer key-a', now), true);
    assert.equal(checkRateLimit('Bearer key-a', now + 100), true);
    assert.equal(checkRateLimit('Bearer key-a', now + 200), true);
    // 4th request in the same minute exceeds ceiling
    assert.equal(checkRateLimit('Bearer key-a', now + 300), false);

    // Another key is unaffected
    assert.equal(checkRateLimit('Bearer key-b', now + 400), true);

    // After 60 seconds, key-a is allowed again
    assert.equal(checkRateLimit('Bearer key-a', now + 60500), true);
  });

  it('POST /v1/chat/completions returns 429 when RPM ceiling is exceeded', async () => {
    config.latencyMs = 0;
    config.rpmCeiling = 2;

    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'test' }],
    });

    const res1 = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rate-test' },
      body: payload,
    });
    assert.equal(res1.status, 200);

    const res2 = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rate-test' },
      body: payload,
    });
    assert.equal(res2.status, 200);

    const res3 = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rate-test' },
      body: payload,
    });
    assert.equal(res3.status, 429);
    assert.equal(res3.headers.get('retry-after'), '60');
    const errData = (await res3.json()) as ErrorResponse;
    assert.equal(errData.error.type, 'rate_limit_error');
  });

  it('injectError triggers 500 when errorRate is 1.0', () => {
    config.errorRate = 1;
    config.errorType = '500';
    const err = injectError();
    assert.ok(err);
    assert.equal(err.status, 500);
    assert.equal(err.body.error && (err.body.error as { type: string }).type, 'internal_error');
  });

  it('injectError triggers 429 when errorRate is 1.0 and errorType is 429', () => {
    config.errorRate = 1;
    config.errorType = '429';
    const err = injectError();
    assert.ok(err);
    assert.equal(err.status, 429);
    assert.equal(err.body.error && (err.body.error as { type: string }).type, 'rate_limit_error');
  });

  it('injectError triggers timeout when errorType is timeout', () => {
    config.errorRate = 1;
    config.errorType = 'timeout';
    const err = injectError();
    assert.ok(err);
    assert.equal(err.isTimeout, true);
  });

  it('POST /v1/chat/completions returns buffered response with usage and stop finish_reason', async () => {
    config.latencyMs = 0;

    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
    const data = (await res.json()) as ChatResponse;
    assert.equal(data.object, 'chat.completion');
    assert.equal(data.model, 'gpt-4o-mini');
    assert.equal(data.choices[0]?.finish_reason, 'stop');
    assert.equal(data.choices[0]?.message.content, 'Hello world');
    assert.equal(data.usage.total_tokens, 30);
  });

  it('POST /v1/chat/completions returns SSE stream with [DONE]', async () => {
    config.latencyMs = 0;

    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
    const text = await res.text();
    assert.ok(text.includes('data: '));
    assert.ok(text.includes('chat.completion.chunk'));
    assert.ok(text.includes('[DONE]'));
  });

  it('POST /__admin/config mutates config at runtime', async () => {
    const res = await fetch(`${BASE_URL}/__admin/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latencyMs: 120, rpmCeiling: 50, slowClientMode: true }),
    });

    assert.equal(res.status, 200);
    const updated = (await res.json()) as AdminConfigResponse;
    assert.equal(updated.latencyMs, 120);
    assert.equal(updated.rpmCeiling, 50);
    assert.equal(updated.slowClientMode, true);
    assert.equal(config.latencyMs, 120);
    assert.equal(config.rpmCeiling, 50);
    assert.equal(config.slowClientMode, true);
  });

  it('GET /__admin/stats tracks total and per-credential request counts', async () => {
    config.latencyMs = 0;
    config.rpmCeiling = 0;

    await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key-1' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'c1' }] }),
    });
    await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key-2' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'c2' }] }),
    });

    const res = await fetch(`${BASE_URL}/__admin/stats`);
    assert.equal(res.status, 200);
    const stats = (await res.json()) as {
      totalRequests: number;
      credentials: Record<string, number>;
    };
    assert.equal(stats.totalRequests, 2);
    assert.equal(stats.credentials['test-key-1'], 1);
    assert.equal(stats.credentials['test-key-2'], 1);
  });

  it('GET /__admin/stats preserves cumulative request counts across extended test windows', async () => {
    config.latencyMs = 0;
    config.rpmCeiling = 0;

    // Simulate requests across multiple minutes (> 60 seconds)
    checkRateLimit('Bearer old-key', 1000);
    checkRateLimit('Bearer old-key', 2000);
    // Request 5 minutes later
    checkRateLimit('Bearer old-key', 300_000);

    const res = await fetch(`${BASE_URL}/__admin/stats`);
    assert.equal(res.status, 200);
    const stats = (await res.json()) as {
      totalRequests: number;
      credentials: Record<string, number>;
    };
    assert.equal(stats.totalRequests, 3);
    assert.equal(stats.credentials['old-key'], 3);
  });

  it('POST /__admin/reset restores defaults and clears hits', async () => {
    config.latencyMs = 500;
    config.rpmCeiling = 10;
    const res = await fetch(`${BASE_URL}/__admin/reset`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(config.latencyMs, 60);
    assert.equal(config.rpmCeiling, 0);

    const statsRes = await fetch(`${BASE_URL}/__admin/stats`);
    const stats = (await statsRes.json()) as { totalRequests: number };
    assert.equal(stats.totalRequests, 0);
  });

  it('startMockUpstreamServer creates PID file and deletes it on server.close()', async () => {
    const testPort = 59222;
    const testServer = await startMockUpstreamServer(testPort);
    const pidPath = path.resolve(__dirname, '../../load/.mock-upstream.pid');
    assert.equal(fs.existsSync(pidPath), true);

    await new Promise<void>((resolve) => {
      testServer.close(() => resolve());
    });

    assert.equal(fs.existsSync(pidPath), false);
  });

  it('POST /v1/chat/completions returns 500 when errorRate is 1.0 and errorType is 500', async () => {
    config.latencyMs = 0;
    config.errorRate = 1.0;
    config.errorType = '500';

    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(res.status, 500);
    const err = (await res.json()) as ErrorResponse;
    assert.equal(err.error.type, 'internal_error');
  });

  it('POST /v1/chat/completions returns 429 when errorRate is 1.0 and errorType is 429', async () => {
    config.latencyMs = 0;
    config.errorRate = 1.0;
    config.errorType = '429';

    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    const err = (await res.json()) as ErrorResponse;
    assert.equal(err.error.type, 'rate_limit_error');
  });

  it('POST /v1/chat/completions slowClientMode streams chunks progressively', async () => {
    config.latencyMs = 0;
    config.slowClientMode = true;

    const start = Date.now();
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    const elapsed = Date.now() - start;
    assert.ok(text.includes('[DONE]'));
    // 4 chunks trickled with 100ms pauses = at least 200ms
    assert.ok(elapsed >= 200, `Expected elapsed >= 200ms, got ${elapsed}ms`);
  });

  describe('HttpMockUpstreamAdapter', () => {
    const adapter = new HttpMockUpstreamAdapter(BASE_URL);
    const cred: Credential = {
      id: 'test-cred-id',
      provider: 'mock' as ProviderId,
      secret: 'test-secret-key',
    };
    const req: CanonicalRequest = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hello adapter' }],
    };

    it('chat() returns CanonicalResponse with usage and choice', async () => {
      config.latencyMs = 0;
      const response = await adapter.chat(req, cred);
      assert.equal(response.id, 'chatcmpl-mock');
      assert.equal(response.choices[0]?.message.content, 'Hello world');
      assert.equal(response.choices[0]?.finish_reason, 'stop');
      assert.equal(response.usage.total_tokens, 30);
      assert.equal(response.usage.estimated, false);
    });

    it('chat() maps 429 to rate_limited ProviderError with retryAfterMs: 60000', async () => {
      config.latencyMs = 0;
      config.errorRate = 1.0;
      config.errorType = '429';

      await assert.rejects(
        async () => adapter.chat(req, cred),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'rate_limited');
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterMs, 60_000);
          return true;
        },
      );
    });

    it('chat() maps 500 to upstream ProviderError', async () => {
      config.latencyMs = 0;
      config.errorRate = 1.0;
      config.errorType = '500';

      await assert.rejects(
        async () => adapter.chat(req, cred),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, 500);
          return true;
        },
      );
    });

    it('stream() yields canonical stream chunks', async () => {
      config.latencyMs = 0;
      const chunks = [];
      for await (const chunk of adapter.stream(req, cred)) {
        chunks.push(chunk);
      }
      assert.ok(chunks.length >= 2);
      assert.equal(chunks[0]?.delta.content, 'Hello');
      assert.equal(chunks[1]?.delta.content, ' world');
      assert.equal(chunks[chunks.length - 1]?.finish_reason, 'stop');
    });

    it('stream() maps 429 to rate_limited ProviderError with retryAfterMs: 60000', async () => {
      config.latencyMs = 0;
      config.errorRate = 1.0;
      config.errorType = '429';

      await assert.rejects(
        async () => {
          for await (const _ of adapter.stream(req, cred)) {
            // consume
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'rate_limited');
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterMs, 60_000);
          return true;
        },
      );
    });

    it('stream() maps 500 to upstream ProviderError', async () => {
      config.latencyMs = 0;
      config.errorRate = 1.0;
      config.errorType = '500';

      await assert.rejects(
        async () => {
          for await (const _ of adapter.stream(req, cred)) {
            // consume
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, 500);
          return true;
        },
      );
    });

    it('listModels() returns gpt-4o-mini', async () => {
      const models = await adapter.listModels();
      assert.ok(models.some((m) => m.id === 'gpt-4o-mini'));
    });

    it('chat() maps aborted signal to timeout ProviderError (status 499)', async () => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        async () => adapter.chat(req, cred, controller.signal),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'timeout');
          assert.equal(err.status, 499);
          return true;
        },
      );
    });

    it('chat() maps connection failure to upstream ProviderError (status 502)', async () => {
      const brokenAdapter = new HttpMockUpstreamAdapter('http://127.0.0.1:59999');
      await assert.rejects(
        async () => brokenAdapter.chat(req, cred),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, 502);
          return true;
        },
      );
    });

    it('stream() maps aborted signal to timeout ProviderError (status 499)', async () => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        async () => {
          for await (const _ of adapter.stream(req, cred, controller.signal)) {
            // consume
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'timeout');
          assert.equal(err.status, 499);
          return true;
        },
      );
    });
  });

  describe('port helpers', () => {
    it('isPortAvailable detects busy and free ports', async () => {
      // BASE_URL port PORT is currently listening
      const busy = await isPortAvailable(PORT);
      assert.equal(busy, false);

      // An unallocated high port should be free
      const free = await isPortAvailable(59123);
      assert.equal(free, true);
    });

    it('findAvailablePort returns a free port', async () => {
      const port = await findAvailablePort(59100);
      assert.ok(port >= 59100);
      assert.equal(await isPortAvailable(port), true);
    });
  });
});

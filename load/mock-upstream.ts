import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MockConfig {
  latencyMs: number;
  errorRate: number; // 0 to 1
  errorType: '429' | '500' | 'timeout';
  rpmCeiling: number; // per-credential rate limit (0 = unlimited)
  slowClientMode: boolean; // trickle response chunks every 100ms
}

export const defaultConfig: Readonly<MockConfig> = Object.freeze({
  latencyMs: 60, // default 60ms as required
  errorRate: 0,
  errorType: '500',
  rpmCeiling: 0,
  slowClientMode: false,
});

export const config: MockConfig = { ...defaultConfig };

/** Per-credential request timestamps for RPM simulation */
export const credentialHits = new Map<string, number[]>();

/** All-time per-credential request counts for load test stats across any duration */
export const credentialTotalHits = new Map<string, number>();

export function resetState(): void {
  Object.assign(config, defaultConfig);
  credentialHits.clear();
  credentialTotalHits.clear();
}

export function checkRateLimit(authHeader: string | undefined, now: number = Date.now()): boolean {
  const key = authHeader?.replace(/^Bearer\s+/i, '').trim() || 'anonymous';
  const window = credentialHits.get(key) || [];
  const recent = window.filter((t) => now - t < 60_000);
  if (config.rpmCeiling && config.rpmCeiling > 0 && recent.length >= config.rpmCeiling) {
    return false;
  }
  recent.push(now);
  credentialHits.set(key, recent);
  credentialTotalHits.set(key, (credentialTotalHits.get(key) || 0) + 1);
  return true;
}

export interface InjectedError {
  status: number;
  body: Record<string, unknown>;
  isTimeout?: boolean;
}

export function injectError(): InjectedError | null {
  if (config.errorRate <= 0 || Math.random() >= config.errorRate) {
    return null;
  }
  switch (config.errorType) {
    case '429':
      return {
        status: 429,
        body: {
          error: {
            message: 'Rate limit exceeded',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
          },
        },
      };
    case '500':
      return {
        status: 500,
        body: {
          error: {
            message: 'Internal server error',
            type: 'internal_error',
            code: 'internal_error',
          },
        },
      };
    case 'timeout':
      return {
        status: 0,
        body: {},
        isTimeout: true,
      };
  }
  return null;
}

export function buildBufferedResponse(model: string = 'gpt-4o-mini'): string {
  return JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        message: { role: 'assistant', content: 'Hello world' },
        index: 0,
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

export function buildStreamChunks(model: string = 'gpt-4o-mini'): string[] {
  const created = Math.floor(Date.now() / 1000);
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ delta: { role: 'assistant', content: 'Hello' }, index: 0, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ delta: { content: ' world' }, index: 0, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

export function createMockUpstreamServer(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    // CORS & common headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Health check
    if (pathname === '/health' || pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }

    // Admin API
    if (pathname === '/__admin/config') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(config));
      }
      if (req.method === 'POST') {
        try {
          const raw = await readBody(req);
          const update = JSON.parse(raw || '{}');
          if (typeof update.latencyMs === 'number') config.latencyMs = update.latencyMs;
          if (typeof update.errorRate === 'number') config.errorRate = update.errorRate;
          if (
            update.errorType === '429' ||
            update.errorType === '500' ||
            update.errorType === 'timeout'
          ) {
            config.errorType = update.errorType;
          }
          if (typeof update.rpmCeiling === 'number') config.rpmCeiling = update.rpmCeiling;
          if (typeof update.slowClientMode === 'boolean')
            config.slowClientMode = update.slowClientMode;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(config));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        }
      }
    }

    if (pathname === '/__admin/reset' && req.method === 'POST') {
      resetState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'reset' }));
    }

    if (pathname === '/__admin/stats' && req.method === 'GET') {
      const stats: Record<string, number> = {};
      let total = 0;
      for (const [key, count] of credentialTotalHits.entries()) {
        stats[key] = count;
        total += count;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ totalRequests: total, credentials: stats }));
    }

    if (pathname === '/__admin/shutdown' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'shutting_down' }));
      setImmediate(() => {
        cleanupPidFile();
        process.exit(0);
      });
      return;
    }

    // Models endpoint
    if ((pathname === '/v1/models' || pathname === '/models') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'gpt-4o-mini', object: 'model', created: 1700000000, owned_by: 'system' },
            { id: 'mock-model', object: 'model', created: 1700000000, owned_by: 'system' },
          ],
        }),
      );
    }

    // Chat completions endpoint
    if (
      (pathname === '/v1/chat/completions' || pathname === '/chat/completions') &&
      req.method === 'POST'
    ) {
      let parsedBody: Record<string, any> = {};
      try {
        const rawBody = await readBody(req);
        parsedBody = JSON.parse(rawBody || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }),
        );
      }

      const auth = req.headers['authorization'];
      if (!checkRateLimit(auth)) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        });
        return res.end(
          JSON.stringify({
            error: {
              message: 'Rate limit exceeded',
              type: 'rate_limit_error',
              code: 'rate_limit_exceeded',
            },
          }),
        );
      }

      const isStream = parsedBody.stream === true;
      const model =
        typeof parsedBody.model === 'string' && parsedBody.model ? parsedBody.model : 'gpt-4o-mini';

      const error = injectError();
      if (error) {
        if (error.isTimeout) {
          if (res.destroyed || req.destroyed) return;
          // Delay response indefinitely or until connection closes
          const timeoutHandle = setTimeout(() => {
            if (!res.writableEnded && !res.destroyed) {
              res.writeHead(504, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ error: { message: 'Gateway timeout', type: 'timeout_error' } }),
              );
            }
          }, 120_000);
          timeoutHandle.unref?.();
          req.on('close', () => clearTimeout(timeoutHandle));
          res.on('close', () => clearTimeout(timeoutHandle));
          return;
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (error.status === 429) {
          headers['Retry-After'] = '60';
        }
        res.writeHead(error.status, headers);
        return res.end(JSON.stringify(error.body));
      }

      // Latency simulation (default 60ms)
      if (config.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, config.latencyMs));
      }

      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const chunks = buildStreamChunks(model);
        if (config.slowClientMode) {
          for (const chunk of chunks) {
            if (res.writableEnded || res.destroyed || req.socket?.destroyed) break;
            res.write(chunk);
            await new Promise((r) => setTimeout(r, 100));
          }
          if (!res.writableEnded && !res.destroyed) res.end();
        } else {
          for (const chunk of chunks) {
            if (res.writableEnded || res.destroyed) break;
            res.write(chunk);
          }
          if (!res.writableEnded && !res.destroyed) res.end();
        }
        return;
      }

      const responseBody = buildBufferedResponse(model);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      return res.end(responseBody);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: `Cannot ${req.method} ${pathname}`, type: 'invalid_request_error' },
      }),
    );
  });
}

const PID_FILE = path.resolve(__dirname, '.mock-upstream.pid');

export function writePidFile(): void {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch {
    // Ignore PID write error
  }
}

export function cleanupPidFile(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // Ignore cleanup error
  }
}

export function startMockUpstreamServer(
  port: number = Number(process.env.MOCK_PORT || process.env.PORT || 9000),
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createMockUpstreamServer();
    server.on('error', reject);
    server.on('close', () => cleanupPidFile());
    server.listen(port, '0.0.0.0', () => {
      writePidFile();
      console.log(
        `Mock upstream listening on http://127.0.0.1:${port} (latency=${config.latencyMs}ms, errorRate=${config.errorRate})`,
      );
      resolve(server);
    });
  });
}

// Start if executed directly via CLI (tsx load/mock-upstream.ts)
const isDirectCli = typeof require !== 'undefined' && require.main === module;
const isTsxDirect =
  process.argv[1] &&
  (process.argv[1].endsWith('mock-upstream.ts') || process.argv[1].endsWith('mock-upstream.js'));

if (isDirectCli || isTsxDirect) {
  const PORT = Number(process.env.MOCK_PORT || process.env.PORT || 9000);
  startMockUpstreamServer(PORT).catch((err) => {
    console.error('Failed to start mock upstream:', err);
    process.exit(1);
  });

  const handleSignal = (signal: string): void => {
    console.log(`Received ${signal}, shutting down mock upstream...`);
    cleanupPidFile();
    process.exit(0);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}

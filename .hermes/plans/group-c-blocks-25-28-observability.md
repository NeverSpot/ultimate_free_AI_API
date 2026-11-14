# Plan: Group C — Phase I Observability (Blocks 25–28)

**Goal:** Add structured logging, Prometheus metrics, health/readiness probes, and graceful shutdown to the Fastify gateway backend.

**Context / assumptions:**
- Repo: `C:/Users/rishu/WebstormProjects/Ultimate_frre_ai`
- Branch: `agy/block-25-28-observability` (cut from `master`)
- Master is at `09bf2df` with Blocks 0–24 merged. `npm run verify` exits 0, 344 tests pass.
- Backend: Node 24, TypeScript 5.5, CommonJS, Fastify 5, `node:test`, TypeBox, native `fetch`.
- All four blocks mutate `src/http/server.ts` — must be done sequentially within one branch, one commit per block.
- `frontend/**` is already ignored in root `eslint.config.mjs` (from Block 24).
- No API keys, no secrets, no credentials in any file.
- Verification gate per block: `npm run test -- --test-name-pattern "<pattern>"` → exit 0.
- Final gate: `npm run verify` → exit 0.

---

## Block 25 — Structured logging & request tracing

**Files to create/modify:**
- `src/http/middleware/trace-id.ts` (CREATE) — Fastify `onRequest` hook that sets `x-request-id` on request and response headers
- `src/http/server.ts` (MODIFY) — import and register `traceIdPlugin` before routes

**Code — `src/http/middleware/trace-id.ts`:**
```typescript
import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';

export function traceIdPlugin(app: any, opts: any, done: any) {
  app.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done: any) => {
    const id = req.headers['x-request-id'] ?? crypto.randomBytes(16).toString('hex');
    req.headers['x-request-id'] = id;
    reply.header('x-request-id', id);
    done();
  });
  done();
}

export default traceIdPlugin;
```

**Code — `src/http/server.ts` modifications:**
- Add import: `import traceIdPlugin from './http/middleware/trace-id';`
- Add registration before route registration: `app.register(traceIdPlugin);`

**Test — `test/unit/trace-id.test.ts` (CREATE):**
```typescript
import { test, expect } from 'node:test';
import { createServer } from '../src/http/server';

test('trace-id: returns x-request-id header', async (t) => {
  const app = await createServer();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['x-request-id']).toBeDefined();
  expect(String(res.headers['x-request-id']).length).toBeGreaterThan(0);
  await app.close();
});
```

**Verification commands:**
1. `cd "C:/Users/rishu/WebstormProjects/Ultimate_frre_ai" && npx tsc --noEmit` → exit 0
2. `cd "C:/Users/rishu/WebstormProjects/Ultimate_frre_ai" && npm run test -- --test-name-pattern "trace-id"` → exit 0, output contains "ok"
3. `git diff --stat` → only `src/http/middleware/trace-id.ts`, `src/http/server.ts`, `test/unit/trace-id.test.ts`

**Commit:** `git add -A && git commit -m "feat(block-25): request tracing middleware"` → clean tree

---

## Block 26 — Prometheus metrics endpoint

**Files to create/modify:**
- `src/telemetry/metrics.ts` (CREATE) — in-memory counters, latency histogram, p95, text exposition format
- `src/http/routes/metrics.ts` (CREATE) — `GET /metrics` returning `text/plain`
- `src/http/server.ts` (MODIFY) — import and register `metricsRoute`

**Code — `src/telemetry/metrics.ts`:**
```typescript
const counters: Record<string, number> = {};
const latencies: number[] = [];

export function inc(key: string) { counters[key] = (counters[key] ?? 0) + 1; }
export function observeLatency(ms: number) { latencies.push(ms); if (latencies.length > 10000) latencies.shift(); }
export function getMetrics() {
  const sorted = latencies.slice().sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
  let out = '# HELP gateway_requests_total Total requests\n# TYPE gateway_requests_total counter\n';
  for (const [k, v] of Object.entries(counters)) out += `gateway_requests_total{${k}} ${v}\n`;
  out += `# HELP gateway_latency_p95_ms P95 latency in ms\n# TYPE gateway_latency_p95_ms gauge\ngateway_latency_p95_ms ${p95}\n`;
  return out;
}
export function reset() { Object.keys(counters).forEach(k => delete counters[k]); latencies.length = 0; }
```

**Code — `src/http/routes/metrics.ts`:**
```typescript
import type { FastifyInstance } from 'fastify';
import { getMetrics } from '../telemetry/metrics';

export default async function metricsRoute(app: FastifyInstance) {
  app.get('/metrics', async (_req, reply) => {
    reply.type('text/plain').send(getMetrics());
  });
}
```

**Code — `src/http/server.ts` modifications:**
- Add import: `import metricsRoute from './http/routes/metrics';`
- Add registration: `app.register(metricsRoute);`

**Test — `test/unit/metrics.test.ts` (CREATE):**
```typescript
import { test, expect } from 'node:test';
import { createServer } from '../src/http/server';

test('metrics: returns text/plain with p95', async (t) => {
  const app = await createServer();
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  expect(res.statusCode).toBe(200);
  expect(String(res.headers['content-type'])).toContain('text/plain');
  expect(res.body).toContain('gateway_latency_p95_ms');
  await app.close();
});
```

**Verification commands:**
1. `npx tsc --noEmit` → exit 0
2. `npm run test -- --test-name-pattern "metrics"` → exit 0
3. Manual smoke: `npm run dev` then `curl -s http://localhost:8080/metrics | head -5` → HTTP 200, text with `# HELP gateway_requests_total`

**Commit:** `git add -A && git commit -m "feat(block-26): prometheus metrics endpoint"` → clean tree

---

## Block 27 — Health & readiness probes

**Files to create/modify:**
- `src/telemetry/health.ts` (CREATE) — `checkHealth()` checking Postgres + Redis connectivity
- `src/http/routes/healthz.ts` (MODIFY) — extend existing route to call `checkHealth()`, return 503 when unhealthy
- `test/integration/health.test.ts` (CREATE) — integration test (needs Docker Postgres + Redis)

**Code — `src/telemetry/health.ts`:**
```typescript
import { Pool } from 'pg';

export async function checkHealth(pgPool: Pool | null, redisClient: any | null): Promise<{ ok: boolean; checks: Record<string, string> }> {
  const checks: Record<string, string> = {};
  let ok = true;
  try { if (pgPool) { await pgPool.query('SELECT 1'); checks.postgres = 'healthy'; } else { checks.postgres = 'not-configured'; } }
  catch { checks.postgres = 'unhealthy'; ok = false; }
  try { if (redisClient) { await redisClient.ping(); checks.redis = 'healthy'; } else { checks.redis = 'not-configured'; } }
  catch { checks.redis = 'unhealthy'; ok = false; }
  return { ok, checks };
}
```

**Code — `src/http/routes/healthz.ts` modifications:**
- Import `checkHealth` from `../telemetry/health`
- In the handler, call `checkHealth()` with the app's pg pool and redis client (pass them via app decoration or closure)
- Return 200 when healthy, 503 when unhealthy

**Test — `test/integration/health.test.ts`:**
```typescript
import { test, expect } from 'node:test';
import { createServer } from '../src/http/server';

test('healthz: returns 200 when healthy', async (t) => {
  const app = await createServer();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  await app.close();
});
```

**Verification commands:**
1. `npx tsc --noEmit` → exit 0
2. `npm run test:int -- --test-name-pattern "health"` → exit 0 (requires `npm run db:up` first)

**Commit:** `git add -A && git commit -m "feat(block-27): health & readiness probes"` → clean tree

---

## Block 28 — Graceful shutdown

**Files to create/modify:**
- `src/http/server.ts` (MODIFY) — export `app` and raw server, add `process.on('SIGTERM')` handler
- `test/unit/shutdown.test.ts` (CREATE)

**Code — `src/http/server.ts` modifications:**
- Export `app` and `server` (from `app.server`)
- Add:
```typescript
process.on('SIGTERM', async () => {
  await app.close();
  process.exit(0);
});
```

**Test — `test/unit/shutdown.test.ts`:**
```typescript
import { test, expect } from 'node:test';
import { createServer } from '../src/http/server';

test('shutdown: server closes on SIGTERM', async (t) => {
  const app = await createServer();
  const addr = app.server.address();
  expect(addr).not.toBeNull();
  await app.close();
  let closed = false;
  try { await app.inject({ method: 'GET', url: '/healthz' }); } catch { closed = true; }
  expect(closed).toBe(true);
});
```

**Verification commands:**
1. `npx tsc --noEmit` → exit 0
2. `npm run test -- --test-name-pattern "shutdown"` → exit 0

**Final verification for Group C:**
- `npm run verify` → exit 0 (typecheck + lint + format:check + test, 344 tests)

**Commit:** `git add -A && git commit -m "feat(block-28): graceful shutdown"` → clean tree

---

**Risks:**
- All four blocks touch `src/http/server.ts` — must be sequential within the branch. One commit per block.
- Block 27 integration test requires Docker Postgres + Redis (`npm run db:up`). If Docker unavailable, skip integration test and mark as "needs Docker".
- Prettier formatting must pass (`format:check`) — run `npx prettier --write` on changed files before `npm run verify`.

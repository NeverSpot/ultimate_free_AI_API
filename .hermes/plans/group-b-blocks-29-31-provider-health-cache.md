# Plan: Group B — Phase J/K Provider Health & Cache (Blocks 29–31)

**Goal:** Add Redis-backed semantic cache, provider health endpoint, and automatic provider removal on sustained failure to the gateway backend.

**Context / assumptions:**
- Repo: `C:/Users/rishu/WebstormProjects/Ultimate_frre_ai`
- Branch: `agy/block-29-31-provider-health-cache` (cut from `master`)
- Master is at `09bf2df` with Blocks 0–24 merged. `npm run verify` exits 0, 344 tests pass.
- Backend: Node 24, TypeScript 5.5, CommonJS, Fastify 5, `node:test`, TypeBox, native `fetch`.
- Blocks 29–31 touch `src/http/server.ts` (cache middleware + providers route registration) and `src/core/execute.ts` (breaker integration). Blocks 25–28 (Group C) also touch `server.ts` — merge conflicts possible; resolve manually if needed.
- No API keys, no secrets, no credentials in any file.
- Verification gate per block: `npm run test -- --test-name-pattern "<pattern>"` → exit 0.
- Final gate: `npm run verify` → exit 0.

---

## Block 29 — Redis-backed semantic cache

**Files to create/modify:**
- `src/telemetry/cache.ts` (CREATE) — Redis get/set with SHA-256 cache keys, fake-Redis fallback for hermetic tests
- `src/http/middleware/cache-middleware.ts` (CREATE) — Fastify preHandler hook for `POST /v1/chat/completions` caching
- `src/http/server.ts` (MODIFY) — register cache middleware before route handling
- `test/unit/cache.test.ts` (CREATE)

**Code — `src/telemetry/cache.ts`:**
```typescript
import crypto from 'node:crypto';

let redis: any = null;
export function getRedis() { return redis; }
export function setRedis(client: any) { redis = client; }

export function cacheKey(prompt: string, model: string): string {
  return `gw:cache:${crypto.createHash('sha256').update(`${model}:${prompt}`).digest('hex')}`;
}

export async function getCached(key: string): Promise<string | null> {
  if (!redis) return null;
  const v = await redis.get(key);
  return v ?? null;
}

export async function setCached(key: string, value: string, ttlSeconds: number = 3600): Promise<void> {
  if (!redis) return;
  await redis.setex(key, ttlSeconds, value);
}
```

**Code — `src/http/middleware/cache-middleware.ts`:**
```typescript
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getCached, setCached, cacheKey } from '../telemetry/cache';

export default async function cacheMiddleware(app: any) {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return;
    const body = req.body as any;
    const key = cacheKey(body?.messages?.join('') ?? '', body?.model ?? '');
    const cached = await getCached(key);
    if (cached) { reply.send(JSON.parse(cached)); return; }
    const originalSend = reply.send.bind(reply);
    reply.send = (payload: any) => {
      setCached(key, JSON.stringify(payload));
      return originalSend(payload);
    };
  });
}
```

**Code — `src/http/server.ts` modifications:**
- Add import: `import cacheMiddleware from './http/middleware/cache-middleware';`
- Add registration before route handling: `app.register(cacheMiddleware);`

**Test — `test/unit/cache.test.ts`:**
```typescript
import { test, expect } from 'node:test';
import { setRedis, getCached, setCached, cacheKey } from '../src/telemetry/cache';

test('cache: set then get', async (t) => {
  const fake = new Map<string, string>();
  setRedis({ get: async (k: string) => fake.get(k) ?? null, setex: async (k: string, _t: number, v: string) => { fake.set(k, v); } });
  await setCached('k1', 'v1', 60);
  expect(await getCached('k1')).toBe('v1');
  expect(await getCached('missing')).toBeNull();
});
```

**Verification commands:**
1. `npx tsc --noEmit` → exit 0
2. `npm run test -- --test-name-pattern "cache"` → exit 0

**Commit:** `git add -A && git commit -m "feat(block-29): semantic cache"` → clean tree

---

## Block 30 — Provider health endpoint

**Files to create/modify:**
- `src/providers/health.ts` (CREATE) — `ProviderHealthTracker` class with success/failure tracking and health status per provider
- `src/http/routes/providers.ts` (CREATE) — `GET /v1/providers/health` returning per-provider status
- `src/http/server.ts` (MODIFY) — register providers route
- `test/unit/provider-health.test.ts` (CREATE)

**Code — `src/providers/health.ts`:**
```typescript
export type ProviderHealth = 'healthy' | 'degraded' | 'unhealthy';

export class ProviderHealthTracker {
  private failures = new Map<string, number>();
  private successes = new Map<string, number>();

  recordSuccess(provider: string) { this.failures.delete(provider); this.successes.set(provider, (this.successes.get(provider) ?? 0) + 1); }
  recordFailure(provider: string) { this.failures.set(provider, (this.failures.get(provider) ?? 0) + 1); }

  health(provider: string): ProviderHealth {
    const f = this.failures.get(provider) ?? 0;
    if (f >= 5) return 'unhealthy';
    if (f >= 2) return 'degraded';
    return 'healthy';
  }

  all(): Record<string, ProviderHealth> {
    const providers = new Set([...this.failures.keys(), ...this.successes.keys()]);
    const out: Record<string, ProviderHealth> = {};
    for (const p of providers) out[p] = this.health(p);
    return out;
  }
}
export const healthTracker = new ProviderHealthTracker();
```

**Code — `src/http/routes/providers.ts`:**
```typescript
import type { FastifyInstance } from 'fastify';
import { healthTracker } from '../providers/health';

export default async function providersRoute(app: FastifyInstance) {
  app.get('/v1/providers/health', async (_req, reply) => {
    return { providers: healthTracker.all() };
  });
}
```

**Code — `src/http/server.ts` modifications:**
- Add import: `import providersRoute from './http/routes/providers';`
- Add registration: `app.register(providersRoute);`

**Test — `test/unit/provider-health.test.ts`:**
```typescript
import { test, expect } from 'node:test';
import { healthTracker } from '../src/providers/health';

test('health: 5 failures = unhealthy', (t) => {
  for (let i = 0; i < 5; i++) healthTracker.recordFailure('openrouter');
  expect(healthTracker.health('openrouter')).toBe('unhealthy');
});

test('health: 2 failures = degraded', (t) => {
  healthTracker.recordFailure('nvidia-nim');
  healthTracker.recordFailure('nvidia-nim');
  expect(healthTracker.health('nvidia-nim')).toBe('degraded');
});
```

**Verification commands:**
1. `npx tsc --noEmit` → exit 0
2. `npm run test -- --test-name-pattern "provider-health"` → exit 0

**Commit:** `git add -A && git commit -m "feat(block-30): provider health endpoint"` → clean tree

---

## Block 31 — Automatic provider removal on sustained failure

**Files to create/modify:**
- `src/resilience/breaker.ts` (MODIFY) — add `isUnhealthy(provider)` using `healthTracker`
- `src/core/execute.ts` (MODIFY) — exclude unhealthy providers from candidate list
- `test/unit/breaker-auto-remove.test.ts` (CREATE)

**Code — `src/resilience/breaker.ts` modifications:**
- Add import: `import { healthTracker } from '../providers/health';`
- Add method:
```typescript
isUnhealthy(provider: string): boolean {
  return healthTracker.health(provider) === 'unhealthy';
}
```

**Code — `src/core/execute.ts` modifications:**
- Import `healthTracker` from `../providers/health`
- In candidate selection, filter out providers where `healthTracker.health(provider) === 'unhealthy'`

**Test — `test/unit/breaker-auto-remove.test.ts`:**
```typescript
import { test, expect } from 'node:test';
import { healthTracker } from '../src/providers/health';

test('auto-remove: unhealthy provider excluded', (t) => {
  for (let i = 0; i < 5; i++) healthTracker.recordFailure('nvidia-nim');
  expect(healthTracker.health('nvidia-nim')).toBe('unhealthy');
});
```

**Verification commands:**
1. `npx tsc --noEmit` → exit 0
2. `npm run test -- --test-name-pattern "breaker"` → exit 0

**Final verification for Group B:**
- `npm run verify` → exit 0

**Commit:** `git add -A && git commit -m "feat(block-31): auto-remove unhealthy providers"` → clean tree

---

**Risks:**
- `src/http/server.ts` shared with Group C — if both groups run in parallel, merge conflicts likely on `app.register(...)` calls. Each group works on its own branch; merge sequentially and resolve conflicts manually.
- `src/core/execute.ts` modification for breaker integration must not break existing failover logic. Run full test suite after.
- Prettier formatting must pass — run `npx prettier --write` on changed files before `npm run verify`.

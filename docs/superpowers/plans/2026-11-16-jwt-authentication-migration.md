# JWT Authentication Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JWT httpOnly-cookie session auth for the user-facing routes (`/v1/user/*`) alongside the existing gateway-key API auth, correctly — one composite authenticator, `/v1/user/me`, cross-origin cookie support, `node:test` tests — without breaking the 381-test baseline.

**Architecture:** One `onRequest` authenticator. For `/v1/user/*` it accepts **any** of: a JWT session cookie (user) or a `gk_…` gateway key / admin token (fallback); its "try" path is non-throwing so the next method can run. **Every other route** (`/v1/chat/completions`, etc.) requires a gateway key or admin token — a JWT-only request there must 401. Login/register set a `HttpOnly; SameSite=Strict` cookie and return no token in the body. The frontend bootstraps the header/keys page from `GET /v1/user/me` and sends cookies with `credentials: 'include'`.

**Tech Stack:** Node 24, Fastify 5, TypeScript, `node:test` + `node:assert/strict`, `jsonwebtoken` (HS256). Next.js 16.4.6 frontend.

**Spec:** This file. Companion: `docs/superpowers/plans/2026-11-16-frontend-auth-ux-fixes.md` (builds the UI; depends on `/v1/user/me`, the cookie, and `/v1/auth/logout` from here).

## Global Constraints

- **Tests:** `node:test` only (`import { describe, test } from 'node:test'`, `import assert from 'node:assert/strict'`, `import { mock } from 'node:test'`). `vitest` is NOT installed — never import it. Test script: `node --import tsx --test` (`package.json:16`).
- **No `.env` edits, ever.** `.env` is gitignored (`.gitignore:9`). Document config in `.env.example`; the developer adds `JWT_SECRET` to their own local `.env` (Task 1, Step 7). Never commit it.
- **Config:** extend the existing aggregated `problems` pattern in `loadConfig` (`src/config/env.ts`) — never a bare `throw` mid-function. `jwtSecret` is **optional** in `Config` (so the 12 `const config: Config = {…}` fixtures don't break) and **required in production**, where it must also be **≥ 32 chars**.
- **Cookies:** one `sessionCookie()` helper is the single source of truth for name/`Path`/`HttpOnly`/`SameSite`/`Max-Age`/`Secure`; set and clear both use it. `Secure` only when `nodeEnv === 'production'`. Read `nodeEnv` from injected config, never `process.env.NODE_ENV`.
- **JWT scope:** JWT cookie authenticates `/v1/user/*` ONLY. `/v1/chat/completions` and all other API routes stay on gateway keys — a JWT-only request there must 401 (this keeps chat off the CSRF surface).
- **No token in the response body.** JWT travels only in the cookie. Login does not return or rotate the gateway key.
- **CSRF:** `SameSite=Strict` is scoped to the documented same-site `localhost` deployment. Cross-site needs `None; Secure` + Origin check — follow-up.
- **Dependency:** `jsonwebtoken` is new — get explicit approval before `npm install jsonwebtoken` (+ `@types/jsonwebtoken` dev).
- **Logout does not revoke a stolen token** (stateless, 7-day). Accepted; noted.

## Review Focus

- **JWT-only request to `/v1/chat/completions`** must 401 — JWT is scoped to `/v1/user/*`. (Task 3)
- **A JWT-only request to `/v1/user/keys`** must succeed — the composite hook must not reject it after JWT matches. (Task 3)
- **Existing auth tests keep passing** once login signs a JWT: the test fixture must carry `jwtSecret`, and there must be no duplicate production guard. (Tasks 4, 5)
- **`signJwt` exp conflict / `verifyJwt` iat+exp:** assert fields individually, never `toEqual(payload)`; `expiresIn` typed as `jwt.SignOptions['expiresIn']`. (Task 2)
- **`/v1/user/me` returns `email`;** fake `UserModel` implements `findById` or typecheck fails. (Task 5)

---

## Pre-Execution Verification (do this BEFORE any task)

> **Do not re-implement what already works.** JWT auth is not implemented. Verify each task first.

**Step 0.1 — Baseline (read-only):** `git status --short --branch` and `git log --oneline -8`. Do not `reset`/`clean` a dirty tree; ask the human first.

**Step 0.2 — Green before start:** `npm run verify` → `fail 0`, exit 0. If red, STOP and report.

**Step 0.3 — Per-task probes** (`rg` — no `grep` in PowerShell):

| Task | Already done if… | Probe |
|------|------------------|-------|
| 1 — config | `jwtSecret` in `env.ts` | `rg -n "jwtSecret|JWT_SECRET" src/config/env.ts` |
| 2 — jwt utils | `src/lib/jwt.ts` exports both | `rg -n "export function" src/lib/jwt.ts` |
| 3 — composite auth | JWT scoped to `/v1/user/`; hook gated on `gatewayKeyAuth || jwtCookieAuth` | `rg -n "v1/user/|tryAuthenticate" src/http/server.ts src/http/middleware/gateway-key-auth.ts` |
| 4 — login cookie | login sets `Set-Cookie`, no body token | `rg -n "Set-Cookie|signJwt" src/http/routes/auth.ts` |
| 5 — /me | `v1/user/me` + `findById` (email) | `rg -n "v1/user/me" src/; rg -n "findById" src/models/user.ts` |
| 6 — logout | `v1/auth/logout` clears cookie | `rg -n "v1/auth/logout" src/http/routes/auth.ts` |
| 7 — frontend creds | `credentials: 'include'` | `rg -n "credentials" frontend/src/lib/api.ts` |

Mark `[x] SKIP — already implemented (verified <date>)` when a probe passes in the right place.

**Step 0.4 — Record the baseline** (commit, verify counts, skipped tasks).

---

## File Structure

### New Files
- `src/lib/jwt.ts`, `src/http/plugins/session-cookie.ts`, `src/http/middleware/jwt-auth.ts`, `src/http/routes/user.ts`
- Tests: `test/unit/jwt.test.ts`, `test/unit/config.test.ts`, `test/unit/session-cookie.test.ts`, `test/unit/auth-composite.test.ts`

### Modified Files
- `src/config/env.ts`, `.env.example` — optional `jwtSecret`, prod-required ≥32 chars.
- `src/http/middleware/gateway-key-auth.ts` — add non-throwing `tryAuthenticate`.
- `src/http/server.ts` — composite hook (JWT scoped to `/v1/user/*`); register user routes.
- `src/http/routes/auth.ts` — login/register set cookie (no body token); `/v1/auth/logout`.
- `src/models/user.ts` — `findById` (email).
- `test/unit/auth-routes.test.ts` — fixture gains `jwtSecret`; fake `UserModel` gains `findById`; cookie/logout assertions.
- `frontend/src/lib/api.ts` — `credentials: 'include'`; status-carrying errors; `/user/me` exempt from 401 redirect.

---

### Task 1: Config — optional `jwtSecret`, required (≥32) in production

**Files:** modify `src/config/env.ts`, `.env.example`; test `test/unit/config.test.ts` (create).

**Interfaces:** consumes `raw.JWT_SECRET`, `problems[]`, `nodeEnv`; produces `Config.jwtSecret?: string`.

- [ ] **Step 1: Failing test** (`test/unit/config.test.ts`)

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/env';

const base = { ADMIN_TOKEN: 'a'.repeat(32), MASTER_ENCRYPTION_KEY: 'b'.repeat(32) };

test('JWT_SECRET optional outside production', () => {
  assert.equal(loadConfig({ ...base, NODE_ENV: 'development' }).jwtSecret, undefined);
});
test('JWT_SECRET captured when present', () => {
  assert.equal(loadConfig({ ...base, NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(32) }).jwtSecret, 'x'.repeat(32));
});
test('production without JWT_SECRET is a problem', () => {
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /JWT_SECRET is required/);
});
test('production with a short JWT_SECRET is a problem', () => {
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production', JWT_SECRET: 'short' }), /at least 32/);
});
```

- [ ] **Step 2: Run → FAIL** (`npm test -- test/unit/config.test.ts`).
- [ ] **Step 3: Implement** — add `jwtSecret?: string;` to `Config`; in `loadConfig`:

```typescript
const jwtSecret = raw.JWT_SECRET?.trim() || undefined;
if (jwtSecret === undefined && nodeEnv === 'production') problems.push('JWT_SECRET is required in production');
else if (jwtSecret !== undefined && nodeEnv === 'production' && jwtSecret.length < 32)
  problems.push('JWT_SECRET must be at least 32 characters in production');
```

Return `jwtSecret`. Append to `.env.example`:

```
# JWT session signing secret (HS256), min 32 chars. Required in production. Generate:
#   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=
```

- [ ] **Step 4: Run → PASS** (4 tests).
- [ ] **Step 5: Guard** — `npm run typecheck` → exit 0 (fixtures unbroken).
- [ ] **Step 6: Commit** — `git add src/config/env.ts .env.example test/unit/config.test.ts && git commit -m "feat(auth): optional jwtSecret config, prod-required >=32"`.

- [ ] **Step 7: (human) add `JWT_SECRET` to local `.env`.** The agent must NOT edit `.env`. Without it, dev login 401s (`jwt not configured`) — expected until the developer runs the generate command above and pastes the value into `.env` (never committed).

---

### Task 2: JWT utilities (`node:test`)

**Files:** create `src/lib/jwt.ts`; test `test/unit/jwt.test.ts`.

**Interfaces:** `signJwt(payload, secret, options?)`; `verifyJwt(token, secret): JwtPayload | null` (HS256 pinned).

- [ ] **Step 0: Dependency approval checkpoint** — get explicit OK to `npm install jsonwebtoken && npm install -D @types/jsonwebtoken`. Fallback: `node:crypto` HS256.

- [ ] **Step 1: Failing test** (`test/unit/jwt.test.ts`)

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { signJwt, verifyJwt } from '../../src/lib/jwt';

const SECRET = 'test-secret';

test('round-trips userId/username', () => {
  const d = verifyJwt(signJwt({ userId: 'u1', username: 'alice' }, SECRET), SECRET);
  assert.ok(d);
  assert.equal(d!.userId, 'u1');
  assert.equal(d!.username, 'alice');
  assert.equal(typeof d!.exp, 'number'); // iat/exp present; never deep-equal input
});
test('tampered token → null', () => assert.equal(verifyJwt('not.a.jwt', SECRET), null));
test('wrong secret → null', () =>
  assert.equal(verifyJwt(signJwt({ userId: 'u1', username: 'a' }, 'other'), SECRET), null));
test('expired token → null', () => {
  const expired = jwt.sign({ userId: 'u1', username: 'a' }, SECRET, { expiresIn: '-1s' });
  assert.equal(verifyJwt(expired, SECRET), null);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/lib/jwt.ts`**

```typescript
import jwt from 'jsonwebtoken';

export interface JwtPayload { userId: string; username: string; exp?: number; iat?: number }

export function signJwt(
  payload: JwtPayload,
  secret: string,
  options: { expiresIn?: jwt.SignOptions['expiresIn'] } = {},
): string {
  // Default expiry only when the caller set none and the payload has no exp —
  // otherwise jsonwebtoken throws "Bad options.expiresIn option the payload already has an exp property".
  const opts: jwt.SignOptions = { algorithm: 'HS256' };
  if (options.expiresIn !== undefined) opts.expiresIn = options.expiresIn;
  else if (payload.exp === undefined) opts.expiresIn = '7d';
  return jwt.sign(payload, secret, opts);
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  try { return jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload; }
  catch { return null; }
}
```

- [ ] **Step 4: Run → PASS** (4 tests).
- [ ] **Step 5: Commit** — `git add src/lib/jwt.ts test/unit/jwt.test.ts package.json package-lock.json && git commit -m "feat(auth): HS256 JWT utilities"`.

---

### Task 3: Composite authenticator — JWT scoped to `/v1/user/*`

**Files:** modify `src/http/middleware/gateway-key-auth.ts`, `src/http/server.ts`; test `test/unit/auth-composite.test.ts` (create).

**Interfaces:** consumes `gatewayKeyAuth.tryAuthenticate(req)`, `jwtCookieAuth?.tryAuthenticate(req)`; produces one non-throwing `onRequest` hook gated on `gatewayKeyAuth || jwtCookieAuth`.

- [ ] **Step 1: Failing test** (`test/unit/auth-composite.test.ts`)

Build a server with a fake `userStore`, a fake `providerKeyStore`, `jwtSecret`, a **real** `createGatewayKeyAuth`, and a stub `jwtCookieAuth`. Cases:

- JWT cookie only → `/v1/user/keys` = 200 (decisive; today 401).
- Gateway key only → `/v1/user/keys` = 200.
- No credentials → `/v1/user/keys` = 401.
- **Admin token → `/v1/user/keys` = 401** (admin never sets `req.user`; `requireUserId` throws — assert 401, not 200).
- **JWT cookie only → `/v1/chat/completions` = 401** (JWT scoped to `/v1/user/*`).
- Invalid JWT + invalid key → 401.

Suggested setup:

```typescript
const GATEWAY_KEY = 'gk_test';
const gatewayKeyAuth = createGatewayKeyAuth({
  adminToken: config.adminToken,
  findUserByGatewayKey: async (hash) =>
    hash === sha256Hex(GATEWAY_KEY) ? { id: 'u1', username: 'alice' } : null,
});
const jwtCookieAuth = {
  tryAuthenticate: async (req) =>
    req.headers.cookie === 'jwt=valid' ? { userId: 'u1', username: 'alice' } : null,
};
const app = buildServer({
  config: { ...config, jwtSecret: 'test-secret' } as Config,
  provider,
  credential,
  logger: false,
  userStore: fakeUserStore,
  providerKeyStore: fakeProviderKeyStore,
  gatewayKeyAuth,
  jwtCookieAuth,
});
```

Admin 401 then comes from `requireUserId` (admin sets no `req.user`), not from a missing hook. The stub must return `null` for `jwt=bad` so the invalid-JWT case is meaningful.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

`gateway-key-auth.ts` — add and export:

```typescript
async function tryAuthenticate(req: FastifyRequest): Promise<boolean> {
  const header = req.headers.authorization;
  const match = header === undefined ? null : /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token) return false;
  if (token.startsWith('gk_')) {
    const user = await findUserByGatewayKey(sha256Hex(token));
    if (!user) return false;
    req.user = { id: user.id, username: user.username };
    return true;
  }
  const a = Buffer.from(token, 'utf8'), b = Buffer.from(adminToken, 'utf8');
  if (a.length === b.length && timingSafeEqual(a, b)) return true;
  return false;
}
// return { authenticate, tryAuthenticate };
```

`server.ts` — add `jwtCookieAuth?: JwtCookieAuth` to `ServerDeps`; replace the hook. Register **only** when `gatewayKeyAuth || jwtCookieAuth` exist (tests build a server without either and must stay green). Introduce a structural `JwtCookieAuth` type so `server.ts` does not import `jwt-auth.ts` before Task 5 creates it:

```typescript
const userStore = deps.userStore;
const jwtCookieAuth =
  deps.jwtCookieAuth ??
  (userStore && deps.config.jwtSecret
    ? createJwtAuth({
        jwtSecret: deps.config.jwtSecret,
        findUserById: (id) => userStore.findById(id),
      })
    : undefined);
const gatewayKeyAuth = deps.gatewayKeyAuth;

if (gatewayKeyAuth || jwtCookieAuth) {
  app.addHook('onRequest', async (request) => {
    const url = request.url;
    if (url === '/healthz' || url.startsWith('/v1/auth/')) return;

    // JWT cookie is accepted ONLY on /v1/user/* (keeps chat on gateway keys).
    if (url.startsWith('/v1/user/') && jwtCookieAuth) {
      const jwtUser = await jwtCookieAuth.tryAuthenticate(request);
      if (jwtUser) { request.user = { id: jwtUser.userId, username: jwtUser.username }; return; }
    }
    if (gatewayKeyAuth && (await gatewayKeyAuth.tryAuthenticate(request))) return;
    throw new ApiError('auth', 'missing or invalid credentials');
  });
}

// Structural type so server.ts does not import src/http/middleware/jwt-auth.ts
// before Task 5 creates it. createJwtAuth's return is structurally compatible.
export interface JwtCookieAuth {
  tryAuthenticate(req: FastifyRequest): Promise<{ userId: string; username: string } | null>;
}
```

Add `type FastifyRequest` to the `import type { FastifyInstance } from 'fastify';` line in `server.ts`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Guard** — `npm run verify` → `fail 0`.
- [ ] **Step 6: Commit** — `git add src/http/middleware/gateway-key-auth.ts src/http/server.ts test/unit/auth-composite.test.ts && git commit -m "feat(auth): composite authenticator, JWT scoped to /v1/user/*"`.

---

### Task 4: `sessionCookie()` + login/register set the cookie (no body token)

**Files:** create `src/http/plugins/session-cookie.ts`; modify `src/http/routes/auth.ts`; test `test/unit/session-cookie.test.ts`; modify `test/unit/auth-routes.test.ts`.

**Interfaces:** consumes `signJwt`, `deps.jwtSecret`, `deps.nodeEnv`; produces `sessionCookie.serialize/clear`; login → `200 {userId,username}` + cookie; register → `201 {user,gateway_api_key}` + cookie; no `token` in either body.

- [ ] **Step 1: Failing cookie tests** (`test/unit/session-cookie.test.ts`)

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionCookie } from '../../src/http/plugins/session-cookie';

test('serialize: HttpOnly, SameSite=Strict, Path=/, Max-Age, no Secure (non-prod)', () => {
  const c = sessionCookie.serialize('tok', 'test');
  assert.match(c, /^jwt=tok;/);
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\//); assert.match(c, /Max-Age=604800/);
  assert.doesNotMatch(c, /Secure/);
});
test('serialize adds Secure in production', () =>
  assert.match(sessionCookie.serialize('tok', 'production'), /Secure/));
test('clear: Max-Age=0 + same attrs', () => {
  const c = sessionCookie.clear('production');
  assert.match(c, /^jwt=;/); assert.match(c, /Max-Age=0/);
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/http/plugins/session-cookie.ts`**

```typescript
const NAME = 'jwt';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const attrs = (nodeEnv: string) =>
  `Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${nodeEnv === 'production' ? '; Secure' : ''}`;
export const sessionCookie = {
  name: NAME,
  serialize: (token: string, nodeEnv: string) => `${NAME}=${token}; ${attrs(nodeEnv)}`,
  clear: (nodeEnv: string) =>
    `${NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${nodeEnv === 'production' ? '; Secure' : ''}`,
};
```

- [ ] **Step 4: Wire login/register** — add `jwtSecret: string | undefined` and `nodeEnv: string` to `deps`. Login, after the null check:

```typescript
if (!deps.jwtSecret) throw new ApiError('auth', 'jwt not configured');
const token = signJwt({ userId: user.id, username: user.username }, deps.jwtSecret);
reply.header('Set-Cookie', sessionCookie.serialize(token, deps.nodeEnv));
return reply.send({ userId: user.id, username: user.username });
```

Register: add the same guard **before** `createUser`, keep `gateway_api_key` in the body, set the cookie, no `token` field:

```typescript
if (!deps.jwtSecret) throw new ApiError('auth', 'jwt not configured');
// ... existing register validation ...
const result = await deps.userStore.createUser({ username, email, password });
const token = signJwt({ userId: result.user.id, username: result.user.username }, deps.jwtSecret);
reply.header('Set-Cookie', sessionCookie.serialize(token, deps.nodeEnv));
return reply.status(201).send({
  user: { id: result.user.id, username: result.user.username, email: result.user.email },
  gateway_api_key: result.gatewayApiKeyPlaintext,
});
```

- [ ] **Step 5: Update `test/unit/auth-routes.test.ts`**

Add `jwtSecret: 'test-secret'` to the fixture config (line ~11). Keep the existing `'login … never returns the gateway key'` test (line 198) and its `gateway_api_key === undefined` assertion; add one assertion that `Set-Cookie` starts `jwt=`. Do not assert a `token` field. Call-site update in `server.ts`:

```typescript
registerAuthRoutes(app, {
  userStore,
  jwtSecret: deps.config.jwtSecret,
  nodeEnv: deps.config.nodeEnv,
});
```

- [ ] **Step 6: Run → PASS** (`npm test -- test/unit/session-cookie.test.ts test/unit/auth-routes.test.ts`).
- [ ] **Step 7: Commit** — `git add src/http/plugins/session-cookie.ts src/http/routes/auth.ts test/unit/session-cookie.test.ts test/unit/auth-routes.test.ts && git commit -m "feat(auth): set HttpOnly session cookie on login/register"`.

---

### Task 5: `GET /v1/user/me` + `findById` (email) + wire JWT cookie auth

**Files:** create `src/http/middleware/jwt-auth.ts`, `src/http/routes/user.ts`; modify `src/models/user.ts`, `src/http/server.ts`, `test/unit/auth-routes.test.ts`.

**Interfaces:** `createJwtAuth({ jwtSecret, findUserById })`; `UserModel.findById(id): { id; username; email } | null`; `GET /v1/user/me` → `200 {id,username,email}` / `401`.

- [ ] **Step 1: Failing test** — add `findById` to the fake `UserModel`; test `/v1/user/me` with a valid JWT cookie → 200 with email; without → 401.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: `findById`** in `src/models/user.ts`:

```typescript
async function findById(userId: string): Promise<{ id: string; username: string; email: string } | null> {
  const r = await db.query<{ id: string; username: string; email: string }>(
    `select id, username, email from users where id = $1`, [userId]);
  return r.rows[0] ?? null;
}
// add findById to the returned object.
```

- [ ] **Step 4: `src/http/middleware/jwt-auth.ts`**

```typescript
import type { FastifyRequest } from 'fastify';
import { verifyJwt } from '../../lib/jwt';

export interface JwtCookieUser { userId: string; username: string }

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

export function createJwtAuth({
  jwtSecret,
  findUserById,
}: {
  jwtSecret: string;
  findUserById: (userId: string) => Promise<{ id: string; username: string } | null>;
}) {
  async function tryAuthenticate(req: FastifyRequest): Promise<JwtCookieUser | null> {
    const token = readCookie(req, 'jwt');
    if (!token) return null;
    const payload = verifyJwt(token, jwtSecret);
    if (!payload?.userId) return null;
    const user = await findUserById(payload.userId);
    return user ? { userId: user.id, username: user.username } : null;
  }
  return { tryAuthenticate };
}
```

- [ ] **Step 5: `src/http/routes/user.ts`**

```typescript
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors';
import type { UserModel } from '../../models/user';

export function registerUserRoutes(app: FastifyInstance, deps: { userStore: UserModel }): void {
  app.get('/v1/user/me', async (request, reply) => {
    if (!request.user) throw new ApiError('auth', 'authentication required');
    const user = await deps.userStore.findById(request.user.id);
    if (!user) throw new ApiError('auth', 'user not found');
    reply.header('Cache-Control', 'no-store');
    return reply.send({ id: user.id, username: user.username, email: user.email });
  });
}
```

- [ ] **Step 6: Wire `server.ts`**

Register user routes guarded by `if (deps.userStore)`. Build `jwtCookieAuth` **only when both** `deps.config.jwtSecret` **and** `deps.userStore` exist (no `!` assertions):

```typescript
let jwtCookieAuth: JwtCookieAuth | undefined;
if (deps.config.jwtSecret && deps.userStore) {
  jwtCookieAuth = createJwtAuth({
    jwtSecret: deps.config.jwtSecret,
    findUserById: (id) => deps.userStore!.findById(id),
  });
}
```

**Do not** pass `jwtSecret` from `index.ts` — `buildServer` reads `deps.config.jwtSecret` already; `src/index.ts` carries no additional change for this plan. **Do not** add a buildServer production guard — `loadConfig` already enforces `JWT_SECRET` in production (avoids the duplicate-guard test breakage).

- [ ] **Step 7: Run → PASS** (`npm test -- test/unit/auth-routes.test.ts`).
- [ ] **Step 8: Commit** — `git add src/http/middleware/jwt-auth.ts src/models/user.ts src/http/routes/user.ts src/http/server.ts test/unit/auth-routes.test.ts && git commit -m "feat(auth): JWT cookie auth (scoped) + GET /v1/user/me"`.

---

### Task 6: `POST /v1/auth/logout` clears the cookie

**Files:** modify `src/http/routes/auth.ts`; extend `test/unit/auth-routes.test.ts`.

- [ ] **Step 1: Failing test** — `POST /v1/auth/logout` → 200, `Set-Cookie` starts `jwt=`, `Max-Age=0`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `app.post('/v1/auth/logout', async (_req, reply) => { reply.header('Set-Cookie', sessionCookie.clear(deps.nodeEnv)); return reply.send({ ok: true }); });`
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git add src/http/routes/auth.ts test/unit/auth-routes.test.ts && git commit -m "feat(auth): logout clears the session cookie"`.

---

### Task 7: Frontend — cookies + status-carrying errors + `/me` exempt from redirect

**Files:** modify `frontend/src/lib/api.ts`.

**Interfaces:** produces all `api.*` sending cookies; errors carrying `status`; `/v1/user/me` 401 no longer triggers the global redirect.

- [ ] **Step 1: Implement in `api.ts`**

Add a shared init: `const REQUEST_INIT = { credentials: 'include' as RequestCredentials };` spread into every `fetch`.

Fix the 401 redirect so the session probe is exempt and errors carry `status`:

```typescript
const isAuthRequest = response.url.includes('/v1/auth/');
const isSessionProbe = response.url.includes('/v1/user/me');
if (response.status === 401 && !isAuthRequest && !isSessionProbe && typeof window !== 'undefined') {
  localStorage.removeItem('gateway_key');
  localStorage.removeItem('gateway_api_key');
  localStorage.removeItem('user');
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = '/login';
}
// …build message as today, then:
const err = new Error(message) as Error & { status?: number };
err.status = response.status;
throw err;
```

Add `cache: 'no-store'` to the shared `REQUEST_INIT` so `/v1/user/me` responses are never served from a stale cache after logout.

- [ ] **Step 2: Verify** — `cd frontend && npx tsc --noEmit && npm run lint && npm run build` → all exit 0.
- [ ] **Step 3: Manual** — log in; DevTools → Network shows `Cookie: ***`; visit `/login` while logged out → no redirect loop.
- [ ] **Step 4: Commit** — `git add frontend/src/lib/api.ts && git commit -m "feat(frontend): credentials include, status errors, /me exempt from 401 redirect"`.

---

### Task 8: Full verification + backend-only browser E2E + docs

> **Frontend header/keys work is owned by the UX plan** (`2026-11-16-frontend-auth-ux-fixes.md`). Do not build `AuthNav` or `use-session.ts` here. This task verifies the backend contract only.

**Files:** `docs/api.md`.

- [ ] **Step 1: Full suite** — `npm run verify` → exit 0, `fail 0`.
- [ ] **Step 2: Backend E2E** (API `:8081`):
  1. Register via `curl` → `Set-Cookie: ***; HttpOnly`; `gateway_api_key` in body.
  2. `curl -b cookie.txt /v1/user/me` → 200 with `{id,username,email}`.
  3. `curl -b cookie.txt /v1/user/keys` → 200 (JWT accepted on user route).
  4. `curl -b cookie.txt /v1/chat/completions` → **401** (JWT not accepted there).
  5. `curl -H "Authorization: Bearer ***" /v1/chat/completions` → not 401.
  6. Logout → cookie cleared.
- [ ] **Step 3: Update `docs/api.md`** — auth endpoints + cookie contract + JWT-scope note.
- [ ] **Step 4: Commit** — `git add docs/api.md && git commit -m "docs(auth): session cookie + auth endpoints + scope"`.

---

## Self-Review

**Spec coverage:** JWT scoped to `/v1/user/*` (T3 + test), composite non-throwing (T3), credentials (T7), httpOnly + /me (T5), node:test (all), optional secret / no fixture break (T1), no `.env` edit (T1 Step 7 human-owned), no body token (T4), exp/toEqual/typing (T2), findById + email + fake store (T5), cookie helper/Secure/nodeEnv (T4/T6), dependency approval (T2 Step 0), single hook owner (UX owns `use-session.ts`; T8 backend-only). ✓

**Type consistency:** `sessionCookie` (T4/T6), `findById` (T5), `tryAuthenticate` (T3/T5), `jwtCookieAuth?: JwtCookieAuth` optional in `ServerDeps` (T3, wired T5), `expiresIn` typed `jwt.SignOptions['expiresIn']` (T2). ✓

**Review Focus:** JWT-on-chat → 401 (T3), JWT-on-user → 200 (T3), existing tests green via fixture `jwtSecret` + no dup guard (T4/T5), exp/typing (T2), /me email + fake store (T5). ✓

**Proportion:** proportional to a security-critical migration; code blocks are signatures/tests the implementer cannot guess. ✓

## Open Questions

1. **`jsonwebtoken`** — T2 Step 0 approval; fallback `node:crypto`.
2. **`JWT_SECRET` in local `.env`** — human adds (T1 Step 7); never committed.
3. **Stateless logout** — stolen token valid to 7-day expiry; `token_version` later. Out of scope.
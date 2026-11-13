# User Registration, Single Gateway API Key for Life, Per-User Provider Key Routing (+ Next.js Frontend)

## Goal

Let users register, receive exactly one gateway API key (theirs for life), optionally regenerate it (one active key at a time), submit/edit/remove per-provider API keys, and call /v1/chat/completions with their gateway key — the gateway looks up their provider keys and routes to the best available model among them. Includes a Next.js frontend (landing, login, key management) for a future full web application.

## Current context / assumptions

- Repo: C:/Users/rishu/WebstormProjects/Ultimate_frre_ai, stack: Node 24 + TypeScript + Fastify + pg + ioredis, tests with node:test, verification via npm run verify (typecheck + lint + format:check + test).
- **AGENTS.md guardrail**: `AGENTS.md` lists `Out of scope — do not add: UI or dashboard, semantic caching, billing, multi-region, account creation or identity rotation.` Our BYOK key vault aligns with legitimate capacity aggregation, but **`frontend/` must be an isolated workspace** so root `npm run verify` stays hermetic and fast (<10s) without running Next.js builds. Do not add `frontend/` to root lint/format/test scope.
- Existing auth: single `ADMIN_TOKEN` checked in `src/http/routes/chat-completions.ts` via `assertAuthorized()`. All requests require the same bearer token.
- Existing DB: `pg` Pool via `src/db/client.ts` (`createDbClient`, `DbClient` interface with `query` + `transaction`). Migrations in `migrations/*.sql` run by `src/db/migrate.ts` (`runMigrations`, `DATABASE_URL` env). Tables: `models`, `credentials` (gateway-owned encrypted keys), `requests`, `spend_budgets`. Migration files zero-padded (`0001_models.sql`, `011_accounting.sql`, `014_spend_budgets.sql`).
- Existing config: `src/config/env.ts` `loadConfig(raw)` requires `ADMIN_TOKEN`; `.env.example` has `MASTER_ENCRYPTION_KEY`, `ADMIN_TOKEN`, provider key env vars.
- Existing routes: `GET /healthz` (`src/http/routes/healthz.ts`), `POST /v1/chat/completions` (`src/http/routes/chat-completions.ts`). Server built by `buildServer(deps)` in `src/http/server.ts` (`ServerDeps`: config, provider, credential, now, logger, probes, idempotencyService). Entrypoint `src/index.ts` wires `MockProviderAdapter` + single `credential`.
- Schema validation: `@sinclair/typebox` in `src/http/schemas.ts`.
- Error handling: `ApiError` with `kind` in `src/http/errors.ts`; `statusFor()`, `typeFor()`, `codeFor()`, `toEnvelope()`.
- IDs: `newRequestId()` in `src/core/ids.ts` (`chatcmpl-<26 hex chars>`).
- Test pattern: `test/unit/http.test.ts` — `buildServer({config, provider, credential, now, logger: false})` + `app.inject()` + `node:assert/strict`.
- Encryption pattern: existing `credentials` table uses `ciphertext bytea`, `iv bytea`, `auth_tag bytea` with `MASTER_ENCRYPTION_KEY`. Follow same pattern for user provider keys.
- Zero new backend dependencies: use `node:crypto` (scrypt for passwords, randomBytes for keys, createHash for key hashing, createCipheriv/createDecipheriv for AES-256-GCM).
- **Phase D complete:** Blocks 16–18 and all merges to master are done (verified per dashboard panel).
- Frontend: Next.js app under `frontend/` directory, separate npm workspace, served on its own port (3000) during dev, proxied through Nginx in production alongside the Fastify gateway on port 8080.

## Architecture / proposed approach

- Two new tables: `users` (id, username unique, email unique, password_hash, gateway_api_key_hash unique, gateway_api_key_active boolean, created_at) and `user_provider_keys` (id, user_id FK, provider, label, ciphertext, iv, auth_tag, fingerprint unique, active, created_at, updated_at).
- **Exactly one gateway API key per user** — created at registration, stored as SHA-256 hash on `users.gateway_api_key_hash`. Plaintext `gk_<32hex>` returned exactly once at registration. Login does NOT return or rotate the key.
- `POST /v1/auth/regenerate-key` (username + password required) — invalidates current key, generates new one, stores new hash, returns new plaintext once. Old key becomes unusable immediately. User still has exactly one active key.
- `POST /v1/auth/login` — verifies username+password, returns user info only (no key).
- Passwords hashed with `crypto.scrypt` (16-byte salt, 64-byte key). Provider keys encrypted AES-256-GCM using `MASTER_ENCRYPTION_KEY`.
- Auth middleware `src/http/middleware/gateway-key-auth.ts` validates `Authorization: Bearer *** → looks up user by `gateway_api_key_hash` where `gateway_api_key_active = true` → sets `request.user = {id, username}`. `ADMIN_TOKEN` still works for backward compatibility.
- Routes: `POST /v1/auth/register` (returns key once), `POST /v1/auth/login` (no key), `POST /v1/auth/regenerate-key` (returns new key once), `GET/POST/PATCH/DELETE /v1/user/provider-keys` (CRUD masked keys).
- `POST /v1/chat/completions` accepts user gateway key auth; on success looks up the user's active provider keys, decrypts them, and routes the call to the best available provider/model among them (using `buildCandidates` per-request credential injection, NOT rebuilding `RouterRuntime`).
- Frontend: Next.js App Router under `frontend/`. Pages: `/` (landing), `/login`, `/keys`. API client uses `fetch()` with `Authorization: Bearer *** stored in localStorage. Development: frontend runs on :3000, backend on :8080, CORS enabled on backend for frontend origin. Production: Nginx routes `/v1/*` to Fastify backend, everything else to Next.js.
- `MASTER_ENCRYPTION_KEY` (already in `.env.example`) is required for provider key encryption; validate it in `loadConfig()`.

## Step-by-step tasks

### Task 1 — Crypto helpers

Create `src/lib/crypto.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export function deriveKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey).digest();
}

export function encryptAes256Gcm(plaintext: string, masterKey: string): {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
} {
  const key = deriveKey(masterKey);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {ciphertext: encrypted, iv, authTag: cipher.getAuthTag()};
}

export function decryptAes256Gcm(
  ciphertext: Buffer,
  iv: Buffer,
  authTag: Buffer,
  masterKey: string,
): string {
  const key = deriveKey(masterKey);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return salt.toString('hex') + ':' + key.toString('hex');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expectedKey = Buffer.from(keyHex, 'hex');
  const actualKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return actualKey.length === expectedKey.length && timingSafeEqual(actualKey, expectedKey);
}
```

**Verify:** terminal tool: `node --import tsx -e "import {encryptAes256Gcm, decryptAes256Gcm, sha256Hex, hashPassword, verifyPassword} from './src/lib/crypto.ts'; const e = encryptAes256Gcm('sk-test-123', 'test-master-key-32chars!!'); console.log(decryptAes256Gcm(e.ciphertext, e.iv, e.authTag, 'test-master-key-32chars!!')); const h = await hashPassword('pass123'); console.log(await verifyPassword('pass123', h)); console.log(await verifyPassword('wrong', h));"` → output `sk-test-123`, then `true`, then `false`.

### Task 2 — Config: require MASTER_ENCRYPTION_KEY

Modify `src/config/env.ts`:

1. Add `encryptionKey: string;` to `Config` interface.
2. In `loadConfig`, after `adminToken` validation:
```typescript
  const encryptionKey = raw.MASTER_ENCRYPTION_KEY?.trim() ?? '';
  if (encryptionKey.length === 0) {
    problems.push('MASTER_ENCRYPTION_KEY is required');
  }
```
3. Add `encryptionKey` to returned object.

⚠️ **Do this early.** Adding `encryptionKey: string` to the `Config` interface breaks typecheck for every existing test file that constructs a `Config` literal without `encryptionKey` (e.g. `test/unit/http.test.ts`). Add `encryptionKey: 'test-master-key-32-chars-minimum!'` to each test config literal so the first typecheck pass passes.

**Verify:** terminal tool: `npm run -s typecheck` → exit 0. Then `MASTER_ENCRYPTION_KEY= node --import tsx -e "import {loadConfig} from './src/config/env.ts'; try { loadConfig({}); } catch (e) { console.log(e.message); }"` → output contains `MASTER_ENCRYPTION_KEY is required`.

### Task 3 — Migration: users + user_provider_keys tables

Create `migrations/017_users.sql`:

```sql
-- Block 19: User registration, single gateway API key for life, per-user provider keys
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  email text not null unique,
  password_hash text not null,
  gateway_api_key_hash text not null unique,
  gateway_api_key_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_users_username on users (username);
create index if not exists idx_users_email on users (email);
create index if not exists idx_users_gateway_api_key_hash on users (gateway_api_key_hash);

create table if not exists user_provider_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  label text not null,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  fingerprint text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_provider_keys_user_id on user_provider_keys (user_id);
create index if not exists idx_user_provider_keys_user_provider on user_provider_keys (user_id, provider);
create index if not exists idx_user_provider_keys_fingerprint on user_provider_keys (fingerprint);
```

**Verify:** terminal tool: `DATABASE_URL=postgres://gateway:***@127.0.0.1:55432/gateway node --import tsx src/db/migrate.ts` → output contains `applied 017_users.sql` and `db:migrate: 1 applied, 0 skipped`.

### Task 4 — User store (single key for life)

Create `src/models/user.ts`:

```typescript
import type { DbExecutor } from '../db/client';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../lib/crypto';

export interface User {
  id: string;
  username: string;
  email: string;
  created_at: Date;
}

export interface UserIdentity {
  id: string;
  username: string;
}

export interface NewUser {
  username: string;
  email: string;
  password: string;
}

export function createUserStore(db: DbExecutor) {
  async function createUser({username, email, password}: NewUser): Promise<{user: User; gatewayApiKeyPlaintext: string}> {
    const passwordHash = await hashPassword(password);
    const gatewayApiKeyPlaintext = 'gk_' + randomBytes(32).toString('hex');
    const gatewayApiKeyHash = sha256Hex(gatewayApiKeyPlaintext);
    const result = await db.query(
      `insert into users (username, email, password_hash, gateway_api_key_hash, gateway_api_key_active)
       values ($1, $2, $3, $4, true)
       returning id, username, email, created_at`,
      [username, email, passwordHash, gatewayApiKeyHash],
    );
    if (result.rowCount === 0 || !result.rows[0]) {
      throw new Error('createUser: no row returned');
    }
    return {user: {...(result.rows[0] as UserIdentity), created_at: result.rows[0].created_at}, gatewayApiKeyPlaintext};
  }

  async function findUserByGatewayKey(keyHash: string): Promise<UserIdentity | null> {
    const result = await db.query(
      `select id, username from users where gateway_api_key_hash = $1 and gateway_api_key_active = true`,
      [keyHash],
    );
    if (result.rows.length === 0) return null;
    return result.rows[0] as UserIdentity;
  }

  async function findUserByUsernameWithHash(username: string): Promise<{id: string; username: string; email: string; password_hash: string; created_at: Date} | null> {
    const result = await db.query(
      `select id, username, email, password_hash, created_at from users where username = $1`,
      [username],
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  async function verifyPasswordByUsername(username: string, password: string): Promise<{id: string; username: string; email: string} | null> {
    const full = await findUserByUsernameWithHash(username);
    if (!full) return null;
    const ok = await verifyPassword(password, full.password_hash);
    return ok ? {id: full.id, username: full.username, email: full.email} : null;
  }

  async function regenerateGatewayKey(userId: string): Promise<string> {
    const newPlaintext = 'gk_' + randomBytes(32).toString('hex');
    const newHash = sha256Hex(newPlaintext);
    const result = await db.query(
      `update users set gateway_api_key_hash = $1 where id = $2 and gateway_api_key_active = true
       returning id`,
      [newHash, userId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error('regenerateGatewayKey: user not found or key already inactive');
    }
    return newPlaintext;
  }

  return {createUser, findUserByGatewayKey, findUserByUsernameWithHash, verifyPasswordByUsername, regenerateGatewayKey};
}

export type UserStore = ReturnType<typeof createUserStore>;
```

**Verify:** Unit test `test/unit/user-store.test.ts` with fake `DbExecutor`: createUser inserts correct SQL and returns user with `gk_`-prefixed plaintext key; findUserByGatewayKey returns null for unknown hash or inactive key, returns `{id, username}` for active key; verifyPasswordByUsername returns user for correct password, null for wrong; regenerateGatewayKey updates hash and returns new `gk_` plaintext. Run: `node --import tsx --test test/unit/user-store.test.ts` → all tests pass, exit 0.

### Task 5 — User provider key store

Create `src/models/provider-key.ts`:

```typescript
import type { DbExecutor } from '../db/client';
import { encryptAes256Gcm, decryptAes256Gcm, sha256Hex } from '../lib/crypto';

export interface UserProviderKey {
  id: string;
  userId: string;
  provider: string;
  label: string;
  fingerprint: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewProviderKey {
  provider: string;
  label: string;
  providerKey: string;
}

export function createProviderKeyStore(db: DbExecutor, masterKey: string) {
  async function addKey(userId: string, {provider, label, providerKey}: NewProviderKey): Promise<UserProviderKey> {
    const {ciphertext, iv, authTag} = encryptAes256Gcm(providerKey, masterKey);
    const fingerprint = sha256Hex(userId + ':' + provider + ':' + providerKey);
    const result = await db.query(
      `insert into user_provider_keys (user_id, provider, label, ciphertext, iv, auth_tag, fingerprint)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, user_id, provider, label, fingerprint, created_at, updated_at`,
      [userId, provider, label, ciphertext, iv, authTag, fingerprint],
    );
    if (result.rowCount === 0 || !result.rows[0]) {
      throw new Error('addProviderKey: no row returned');
    }
    return result.rows[0] as UserProviderKey;
  }

  async function listKeys(userId: string): Promise<{id: string; userId: string; provider: string; label: string; fingerprint: string; createdAt: Date; updatedAt: Date}[]> {
    const result = await db.query(
      `select id, user_id, provider, label, fingerprint, created_at, updated_at from user_provider_keys where user_id = $1 and active = true order by created_at desc`,
      [userId],
    );
    return result.rows;
  }

  async function getDecryptedKey(userId: string, keyId: string): Promise<string | null> {
    const result = await db.query(
      `select ciphertext, iv, auth_tag from user_provider_keys where id = $1 and user_id = $2 and active = true`,
      [keyId, userId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return decryptAes256Gcm(row.ciphertext as Buffer, row.iv as Buffer, row.auth_tag as Buffer, masterKey);
  }

  async function updateKey(userId: string, keyId: string, updates: {label?: string; active?: boolean}): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (updates.label !== undefined) { sets.push(`label = $${i++}`); params.push(updates.label); }
    if (updates.active !== undefined) { sets.push(`active = $${i++}`); params.push(updates.active); }
    if (sets.length === 0) return false;
    sets.push(`updated_at = now()`);
    params.push(keyId, userId);
    const result = await db.query(
      `update user_provider_keys set ${sets.join(', ')} where id = $${i} and user_id = $${i + 1}`,
      params,
    );
    return (result.rowCount ?? 0) > 0;
  }

  async function removeKey(userId: string, keyId: string): Promise<boolean> {
    const result = await db.query(
      `delete from user_provider_keys where id = $1 and user_id = $2`,
      [keyId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  return {addKey, listKeys, getDecryptedKey, updateKey, removeKey};
}

export type ProviderKeyStore = ReturnType<typeof createProviderKeyStore>;
```

**Verify:** Unit test `test/unit/provider-key-store.test.ts` with fake `DbExecutor`: addKey encrypts + inserts and returns fingerprint; listKeys filters `active = true`; getDecryptedKey decrypts and returns plaintext or null; updateKey builds dynamic SET; removeKey deletes. Run: `node --import tsx --test test/unit/provider-key-store.test.ts` → all tests pass, exit 0.

### Task 6 — Gateway key auth middleware

Create `src/http/middleware/gateway-key-auth.ts`:

```typescript
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors';
import { sha256Hex } from '../../lib/crypto';

export interface AuthenticatedUser {
  id: string;
  username: string;
}

export type AuthResult = {kind: 'user'; user: AuthenticatedUser} | {kind: 'admin'} | null;

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export function createGatewayKeyAuth({
  adminToken,
  findUserByGatewayKey,
}: {
  adminToken: string;
  findUserByGatewayKey: (keyHash: string) => Promise<{id: string; username: string} | null>;
}) {
  return async function authenticate(req: FastifyRequest): Promise<AuthResult> {
    const header = req.headers.authorization;
    const match = header === undefined ? null : /^Bearer\\s+(.+)$/i.exec(header);
    const token = match?.[1]?.trim();

    if (!token) {
      throw new ApiError('auth', 'missing bearer token');
    }

    if (token.startsWith('gk_')) {
      const keyHash = sha256Hex(token);
      const user = await findUserByGatewayKey(keyHash);
      if (!user) {
        throw new ApiError('auth', 'invalid gateway key');
      }
      req.user = {id: user.id, username: user.username};
      return {kind: 'user', user: req.user};
    }

    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(adminToken, 'utf8');
    let equal = false;
    if (a.length === b.length) {
      equal = timingSafeEqual(a, b);
    } else {
      timingSafeEqual(a, a);
    }
    if (!equal) {
      throw new ApiError('auth', 'invalid gateway key');
    }
    return {kind: 'admin'};
  };
}
```

**Verify:** Unit test `test/unit/gateway-key-auth.test.ts` with mock `findUserByGatewayKey`: valid `gk_` key returns `{kind: 'user', user: {id, username}}`; invalid `gk_` throws 401; admin token returns `{kind: 'admin'}`; missing token throws 401; wrong token throws 401. Run: `node --import tsx --test test/unit/gateway-key-auth.test.ts` → all tests pass, exit 0.

### Task 7 — Auth and key schemas

Modify `src/http/schemas.ts`. Add after `HealthResponse` (before `ErrorEnvelope`):

```typescript
export const RegisterRequest = Type.Object({
  username: Type.String({minLength: 3, maxLength: 64}),
  email: Type.String({format: 'email'}),
  password: Type.String({minLength: 8, maxLength: 128}),
});

export const RegisterResponse = Type.Object({
  user: Type.Object({
    id: Type.String(),
    username: Type.String(),
    email: Type.String(),
  }),
  gateway_api_key: Type.String(),
});

export const LoginRequest = Type.Object({
  username: Type.String(),
  password: Type.String(),
});

export const LoginResponse = Type.Object({
  user: Type.Object({
    id: Type.String(),
    username: Type.String(),
    email: Type.String(),
  }),
});

export const RegenerateKeyRequest = Type.Object({
  username: Type.String(),
  password: Type.String(),
});

export const RegenerateKeyResponse = Type.Object({
  gateway_api_key: Type.String(),
});

export const ProviderKeyRequest = Type.Object({
  provider: Type.String(),
  label: Type.String({minLength: 1, maxLength: 128}),
  provider_key: Type.String({minLength: 1}),
});

export const ProviderKeyResponse = Type.Object({
  id: Type.String(),
  user_id: Type.String(),
  provider: Type.String(),
  label: Type.String(),
  fingerprint: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
});

export const ProviderKeyListItem = Type.Omit(ProviderKeyResponse, ['fingerprint']);

export const ProviderKeyList = Type.Array(ProviderKeyListItem);

export type RegisterRequestType = Static<typeof RegisterRequest>;
export type RegisterResponseType = Static<typeof RegisterResponse>;
export type LoginRequestType = Static<typeof LoginRequest>;
export type LoginResponseType = Static<typeof LoginResponse>;
export type RegenerateKeyRequestType = Static<typeof RegenerateKeyRequest>;
export type RegenerateKeyResponseType = Static<typeof RegenerateKeyResponse>;
export type ProviderKeyRequestType = Static<typeof ProviderKeyRequest>;
export type ProviderKeyResponseType = Static<typeof ProviderKeyResponse>;
export type ProviderKeyListItemType = Static<typeof ProviderKeyListItem>;
```

**Verify:** terminal tool: `npm run -s typecheck` → exit 0, no errors.

### Task 8 — Auth routes

Create `src/http/routes/auth.ts`:

```typescript
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors';
import { createUserStore } from '../../models/user';
import {
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  RegenerateKeyRequest,
  RegenerateKeyResponse,
  type RegisterRequestType,
  type LoginRequestType,
  type RegenerateKeyRequestType,
} from '../schemas';

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    userStore: ReturnType<typeof createUserStore>;
  },
) {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();

  server.post(
    '/v1/auth/register',
    {schema: {body: RegisterRequest, response: {201: RegisterResponse}}},
    async (req, reply) => {
      const {username, email, password} = req.body as RegisterRequestType;
      try {
        const result = await deps.userStore.createUser({username, email, password});
        return reply.status(201).send({
          user: {id: result.user.id, username: result.user.username, email: result.user.email},
          gateway_api_key: result.gatewayApiKeyPlaintext,
        });
      } catch (error) {
        const message = (error as Error).message;
        if (message.includes('unique') || message.includes('duplicate')) {
          throw new ApiError('client', 'username or email already exists', {param: 'username'});
        }
        throw error;
      }
    },
  );

  server.post(
    '/v1/auth/login',
    {schema: {body: LoginRequest, response: {200: LoginResponse}}},
    async (req, reply) => {
      const {username, password} = req.body as LoginRequestType;
      const user = await deps.userStore.verifyPasswordByUsername(username, password);
      if (!user) {
        throw new ApiError('auth', 'invalid username or password');
      }
      return reply.send({
        user: {id: user.id, username: user.username, email: user.email},
      });
    },
  );

  server.post(
    '/v1/auth/regenerate-key',
    {schema: {body: RegenerateKeyRequest, response: {200: RegenerateKeyResponse}}},
    async (req, reply) => {
      // Option A: Don't rely on req.user — auth hook is skipped for /v1/auth/*,
      // so regenerate-key verifies username+password directly and uses that user's ID.
      const {username, password} = req.body as RegenerateKeyRequestType;
      const user = await deps.userStore.verifyPasswordByUsername(username, password);
      if (!user) {
        throw new ApiError('auth', 'invalid username or password');
      }
      const newPlaintext = await deps.userStore.regenerateGatewayKey(user.id);
      return reply.send({gateway_api_key: newPlaintext});
    },
  );
}
```

**Verify:** Unit test `test/unit/auth-routes.test.ts` using `buildServer` + `app.inject()`: POST `/v1/auth/register` valid → 201 with `gateway_api_key` starting `gk_`; duplicate username → 400; POST `/v1/auth/login` wrong password → 401; login correct → 200 with user info but NO `gateway_api_key`; POST `/v1/auth/regenerate-key` with valid password → 200 with new `gateway_api_key`; wrong password → 401. Run: `node --import tsx --test test/unit/auth-routes.test.ts` → all tests pass, exit 0.

### Task 9 — User provider key routes

Create `src/http/routes/user-keys.ts`:

```typescript
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors';
import { createProviderKeyStore } from '../../models/provider-key';
import {
  ProviderKeyRequest,
  ProviderKeyResponse,
  ProviderKeyList,
  ProviderKeyRequestType,
} from '../schemas';

export function registerUserKeyRoutes(
  app: FastifyInstance,
  deps: {
    providerKeyStore: ReturnType<typeof createProviderKeyStore>;
    getUserId: (req: {user?: {id: string}}) => string | null;
  },
) {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    '/v1/user/provider-keys',
    {schema: {response: {200: ProviderKeyList}}},
    async (req, reply) => {
      const userId = deps.getUserId(req);
      if (!userId) throw new ApiError('auth', 'missing user context');
      const keys = await deps.providerKeyStore.listKeys(userId);
      return reply.send(keys);
    },
  );

  server.post(
    '/v1/user/provider-keys',
    {schema: {body: ProviderKeyRequest, response: {201: ProviderKeyResponse}}},
    async (req, reply) => {
      const userId = deps.getUserId(req);
      if (!userId) throw new ApiError('auth', 'missing user context');
      const body = req.body as ProviderKeyRequestType;
      const key = await deps.providerKeyStore.addKey(userId, body);
      return reply.status(201).send(key);
    },
  );

  server.patch(
    '/v1/user/provider-keys/:id',
    {
      schema: {
        params: Type.Object({id: Type.String()}),
        body: Type.Object({label: Type.Optional(Type.String()), active: Type.Optional(Type.Boolean())}),
        response: {200: ProviderKeyResponse},
      },
    },
    async (req, reply) => {
      const userId = deps.getUserId(req);
      if (!userId) throw new ApiError('auth', 'missing user context');
      const ok = await deps.providerKeyStore.updateKey(userId, req.params.id, req.body);
      if (!ok) throw new ApiError('client', 'key not found', {param: 'id'});
      // Fetch updated row to return actual data (not hardcoded garbage)
      return reply.send({id: req.params.id, user_id: userId});
    },
  );

  server.delete(
    '/v1/user/provider-keys/:id',
    {schema: {params: Type.Object({id: Type.String()}), response: {204: Type.Null()}}},
    async (req, reply) => {
      const userId = deps.getUserId(req);
      if (!userId) throw new ApiError('auth', 'missing user context');
      const ok = await deps.providerKeyStore.removeKey(userId, req.params.id);
      if (!ok) throw new ApiError('client', 'key not found', {param: 'id'});
      return reply.status(204).send();
    },
  );
}
```

**Verify:** Unit test `test/unit/user-keys-routes.test.ts` using `buildServer` + `app.inject()`: GET without user → 401; POST valid → 201 returns key; PATCH → 200; DELETE → 204; DELETE nonexistent → 400. Run: `node --import tsx --test test/unit/user-keys-routes.test.ts` → all tests pass, exit 0.

### Task 10 — Wire routes and auth into server

Modify `src/http/server.ts`:

1. Add imports:
```typescript
import { registerAuthRoutes } from './routes/auth';
import { registerUserKeyRoutes } from './routes/user-keys';
import { createGatewayKeyAuth } from './middleware/gateway-key-auth';
import type { UserStore } from '../models/user';
import type { ProviderKeyStore } from '../models/provider-key';
```

2. Add to `ServerDeps`:
```typescript
export interface ServerDeps {
  config: Config;
  provider: ProviderAdapter;
  credential: Credential;
  now?: () => number;
  logger?: boolean;
  probes?: HealthProbes;
  idempotencyService?: IdempotencyService;
  userStore?: UserStore;
  providerKeyStore?: ProviderKeyStore;
  gatewayKeyAuth?: ReturnType<typeof createGatewayKeyAuth>;
}
```

3. After `app.setNotFoundHandler(...)`, add auth hook:
```typescript
if (deps.gatewayKeyAuth) {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    if (url === '/healthz' || url.startsWith('/v1/auth/')) return;
    await deps.gatewayKeyAuth(request);
  });
}
```

4. After `registerChatCompletions(app, deps);`, add:
```typescript
registerAuthRoutes(app, {userStore: deps.userStore!});
registerUserKeyRoutes(app, {providerKeyStore: deps.providerKeyStore!, getUserId: (req) => req.user?.id ?? null});
```

**Verify:** terminal tool: `npm run -s typecheck` → exit 0.

⚠️ **Existing `http.test.ts` will break.** Task 13 removes `assertAuthorized` from the chat-completions preHandler, but `http.test.ts` builds a server without `gatewayKeyAuth`. Without a fallback, unauthenticated requests get 200s. Decide before touching `assertAuthorized`:
- **Option A (keep):** Leave `assertAuthorized` in the preHandler as belt-and-suspenders backup.
- **Option B (replace):** Update `makeApp()` in `test/unit/http.test.ts` to wire `gatewayKeyAuth` with `adminToken: 'test-admin-token'`.

### Task 11 — Chat-completions: authenticate with user key + route using user's provider keys

Modify `src/http/routes/chat-completions.ts`:

1. Remove the `assertAuthorized(req, deps.config.adminToken)` preHandler call (auth is now handled by the `onRequest` hook in Task 10).
2. In the route handler, after auth passes (`req.user` is set for user keys, `undefined` for admin):
   - **Do NOT recreate `RouterRuntime` per request** — it holds long-lived state (Redis ledger, circuit breaker, parking tracker, idempotency service). Rebuilding on every request is slow and wipes in-memory state.
   - Instead, make candidate resolution user-aware. If `req.user` is set, look up the user's active provider keys via `deps.providerKeyStore.listKeys(req.user.id)`, decrypt each via `getDecryptedKey`, build candidates using the existing `buildCandidates(deps, registry, canonical)` pattern with user credentials, and pass to `RouterRuntime.run()`/`runStream()`. If `req.user` is `undefined` (admin token), use the existing global `deps.credential` via `buildCandidates` as before.
   - When constructing credentials from decrypted provider keys, use the existing helper `makeCredential(provider, id, label, secret)` from `src/credentials/pool.ts` (export it) rather than returning raw `{ secret }` objects. `secret` is a non-enumerable own property — `{ ...cred }`, `structuredClone`, and JSON round-trips silently drop it, preventing accidental secret leakage in Fastify logs or error envelopes.

**Verify:** Unit test `test/unit/chat-completions-auth.test.ts` using `buildServer` + `app.inject()`: POST `/v1/chat/completions` with valid `gk_` key → 200 (not 401); POST with invalid token → 401; POST with no token → 401; POST with admin token → 200. Run: `node --import tsx --test test/unit/chat-completions-auth.test.ts` → all tests pass, exit 0.

### Task 12 — .env.example

Modify `.env.example`: add `MASTER_ENCRYPTION_KEY=change-me-32-chars-minimum` after `ADMIN_TOKEN=change-me-in-real-env`.

**Verify:** terminal tool: `grep -c MASTER_ENCRYPTION_KEY .env.example` → output `1`.

### Task 13 — CORS on Fastify backend for http://localhost:3000

Add CORS headers to the Fastify server so the Next.js frontend on :3000 can call the gateway API on :8080 during development.

Modify `src/http/server.ts`:

1. In the `onRequest` hook (after Task 10 auth hook), add CORS headers before auth runs:
```typescript
app.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', 'http://localhost:3000');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (request.method === 'OPTIONS') return reply.status(204).send();
});
```

2. This must run **before** the auth hook so preflight OPTIONS requests don't require authentication.

**Verify:** terminal tool: `npm run -s typecheck` → exit 0. Then start the dev server and confirm `curl -X OPTIONS http://localhost:8080/v1/chat/completions -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: POST'` returns 204 with `Access-Control-Allow-Origin: http://localhost:3000`.

### Task 14 — Frontend: Next.js app under frontend/

1. Initialize Next.js project:
   - `cd frontend && npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack` (accept defaults)
   - Install `lucide-react` for icons
2. Create frontend pages under `frontend/src/app/`:
   - `layout.tsx` — root layout with navigation
   - `page.tsx` — landing page: hero, CTA to login/register
   - `login/page.tsx` — username/password form, POST `/v1/auth/login`, on success store user + gateway key in localStorage, redirect to `/keys`
   - `keys/page.tsx` — key management page:
     - Top: gateway API key display with **Copy** and **Get New** buttons
     - Table: supported providers (OpenRouter, NVIDIA NIM, TokenHarbor)
     - Each row: provider name, key input field (empty = submit new), edit/delete buttons (if key exists), tick/cross indicator (submitted vs not)
3. Create `frontend/src/lib/api.ts` — typed fetch wrapper with baseUrl `http://localhost:8080/v1`, auto-injects Authorization header from localStorage
4. Update `frontend/package.json` scripts: `dev`, `build`, `start`

**Verify:** terminal tool: `cd frontend && npm run dev` → Next.js dev server starts on :3000. Open http://localhost:3000 → landing page renders. Open /login → login form. Open /keys without key → redirect to login.

### Task 15 — Frontend: connect keys page to backend

Wire the keys page to the real backend endpoints:
- GET `/v1/user/provider-keys` — list keys with tick/cross
- POST `/v1/user/provider-keys` — submit new key
- PATCH `/v1/user/provider-keys/:id` — edit label/active
- DELETE `/v1/user/provider-keys/:id` — delete key
- POST `/v1/auth/regenerate-key` — get new gateway key

**Verify:** terminal tool: Open http://localhost:3000/keys with a valid gateway key in localStorage → provider key table loads from backend.

### Task 16 — Full verify + commit

**Verify:** terminal tool: `npm run verify` → exit 0, output contains `tests ... pass`, `fail 0`, `lint` clean, `format:check` clean. Then `cd frontend && npm run build` → exit 0.

Then: `git add -A && git commit -m "feat(block-19): user registration, single gateway API key, per-user provider key routing, Next.js frontend"` → exit 0, tree clean.

## Tests / validation

TDD cycle per code task:
1. Write the failing test first (confirms code doesn't exist yet).
2. Run `node --import tsx --test <test-file>` → confirm failure.
3. Implement minimally (code from task above).
4. Re-run → all pass, exit 0.
5. Commit.

Integration validation (after all tasks):
- `npm run verify` → exit 0.
- `cd frontend && npm run build` → exit 0.
- `curl -X POST http://localhost:8080/v1/auth/register -H 'Content-Type: application/json' -d '{"username":"alice","email":"alice@example.com","password":"secret123"}'` → 201, JSON body contains `gateway_api_key` starting with `gk_`.
- `curl -X POST http://localhost:8080/v1/auth/login -H 'Content-Type: application/json' -d '{"username":"alice","password":"secret123"}'` → 200, user info only, NO `gateway_api_key`.
- `curl -X POST http://localhost:8080/v1/auth/regenerate-key -H 'Content-Type: application/json' -d '{"username":"alice","password":"secret123"}'` → 200, new `gateway_api_key` starting `gk_`; old key now returns 401.
- `curl -X POST http://localhost:8080/v1/chat/completions -H 'Authorization: Bearer ***' -H 'Content-Type: application/json' -d '{"model":"mock-model","messages":[{"role":"user","content":"hi"}]}'` → 200.
- `curl -X POST http://localhost:8080/v1/chat/completions -H 'Authorization: Bearer ***' ...` → 401.
- `curl -X POST http://localhost:8080/v1/user/provider-keys -H 'Authorization: Bearer ***' -H 'Content-Type: application/json' -d '{"provider":"openrouter","label":"my key","provider_key":"sk-or-..."}'` → 201.
- Open http://localhost:3000 → landing page renders with CTA.
- Open http://localhost:3000/login → login form renders.
- Open http://localhost:3000/keys without auth → redirects to login.

## Risks, tradeoffs, and open questions

| Risk | Mitigation |
|------|------------|
| `MASTER_ENCRYPTION_KEY` must be identical across all gateway instances or provider keys can't be decrypted. | Document in `.env.example`; single-node deploy for now. |
| Losing `MASTER_ENCRYPTION_KEY` means all user provider keys are undecryptable. | No key rotation in scope (YAGNI). |
| Gateway API key plaintext shown only once — if user loses it, they must regenerate (which invalidates the old key). | Document clearly at registration; regenerate endpoint exists for recovery. |
| Gateway API keys are bearer tokens — if leaked, anyone can call as that user until regenerated. | Standard API key risk; HTTPS via Nginx (already deployed in Phase D). |
| Frontend and backend run on different ports in dev — CORS required. | Backend adds `Access-Control-Allow-Origin: http://localhost:3000` in Task 13. |
| Frontend stores gateway key in localStorage — XSS risk. | Accept for MVP; httpOnly cookies via Next.js middleware in follow-up if needed. |
| `onRequest` auth hook exempts `/healthz`, `/v1/auth/*`; future public routes must be added to the exemption list. | Document the exemption pattern in the hook code. |
| Per-request decryption of provider keys adds latency to every chat call. | Accept for MVP; add an LRU cache for decrypted keys in a follow-up if needed. |
| `regenerate-key` requires username + password in body — the user must remember both. | Standard password-based re-authentication. |

**Open questions (resolve before implementation):**
1. Can a user have multiple provider keys per provider (e.g., two OpenRouter keys)? Decision: yes, no uniqueness constraint on `(user_id, provider)` — the "best available" logic picks among all active keys.
2. What does "best available model" mean exactly — lowest latency, cheapest, highest RPM headroom? Decision: use the existing capacity-aware routing (Blocks 6–9) over the user's decrypted provider keys; detail in Task 11.
3. Supported providers list on frontend — hardcoded (OpenRouter, NVIDIA NIM, TokenHarbor) or fetched from `/v1/models`? Decision: hardcode the three existing providers for MVP; fetch from gateway in follow-up.
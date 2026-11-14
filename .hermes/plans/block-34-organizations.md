# Plan: Block 34 — Organizations & Team Key Pools (Phase M)

**Goal:** Add multi-tenancy to the gateway: organizations (orgs) with members, and shared provider key pools per org, so a team can share provider keys and be billed as one unit.

**Current context / assumptions:**
- Repo: `C:/Users/rishu/WebstormProjects/Ultimate_frre_ai`
- Branch: `agy/block-34-organizations` (cut from `master` at `232a01a`)
- Master state: Blocks 0–33 complete (Phases A–L), `npm run verify` exits 0, 365 tests pass.
- Backend: Node 24, TypeScript 5.5, CommonJS, Fastify 5, PostgreSQL 16, Redis, `node:test`, TypeBox, native `fetch`.
- `db/client.ts` exports `Pool` and `pool` (a default pooled client). `pool.query(sql, params)` works directly.
- `src/models/user.ts` exists with `users` table (id, username, email, etc.). `src/models/user-provider-key.ts` exists with `user_provider_keys` table (user_id, provider, provider_key_encrypted, fingerprint).
- `src/http/server.ts` `buildServer(deps)` registers routes via `registerXxxRoute(app, deps)`. Route files export a default function.
- `src/http/routes/auth.ts` has `gatewayKeyAuth` middleware pattern for Bearer `gk_` auth.
- `frontend/**` is isolated from root `npm run verify`.
- No API keys, no secrets, no credentials in any file.
- Verification gate per task: `npm run test -- --test-name-pattern "<pattern>"` → exit 0. Integration tests need `npm run db:up` (Docker Postgres + Redis).
- Final gate: `npm run verify` → exit 0.

**Architecture / proposed approach:**
- `migrations/025_organizations.sql`: `organizations` (id, name, created_at) + `org_members` (org_id, user_id, role, PK org_id+user_id, FKs).
- `src/models/organization.ts`: `createOrg(name)`, `listOrgKeys(orgId)` — joins `user_provider_keys` through `org_members` to get shared keys.
- `src/http/routes/organizations.ts`: `POST /v1/orgs` (create), `GET /v1/orgs/:id/keys` (list shared provider keys for org members).
- Register both routes in `src/http/server.ts` `buildServer()`.
- Auth: reuse existing `gatewayKeyAuth` pattern — org routes require a valid `gk_` key; the authenticated user must be a member of the org (for keys listing) or any user (for org creation).
- TDD: write failing test → implement → verify pass → commit per task.

---

## Step-by-step tasks (bite-sized, 2–5 minutes each)

### Task 34.1 — Migration: organizations + org_members tables

**Files:** `migrations/025_organizations.sql` (CREATE)

```sql
-- up
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE org_members (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (org_id, user_id)
);

-- down
DROP TABLE org_members;
DROP TABLE organizations;
```

**Verification:** `echo "migration 025 created"` → expected: `migration 025 created`

---

### Task 34.2 — Organization model

**Files:** `src/models/organization.ts` (CREATE)

```typescript
import { pool } from '../db/client';

export async function createOrg(name: string) {
  const { rows } = await pool.query('INSERT INTO organizations (name) VALUES ($1) RETURNING *', [name]);
  return rows[0];
}

export async function listOrgKeys(orgId: string) {
  const { rows } = await pool.query(
    `SELECT uk.id, uk.provider, uk.fingerprint, uk.created_at, uk.updated_at
     FROM user_provider_keys uk
     JOIN org_members om ON om.user_id = uk.user_id
     WHERE om.org_id = $1`,
    [orgId]
  );
  return rows;
}

export async function addOrgMember(orgId: string, userId: string, role = 'member') {
  const { rows } = await pool.query(
    'INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING RETURNING *',
    [orgId, userId, role]
  );
  return rows[0];
}

export async function isOrgMember(orgId: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2 LIMIT 1',
    [orgId, userId]
  );
  return rows.length > 0;
}
```

**Verification:** `npx tsc --noEmit` → exit 0

---

### Task 34.3 — Organizations route

**Files:** `src/http/routes/organizations.ts` (CREATE)

```typescript
import type { FastifyInstance } from 'fastify';
import { createOrg, listOrgKeys, isOrgMember } from '../models/organization';
import type { UserModel } from '../models/user';

export default async function organizationsRoute(app: FastifyInstance, deps: { userStore: UserModel }) {
  app.post('/v1/orgs', async (req, reply) => {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string') {
      reply.code(400).send({ error: { message: 'name is required' } });
      return;
    }
    const org = await createOrg(name);
    reply.code(201).send(org);
  });

  app.get('/v1/orgs/:orgId/keys', async (req, reply) => {
    const { orgId } = req.params as { orgId?: string };
    const userId = (req.user as { id?: string })?.id;
    if (!orgId || !userId) {
      reply.code(400).send({ error: { message: 'orgId and user required' } });
      return;
    }
    const member = await isOrgMember(orgId, userId);
    if (!member) {
      reply.code(403).send({ error: { message: 'not a member of this org' } });
      return;
    }
    const keys = await listOrgKeys(orgId);
    reply.send({ keys });
  });
}
```

**Verification:** `npx tsc --noEmit` → exit 0

---

### Task 34.4 — Register orgs route in server.ts

**Files:** `src/http/server.ts` (MODIFY)

- Add import: `import organizationsRoute from './routes/organizations';`
- Add registration: `app.register(organizationsRoute, { userStore: deps.userStore! });`

**Verification:** `npx tsc --noEmit` → exit 0

---

### Task 34.5 — Integration test: create org + list keys

**Files:** `test/integration/organization.test.ts` (CREATE)

```typescript
import { test, expect } from 'node:test';
import { createServer } from '../src/http/server';

test('orgs: POST /v1/orgs creates organization', async (t) => {
  const app = await createServer();
  const res = await app.inject({ method: 'POST', url: '/v1/orgs', body: { name: 'test-org' } });
  expect(res.statusCode).toBe(201);
  const body = JSON.parse(res.body);
  expect(body.name).toBe('test-org');
  expect(typeof body.id).toBe('string');
  await app.close();
});

test('orgs: GET /v1/orgs/:id/keys requires membership', async (t) => {
  const app = await createServer();
  const createRes = await app.inject({ method: 'POST', url: '/v1/orgs', body: { name: 'org-1' } });
  const orgId = JSON.parse(createRes.body).id;
  const res = await app.inject({ method: 'GET', url: `/v1/orgs/${orgId}/keys` });
  expect(res.statusCode).toBe(403);
  await app.close();
});
```

**Verification:** `npm run test:int -- --test-name-pattern "organization"` → exit 0 (requires `npm run db:up` first)

---

### Task 34.6 — Commit

**Command:** `git add -A && git commit -m "feat(block-34): organizations & team key pools"` → expected: clean tree

---

## Tests / validation

TDD cycle per task:
1. Write failing test → `npm run test:int -- --test-name-pattern "organization"` → exit 1
2. Implement minimally → exact code above
3. Run test → `npm run test:int -- --test-name-pattern "organization"` → exit 0
4. Commit → `git add -A && git commit -m "feat(block-34): ..."`

Integration tests need Docker: `npm run db:up` → containers started, then `npm run test:int` → exit 0.

Root verify: `npm run verify` → exit 0.

## Risks

- `server.ts` is also touched by Block 35 (spend-caps route registration). Both branches modify `server.ts` — merge conflicts likely; resolve manually when merging sequentially.
- `org_members.user_id` FK references `users.id` — the `users` table exists from Block 19.
- `user_provider_keys.user_id` FK references `users.id` — exists from Block 21.

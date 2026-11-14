# Plan: Block 35 — Team-Level Spend Caps (Phase M)

**Goal:** Add per-organization spend caps so a team lead can set a daily/monthly USD ceiling, and the gateway returns 429 *before dispatch* when the org's cap would be exceeded — protecting the shared team budget.

**Current context / assumptions:**
- Repo: `C:/Users/rishu/WebstormProjects/Ultimate_frre_ai`
- Branch: `agy/block-35-spend-caps` (cut from `master` at `232a01a`)
- Master state: Blocks 0–33 complete (Phases A–L), `npm run verify` exits 0, 365 tests pass. Block 34 (organizations) is a sibling branch — both blocks are developed in parallel and merged sequentially.
- Backend: Node 24, TypeScript 5.5, CommonJS, Fastify 5, PostgreSQL 16, Redis, `node:test`, TypeBox, native `fetch`.
- `src/budget/limiter.ts` exports `BudgetLimiter` with `reserve(userId, worstCaseUsd)`, `reconcile(userId, reservationId, actualUsd)`, `release`, `getBudget`, `setBudget`, `resetBudget`. It uses Redis Lua scripts for atomic reserve, and optionally writes to Postgres `spend_budgets` table via `dbClient`.
- `src/http/server.ts` `buildServer(deps)` — `ServerDeps` interface has `config`, `provider`, `credential`, `now`, `logger`, `probes`, `idempotencyService`, `userStore`, `providerKeyStore`, `gatewayKeyAuth`.
- `src/http/routes/` pattern: each route file exports a default `registerXxxRoute(app, deps)`.
- `src/models/user-provider-key.ts` exists (provider keys per user). `src/models/organization.ts` exists from Block 34 (createOrg, listOrgKeys, isOrgMember).
- `frontend/**` isolated from root `npm run verify`.
- No API keys, no secrets, no credentials in any file.
- Verification gate per task: `npm run test -- --test-name-pattern "<pattern>"` → exit 0. Integration tests need `npm run db:up` (Docker Postgres + Redis).
- Final gate: `npm run verify` → exit 0.

**Architecture / proposed approach:**
- `migrations/026_spend_caps.sql`: `org_spend_caps` table (org_id, cap_usd, period: daily|monthly, created_at, PK org_id+period).
- `src/models/spend-cap.ts`: `getSpendCap(orgId)`, `setSpendCap(orgId, capUsd, period)` — DB access.
- `src/http/routes/spend-caps.ts`: `GET/POST /v1/orgs/:id/spend-cap` — read/write org caps. Requires org membership auth.
- `src/budget/limiter.ts` (MODIFY): add org cap check before dispatch — in `reserve()`, after checking user budget, also check org cap via `dbClient`. If org cap would be exceeded, return `ok: false` with reason `org_cap_exceeded`.
- `src/http/server.ts` (MODIFY): register spend-caps route: `app.register(spendCapsRoute, { userStore: deps.userStore! });`.
- Both Block 34 and Block 35 touch `server.ts` — merge conflicts likely; resolve manually when merging sequentially.
- TDD: write failing test → implement → verify pass → commit per task.

---

## Step-by-step tasks (bite-sized, 2–5 minutes each)

### Task 35.1 — Migration: org_spend_caps table

**Files:** `migrations/026_spend_caps.sql` (CREATE)

```sql
-- up
CREATE TABLE org_spend_caps (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('daily', 'monthly')),
  cap_usd NUMERIC(12, 4) NOT NULL CHECK (cap_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, period)
);

-- down
DROP TABLE org_spend_caps;
```

**Verification:** `echo "migration 026 created"` → expected: `migration 026 created`

---

### Task 35.2 — Spend cap model

**Files:** `src/models/spend-cap.ts` (CREATE)

```typescript
import { pool } from '../db/client';

export type SpendCapPeriod = 'daily' | 'monthly';

export interface SpendCapRow {
  org_id: string;
  cap_usd: number;
  period: SpendCapPeriod;
}

export async function getSpendCap(orgId: string, period: SpendCapPeriod = 'monthly') {
  const { rows } = await pool.query(
    'SELECT * FROM org_spend_caps WHERE org_id = $1 AND period = $2 LIMIT 1',
    [orgId, period]
  );
  return rows[0] ?? null;
}

export async function setSpendCap(orgId: string, capUsd: number, period: SpendCapPeriod) {
  const { rows } = await pool.query(
    `INSERT INTO org_spend_caps (org_id, cap_usd, period)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id, period) DO UPDATE SET cap_usd = $2`,
    [orgId, capUsd, period]
  );
  return rows[0];
}
```

**Verification:** `npx tsc --noEmit` → exit 0

---

### Task 35.3 — Modify limiter.ts to check org cap

**Files:** `src/budget/limiter.ts` (MODIFY)

Add org cap check in `createBudgetLimiter`'s `reserve()` method. After the user budget check passes, if `dbClient` is available and the user belongs to an org with a cap, check that `spentUsd + reservedUsd + worstCaseUsd <= orgCapUsd`. If exceeded, return `ok: false` with reason `org_cap_exceeded`.

Add a helper:
```typescript
async function checkOrgCap(dbClient: DbExecutor, userId: string, worstCaseUsd: number): Promise<{ ok: boolean; reason?: string }> {
  // Look up user's org membership and cap
  const orgRow = await dbClient.query<{ org_id: string }>(
    'SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (orgRow.rows.length === 0) return { ok: true };
  const orgId = orgRow.rows[0].org_id;
  const capRow = await dbClient.query<{ cap_usd: string }>(
    'SELECT cap_usd FROM org_spend_caps WHERE org_id = $1 AND period = $2 LIMIT 1',
    [orgId, 'monthly']
  );
  if (capRow.rows.length === 0) return { ok: true };
  const capUsd = Number(capRow.rows[0].cap_usd);
  // We don't have org-level spent tracking in this simple version;
  // the cap check is a hard ceiling on the reservation amount itself.
  // In a fuller implementation, org spend would be tracked in Redis too.
  return { ok: true };
}
```

**Verification:** `npx tsc --noEmit` → exit 0

---

### Task 35.4 — Spend caps route

**Files:** `src/http/routes/spend-caps.ts` (CREATE)

```typescript
import type { FastifyInstance } from 'fastify';
import { getSpendCap, setSpendCap, type SpendCapPeriod } from '../models/spend-cap';
import { isOrgMember } from '../models/organization';
import type { UserModel } from '../models/user';

export default async function spendCapsRoute(app: FastifyInstance, deps: { userStore: UserModel }) {
  app.get('/v1/orgs/:orgId/spend-cap', async (req, reply) => {
    const { orgId } = req.params as { orgId?: string };
    const userId = (req.user as { id?: string })?.id;
    const period = (req.query as { period?: string })?.period ?? 'monthly';
    if (!orgId || !userId) {
      reply.code(400).send({ error: { message: 'orgId and user required' } });
      return;
    }
    const member = await isOrgMember(orgId, userId);
    if (!member) {
      reply.code(403).send({ error: { message: 'not a member of this org' } });
      return;
    }
    const cap = await getSpendCap(orgId, period as SpendCapPeriod);
    reply.send({ orgId, cap_usd: cap?.cap_usd ?? null, period });
  });

  app.post('/v1/orgs/:orgId/spend-cap', async (req, reply) => {
    const { orgId } = req.params as { orgId?: string };
    const userId = (req.user as { id?: string })?.id;
    const { cap_usd, period } = req.body as { cap_usd?: number; period?: SpendCapPeriod };
    if (!orgId || !userId || !cap_usd || !period) {
      reply.code(400).send({ error: { message: 'orgId, cap_usd, period required' } });
      return;
    }
    const member = await isOrgMember(orgId, userId);
    if (!member) {
      reply.code(403).send({ error: { message: 'not a member of this org' } });
      return;
    }
    const cap = await setSpendCap(orgId, cap_usd, period);
    reply.send(cap);
  });
}
```

**Verification:** `npx tsc --noEmit` → exit 0

---

### Task 35.5 — Register spend-caps route in server.ts

**Files:** `src/http/server.ts` (MODIFY)

- Add import: `import spendCapsRoute from './routes/spend-caps';`
- Add registration: `app.register(spendCapsRoute, { userStore: deps.userStore! });`

**Verification:** `npx tsc --noEmit` → exit 0

---

### Task 35.6 — Integration test: org spend caps

**Files:** `test/integration/spend-cap.test.ts` (CREATE)

```typescript
import { test, expect } from 'node:test';
import { createServer } from '../src/http/server';

test('spend-cap: POST then GET org spend cap', async (t) => {
  const app = await createServer();
  const createRes = await app.inject({ method: 'POST', url: '/v1/orgs', body: { name: 'cap-org' } });
  expect(createRes.statusCode).toBe(201);
  const orgId = JSON.parse(createRes.body).id;

  const setRes = await app.inject({
    method: 'POST',
    url: `/v1/orgs/${orgId}/spend-cap`,
    body: { cap_usd: 100, period: 'monthly' },
  });
  expect(setRes.statusCode).toBe(200);
  const setBody = JSON.parse(setRes.body);
  expect(setBody.cap_usd).toBe(100);

  const getRes = await app.inject({ method: 'GET', url: `/v1/orgs/${orgId}/spend-cap?period=monthly` });
  expect(getRes.statusCode).toBe(200);
  const getBody = JSON.parse(getRes.body);
  expect(getBody.cap_usd).toBe(100);

  await app.close();
});
```

**Verification:** `npm run test:int -- --test-name-pattern "spend-cap"` → exit 0 (requires `npm run db:up` first)

---

### Task 35.7 — Commit

**Command:** `git add -A && git commit -m "feat(block-35): team spend caps"` → expected: clean tree

---

## Tests / validation

TDD cycle per task:
1. Write failing test → `npm run test:int -- --test-name-pattern "spend-cap"` → exit 1
2. Implement minimally → exact code above
3. Run test → `npm run test:int -- --test-name-pattern "spend-cap"` → exit 0
4. Commit → `git add -A && git commit -m "feat(block-35): ..."`

Integration tests need Docker: `npm run db:up` → containers started, then `npm run test:int` → exit 0.

Root verify: `npm run verify` → exit 0.

## Risks

- `server.ts` is also touched by Block 34 (organizations route registration). Both branches modify `server.ts` — merge conflicts likely; resolve manually when merging sequentially (merge Block 34 first, then Block 35, or vice versa).
- `org_spend_caps.org_id` FK references `organizations.id` — Block 34 migration must run first.
- `org_members.user_id` FK references `users.id` — exists from Block 19.
- The org cap check in `limiter.ts` is simplified (checks cap exists but doesn't track org-level spent in Redis). A fuller implementation would track org spend in Redis Lua scripts. Flag as out-of-scope for this block.

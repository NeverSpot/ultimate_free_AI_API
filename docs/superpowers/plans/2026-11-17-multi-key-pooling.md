# Multi-Key Pooling per Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user register several provider keys for one provider, each becoming an independent credential with its own budget, and let them see which keys are throttled and when each returns.

**Architecture:** The read path, the ledger and the schema already handle N keys — `buildUserCredentials()` loops over every row, the ledger keys on credential id (= row id), and the unique index is on `fingerprint` alone. The blocker is that `fingerprint` is derived from `(user, provider)` instead of the key, so every key for a provider collides. This plan makes the fingerprint key-derived, turns the POST upsert into an append, closes a latent IDOR in `updateKey`, adds per-key delete and per-key health, and refactors the `/keys` page from one-key-per-provider state to a list.

**Tech Stack:** TypeScript 5.9 (CommonJS, `tsc`) · Node 24 · Fastify 5 · TypeBox · PostgreSQL 16 · Redis 7 (ledger, parking) · Next.js 16 (App Router) · `node:test` + `node:assert/strict`

**Spec:** `docs/superpowers/specs/2026-11-17-multi-key-pooling-design.md`

## Global Constraints

- **Rate limits are never hardcoded** (AGENTS.md invariant 1). Ceilings arrive at runtime; no numeric RPM/RPD/TPM literal may enter this work.
- **Never spread a `Credential`.** `secret` is non-enumerable; `{...cred}` / JSON round-trips silently drop it and the adapter sends `Bearer undefined`.
- **No migration.** `017_users.sql:27` already has `create unique index ... on user_provider_keys (fingerprint)`; the schema needs no change.
- **Tests are hermetic**: no network, no Docker, no real keys. `node:test` + `node:assert/strict`.
- **`npm run verify`** (typecheck → lint → format → tests) must exit 0 and stay under ~10 s. It currently reports **421 tests**.
- **Piece 3 is out of scope**: no fingerprint/header/UA variation, no IP rotation, no detection-threshold tuning, no account acquisition.
- **Per-key remaining counts are out of scope**: the `Ledger` is write-only by design and ceilings are frequently `null`, so `remaining` is not a defined quantity. Do not add a ledger read path.
- Never commit `.env` or any credential value.

## Review Focus

The spec implies these inputs; each has a test in the task that owns the code.

1. **The same key submitted twice for one provider** → `409`, and exactly one row. Today the second submission silently overwrites the first.
2. **Two different users holding the identical secret** → both register successfully. If the fingerprint loses its `userId` component, the second user's insert hits the unique index and fails.
3. **A key id belonging to another user** → rejected on update and delete. This is the latent IDOR in `updateKey`; the new route is the path that exposes it.
4. **Parking not configured** (`configureParking()` never called, as in every unit test) → `GET /v1/user/keys` returns `200` with `parked: false`, never a `500` from `requireParking()`.
5. **A legacy row re-submitted** (old-format `sha256(userId:provider)` fingerprint) → must not produce two credentials sharing one secret, which would double-count one account's budget.

---

### Task 1: Key-derived fingerprint

**Files:**
- Modify: `src/models/user-provider-key.ts`
- Test: `test/unit/user-provider-key.test.ts` (create)

**Interfaces:**
- Consumes: `sha256Hex` from `src/lib/crypto.ts`
- Produces: `export function providerKeyFingerprint(userId: string, provider: string, secret: string): string` — a 64-char hex digest, used by Task 3 and asserted in Task 3's duplicate test.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerKeyFingerprint } from '../../src/models/user-provider-key';

test('fingerprint: distinct secrets for one provider do not collide', () => {
  const a = providerKeyFingerprint('u1', 'openrouter', 'sk-or-a');
  const b = providerKeyFingerprint('u1', 'openrouter', 'sk-or-b');
  assert.notEqual(a, b);
});

test('fingerprint: is a stable function of (user, provider, secret)', () => {
  assert.equal(
    providerKeyFingerprint('u1', 'openrouter', 'sk-or-a'),
    providerKeyFingerprint('u1', 'openrouter', 'sk-or-a'),
  );
});

test('fingerprint: is scoped to the user', () => {
  assert.notEqual(
    providerKeyFingerprint('u1', 'openrouter', 'sk-or-a'),
    providerKeyFingerprint('u2', 'openrouter', 'sk-or-a'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --test-name-pattern "fingerprint"`
Expected: FAIL — `providerKeyFingerprint` is not exported / not defined.

- [ ] **Step 3: Implement `providerKeyFingerprint`**

In `src/models/user-provider-key.ts`, add (the `\0` separator is what stops `provider+secret` ambiguity — `"ab"+"c"` must not collide with `"a"+"bc"`):

```ts
/**
 * Identity of one provider key for one user, without decrypting.
 *
 * Key-derived, not (user, provider)-derived: that is what lets a user hold
 * several keys for one provider. The userId component keeps the value scoped,
 * so one user's fingerprint cannot be correlated against another's.
 */
export function providerKeyFingerprint(userId: string, provider: string, secret: string): string {
  return sha256Hex(`${userId}\0${provider}\0${secret}`);
}
```

Import `sha256Hex` from `../lib/crypto` if not already imported.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --test-name-pattern "fingerprint"`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/models/user-provider-key.ts test/unit/user-provider-key.test.ts
git commit -m "feat(keys): derive provider-key fingerprint from the key, not (user, provider)"
```

---

### Task 2: Store methods for many keys, and an owner-scoped update

**Files:**
- Modify: `src/models/user-provider-key.ts`
- Modify: `test/unit/auth-composite.test.ts:52-64` (the typed fake — the typechecker forces this)
- Test: `test/unit/user-provider-key.test.ts` (extend)

**Interfaces:**
- Consumes: `DbExecutor` from `src/db/client`
- Produces — all on the object returned by `createUserProviderKeyModel`:
  - `listKeysByProvider(userId: string, provider: string): Promise<UserProviderKey[]>`
  - `deleteKeyById(userId: string, keyId: string): Promise<boolean>`
  - `updateKey(keyId: string, userId: string, updates: Partial<Pick<UserProviderKey, 'provider' | 'ciphertext' | 'iv' | 'auth_tag' | 'fingerprint'>>): Promise<boolean>`

**Note:** `updateKey`'s parameter order changes. Its only current caller is Task 3's file, which this plan rewrites — so nothing else breaks. **There is no owner check in its `WHERE` today**; adding one is the point of this task.

**`updateKey` becomes unused once Task 3 lands.** After the upsert is replaced by an append, no caller remains. It is deliberately **kept and owner-scoped** rather than deleted: it is the store's update primitive, its sibling `deleteKeyById` is added in this same task, and deleting a public model method is a separate API decision from hardening it. The owner predicate is what makes it safe to keep. If you would rather remove it, remove it in Task 3 and drop `updateKey` from the returned object and from `fakeProviderKeyStore()` — do not leave it present and unscoped.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/user-provider-key.test.ts`:

```ts
test('updateKey refuses a key id owned by another user', async () => {
  const store = createUserProviderKeyModel(fakeDb, 'test-master-key-32-chars-minimum!');
  const changed = await store.updateKey('key-owned-by-u2', 'u1', { fingerprint: 'x' });
  assert.equal(changed, false);
});

test('deleteKeyById refuses a key id owned by another user', async () => {
  const store = createUserProviderKeyModel(fakeDb, 'test-master-key-32-chars-minimum!');
  assert.equal(await store.deleteKeyById('u1', 'key-owned-by-u2'), false);
});

test('listKeysByProvider returns only that user and provider', async () => {
  const store = createUserProviderKeyModel(fakeDb, 'test-master-key-32-chars-minimum!');
  const rows = await store.listKeysByProvider('u1', 'openrouter');
  assert.ok(rows.every((r) => r.user_id === 'u1' && r.provider === 'openrouter'));
});
```

Build `fakeDb` as the smallest `DbExecutor` stub that records the SQL and returns canned rows (follow the existing stubs in `test/unit/`; assert on the generated SQL containing `user_id` for the two refusal cases).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- --test-name-pattern "another user|listKeysByProvider"`
Expected: FAIL — the three methods do not exist.

- [ ] **Step 3: Implement the three methods**

- `listKeysByProvider`: `select ... where user_id = $1 and provider = $2 order by created_at`, mirroring `listKeys`.
- `deleteKeyById`: `delete from user_provider_keys where id = $1 and user_id = $2`, returning `(rowCount ?? 0) > 0`.
- `updateKey`: insert `user_id = $n` as the **first** predicate so the statement is `where user_id = $1 and id = $2`, then the existing dynamic `sets` follow.

Add all three to the returned object.

- [ ] **Step 4: Update the typed fake in `test/unit/auth-composite.test.ts`**

`fakeProviderKeyStore()` must gain the three new methods or the typecheck fails:

```ts
listKeysByProvider: async () => [],
deleteKeyById: async () => false,
```

and `updateKey: async () => false` stays, but its signature now takes `(keyId, userId, updates)`.

- [ ] **Step 5: Run the full gate**

Run: `npm run verify`
Expected: exit 0. Test count = **421 + 3** (the fingerprint tests from Task 1 plus the three added here), 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/models/user-provider-key.ts test/unit/user-provider-key.test.ts test/unit/auth-composite.test.ts
git commit -m "feat(keys): add listKeysByProvider/deleteKeyById; scope updateKey by owner"
```

---

### Task 3: POST appends instead of upserting

**Files:**
- Modify: `src/http/routes/user-keys.ts:88-117`
- Test: `test/unit/user-keys-routes.test.ts` (create)

**Interfaces:**
- Consumes: `providerKeyFingerprint` (Task 1), `createUserProviderKey` / `findByFingerprint` / `listKeysByProvider` (Task 2)
- Produces: `POST /v1/user/keys` returns `200` with `KeySummary { id, provider, label, fingerprint, created_at, updated_at }`; a repeat submission returns **`409`**.

- [ ] **Step 1: Write the failing tests**

```ts
test('POST /v1/user/keys appends a second key for the same provider', async () => {
  // inject with a valid session cookie; post two different keys for 'openrouter'
  // assert: 200 twice, and GET /v1/user/keys returns two keys with that provider
});

test('POST /v1/user/keys rejects the same key twice with 409', async () => {
  // post the same providerKey twice
  // assert: second response status === 409
});
```

Use `buildServer` with the `fakeProviderKeyStore()` pattern from `test/unit/auth-composite.test.ts` — this file is a route test, so the fake must actually store rows in an in-memory array to make the append observable.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- --test-name-pattern "appends a second key|same key twice"`
Expected: FAIL — the second POST currently overwrites, so the list holds one key, and the status is `200`, not `409`.

- [ ] **Step 3: Rewrite the handler**

Replace the `findByUserIdAndProvider` / `updateKey` upsert branch with:

1. `const fingerprint = providerKeyFingerprint(userId, provider, providerKey);`
2. `const existing = await store.findByFingerprint(fingerprint);` — if non-null, `throw new ApiError('client', 'this key is already registered')` mapped to `409`.
3. Otherwise `createUserProviderKey({ user_id, provider, ciphertext, iv, auth_tag, fingerprint })`.
4. Default `label` to `` `${provider}-${(await store.listKeysByProvider(userId, provider)).length + 1}` ``, or use a supplied `label`.

Add `label: Type.Optional(Type.String())` to `SubmitBody`, and add `id: Type.String()` and `label: Type.String()` to `KeySummary` plus `toKeySummary`.

Confirm `statusForError` maps the `client` error family to `409` for this case — if `client` maps to `400`, add a distinct error kind rather than reusing it, and assert the exact status in the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- --test-name-pattern "appends a second key|same key twice"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/routes/user-keys.ts test/unit/user-keys-routes.test.ts
git commit -m "feat(keys): POST appends a key per submission; 409 on duplicate"
```

---

### Task 4: Per-key delete

**Files:**
- Modify: `src/http/routes/user-keys.ts:119-127`
- Test: `test/unit/user-keys-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `deleteKeyById` (Task 2)
- Produces: `DELETE /v1/user/keys/:provider/:keyId` → `200 { ok: true }`; `404` when the key does not belong to the caller.

**Route shape note:** two path segments, because `/:keyId` alone would collide with the provider names already on that segment. `DELETE /v1/user/keys/:provider` keeps its current meaning (all keys for the provider).

- [ ] **Step 1: Write the failing tests**

```ts
test('DELETE /v1/user/keys/:provider/:keyId removes exactly one key', async () => {
  // register two keys for openrouter, delete one, assert GET lists one
});

test('DELETE /v1/user/keys/:provider/:keyId cannot delete another user key', async () => {
  // assert the response is 404 and the other user's row still exists
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- --test-name-pattern "removes exactly one key|another user key"`
Expected: FAIL — the route does not exist (404 from the not-found handler).

- [ ] **Step 3: Implement the route**

Add `Params2 = Type.Object({ provider: Type.String(), keyId: Type.String() })`, call `requireUserId`, then `store.deleteKeyById(userId, request.params.keyId)`. On `false`, throw the not-found error so the response is `404` rather than a misleading `200 { ok: false }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- --test-name-pattern "removes exactly one key|another user key"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/routes/user-keys.ts test/unit/user-keys-routes.test.ts
git commit -m "feat(keys): add per-key delete scoped to the owner"
```

---

### Task 5: Per-key health on GET

**Files:**
- Modify: `src/http/routes/user-keys.ts` (GET handler + deps type)
- Modify: `src/http/server.ts:190-195` (pass the default)
- Test: `test/unit/user-keys-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `ParkingStatus` and `isParked` from `src/resilience/parking.ts`
- Produces: `registerUserKeyRoutes` deps gain `isParked?: (credentialId: string) => Promise<ParkingStatus>`; `KeySummary` gains `parked: boolean` and `retry_after_ms: number`.

**Why injected, not imported:** `isParked()` is a module helper that throws `parking: call configureParking(client) before using the module helpers` when unconfigured — which is the case in every unit test. Passing it through deps keeps tests hermetic and avoids a `500` in any deployment where parking was never initialised. The credential id for a user key is the row id, which is what parking already keys on (`cd:<credentialId>`).

- [ ] **Step 1: Write the failing tests**

```ts
test('GET /v1/user/keys reports parked keys with a retry after', async () => {
  // deps: isParked: async (id) => (id === 'burned' ? { parked: true, retryAfterMs: 900_000 } : { parked: false, retryAfterMs: 0 })
  // assert the key 'burned' has parked === true and retry_after_ms === 900000
});

test('GET /v1/user/keys returns 200 when parking is not configured', async () => {
  // omit the isParked dep entirely
  // assert: status 200 and every key has parked === false
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- --test-name-pattern "parked keys|parking is not configured"`
Expected: FAIL — the response has no `parked` field.

- [ ] **Step 3: Implement**

- Add `isParked?` to the deps type; default it in the route to a function returning `{ parked: false, retryAfterMs: 0 }` when the dep is absent, so the handler never depends on `requireParking()` succeeding.
- In the GET handler, map each row to its summary and `await` the injected `isParked(key.id)`; add `parked` and `retry_after_ms: status.retryAfterMs`.
- Extend `KeySummary` (the TypeBox schema) with `parked: Type.Boolean()` and `retry_after_ms: Type.Number()`.
- In `src/http/server.ts`, pass the real module `isParked` into `registerUserKeyRoutes` as the explicit dep.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- --test-name-pattern "parked keys|parking is not configured"`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `npm run verify`
Expected: exit 0, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/http/routes/user-keys.ts src/http/server.ts test/unit/user-keys-routes.test.ts
git commit -m "feat(keys): surface per-key parked status and retry-after"
```

---

### Task 6: Stop one secret becoming two budgets

**Files:**
- Modify: `src/http/routes/chat-completions.ts:552-575`
- Test: `test/unit/user-credentials.test.ts` (create) — or extend the closest existing suite that covers `buildUserCredentials`

**Interfaces:**
- Consumes: `makeCredential` from `src/credentials/pool.ts`
- Produces: `buildUserCredentials` returns one `Credential` per **distinct secret**, regardless of how many rows hold it.

**Why:** the ledger keys on credential id. Two rows holding the same secret would otherwise yield two credentials — and therefore two budgets for one account, making the pool believe in headroom that does not exist. The env path already dedupes (`src/credentials/pool.ts:96` uses a `seen` set); this brings the user path in line.

- [ ] **Step 1: Write the failing test**

```ts
test('buildUserCredentials collapses rows that share a secret', async () => {
  // two rows for 'openrouter' whose decrypted secrets are identical
  // assert: exactly one credential is returned
});
```

Export `buildUserCredentials` for the test if it is not already exported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --test-name-pattern "share a secret"`
Expected: FAIL — two credentials returned.

- [ ] **Step 3: Implement the dedupe**

Track seen secrets in a `Set` and skip a row whose decrypted secret is already present. Keep the existing `nvidia-nim` → `nvidia` normalisation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --test-name-pattern "share a secret"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/routes/chat-completions.ts test/unit/user-credentials.test.ts
git commit -m "fix(keys): collapse duplicate secrets into one credential"
```

---

### Task 7: `/keys` page holds a list per provider

**Files:**
- Modify: `frontend/src/lib/api.ts` (the `KeySummary` interface)
- Modify: `frontend/src/app/keys/page.tsx`
- Test: `cd frontend && npm run build` (this task's checkable result)

**Interfaces:**
- Consumes: the new `GET /v1/user/keys` shape from Task 5
- Produces: a keys page that renders every key per provider.

**Why this is the largest task:** the page's state is `Record<ProviderId, string>` for `fingerprints`, `values`, `editMode` and `operationLoading` (`page.tsx:73-96`), and `isConfigured` is `Boolean(fingerprints[provider.id])` (`:372`) — a provider-level flag that can no longer represent "has keys". The state model, not just the render, has to change.

- [ ] **Step 1: Extend `KeySummary` in `frontend/src/lib/api.ts`**

```ts
export interface KeySummary {
  id: string;
  provider: string;
  label: string;
  fingerprint: string;
  created_at: string;
  updated_at: string;
  parked: boolean;
  retry_after_ms: number;
}
```

- [ ] **Step 2: Change the page state to a list**

Replace the four `Record<ProviderId, …>` maps with `const [keys, setKeys] = useState<KeySummary[]>([])`, populated from the existing `GET /user/keys` effect (`page.tsx:110-160`), which currently copies one fingerprint per provider.

- [ ] **Step 3: Render a row per key**

For each provider in `PROVIDERS`, render its keys from `keys.filter(k => k.provider === provider.id)`. Each row shows the label, the fingerprint, a status of *available* or *throttled — back in `retry_after_ms`*, and a delete button calling `api.delete(\`/user/keys/${provider.id}/${key.id}\`)` followed by a refetch. Replace `isConfigured` with `const configured = keys.some(k => k.provider === provider.id)`.

- [ ] **Step 4: Keep the add form appending**

The existing submit handler (`page.tsx:229`) already POSTs; it must now call the list refetch rather than setting a single provider fingerprint, so a second key for the same provider appears alongside the first.

- [ ] **Step 5: Build**

Run: `cd frontend && npm run build`
Expected: exit 0, no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/app/keys/page.tsx
git commit -m "feat(keys-ui): list every key per provider with status and per-key delete"
```

---

## Done when

- `npm run verify` exits 0, 0 failures, still under ~10 s.
- `cd frontend && npm run build` exits 0.
- Two different keys for one provider both appear on `/keys`, each with its own status and delete.
- Submitting the same key twice returns `409` and leaves one row.
- A second user's key id cannot be read, updated or deleted.
- No ledger read path and no piece-3 behaviour was added.

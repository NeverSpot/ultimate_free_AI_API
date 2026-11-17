# Multi-Key Pooling per Provider — Design

**Date:** 2026-11-17 · **Status:** awaiting approval
**Implements:** Block 25 — *Multi-Key Registration & Per-Provider Key Sharding* (pieces 1 and 2 only)
**Excludes:** piece 3 — no fingerprint/header/UA variation, no IP rotation, no detection-threshold tuning, no account acquisition. Not scoped here and not built.

---

## Intent

A user can register **several provider keys per provider**. Each key is an independent credential with its own budget, so N keys give N times the headroom — and the user can see which of their keys is throttled, and when it comes back.

Why someone holds several keys is their business: this is pooling keys they already control. The design deliberately stops at capacity accounting and visibility.

## What already works (verified against master @ `0e9ab56`)

Three facts shrink this from "a feature" to "a write-path fix":

1. **The read path already handles N keys.** `buildUserCredentials()` (`src/http/routes/chat-completions.ts:565`) calls `listKeys(userId)` and loops over *every* row, pushing one `Credential` per key. Nothing caps it at one.
2. **Per-key budgets already work.** The ledger and the breaker key on the credential id, and for user keys the credential id *is* the DB row id — `makeCredential(provider, key.id, key.id, secret)`. Two rows for one provider therefore already get two independent budgets.
3. **The schema already permits it.** `017_users.sql:27` is `create unique index ... on user_provider_keys (fingerprint)` — unique on **fingerprint alone**, not on `(user_id, provider)`. There is no constraint to change.

What actually blocks multi-key is one line of fingerprint derivation, plus the upsert that depends on it.

> **Correction to the earlier sketch.** I said the migration would "swap the unique constraint from `(user_id, provider)` to `(user_id, fingerprint)`". That was wrong — the constraint is *already* on `fingerprint`. **No migration is required.** The write-up above is the accurate version.

## Approaches considered

**A — Per-key fingerprint, append on POST.** *(chosen)*
The fingerprint stops being a function of `(user, provider)` and becomes a function of the key itself. Everything downstream already keys on the row, so nothing else moves.

**B — A `provider_accounts` table with keys hanging off accounts.** *Rejected.* The router only ever consumes `(model, credential)` pairs, so an account entity adds a join, a migration and a UI concept that nothing reads. YAGNI.

**C — One row per provider holding an encrypted array of keys.** *Rejected.* Breaks per-key revocation and per-key health, and destroys credential identity: the ledger keys on credential id = row id, and array positions are not stable across edits.

**A** is the smallest honest change and lands on a read path already built for it.

## The design

### 1. Fingerprint becomes key-derived

- **Today:** `sha256Hex(\`${userId}:${provider}\`)` — `src/http/routes/user-keys.ts:93`
- **New:** `sha256Hex(\`${userId}\0${provider}\0${providerKey}\`)`, kept as the full 64-char digest.

Properties: distinct per key; still user-scoped, so one user's fingerprint cannot be correlated against another's; re-submitting the same key produces the same fingerprint and collides on the unique index.

### 2. `POST /v1/user/keys` appends

- Body gains an optional `label`.
- Insert. A unique violation on `idx_user_provider_keys_fingerprint` becomes a **`409`** naming the existing key — not the silent replace that happens today, where a second key destroys the first.
- Default label is `${provider}-${n}`, mirroring the env path's naming (`src/credentials/pool.ts:107`).

### 3. Model — `src/models/user-provider-key.ts`

- `listKeysByProvider(userId, provider)` — new; ordered by `created_at`.
- `deleteKeyById(userId, keyId)` — new: `delete ... where id = $1 and user_id = $2`.
- `updateKey(keyId, userId, updates)` — **add `userId` to the WHERE clause.** This closes a latent IDOR: the function's signature takes only `keyId`, and only its single caller's discipline keeps it safe today. The moment a client-supplied key id reaches it — exactly what per-key rename or delete introduces — one user can overwrite another's ciphertext.

### 4. Routes — `src/http/routes/user-keys.ts`

| Route | Behaviour |
|---|---|
| `GET /v1/user/keys` | gains per-key health (below) |
| `POST /v1/user/keys` | appends; `409` on duplicate |
| `DELETE /v1/user/keys/:provider` | unchanged — all keys for that provider |
| `DELETE /v1/user/keys/:provider/:keyId` | new — one key. Two segments keep it unambiguous from the provider-wide delete. |

### 5. Health on the GET response

Each key gains `parked: boolean` and `retry_after_ms: number`, read from `isParked(key.id)` (`src/resilience/parking.ts:175`), which returns `ParkingStatus { parked, retryAfterMs }` derived from the park key's `PTTL`. **No new state and no new Redis namespace** — parking already keys per credential under `cd:<credentialId>`.

### 6. Resolver hardening — `buildUserCredentials()`

Add a secret-level dedupe, matching what the env path already does (`src/credentials/pool.ts:96` uses a `seen` set). Two rows holding the same secret would otherwise become two credentials that each get a budget — **double-counting one account's capacity**, so the pool believes it has headroom that does not exist.

### 7. Frontend — `frontend/src/app/keys/page.tsx`

Group by provider; each row shows label, fingerprint, status (available, or throttled with a countdown) and a delete button. The session-scoped gateway-key flow is unchanged.

## Non-goals

- **Piece 3**, explicitly: no fingerprint/header/UA variation, no IP rotation, no thresholds tuned to stay under provider detection, no account acquisition.
- **Per-key remaining counts** ("37 left"). The `Ledger` interface is deliberately write-only — `reserve` / `release` / `commit`, with no read method (`src/limits/ledger.ts:49`). Surfacing a count means adding a read path across every `(credential, model, window)` key. Parked/available is the actionable signal and costs nothing. Revisit only if the count is genuinely missed.
- **The router, the ledger, and `pool.ts`'s env path.** They already handle N keys.

## Risks

| Risk | Mitigation |
|---|---|
| Legacy rows keep old-format fingerprints, so re-submitting an existing key creates a duplicate row instead of `409` | Read-time dedupe keeps budgets correct; a backfill script can normalise fingerprints if the cosmetic duplicate matters. Follow-up, not a blocker. |
| Two rows holding one secret silently double the apparent budget | The dedupe in §6. Gets its own test. |
| A client-supplied key id reaching a query | Every new query scopes `user_id`, and §3 adds it to `updateKey`. Test that user B's key id is unreadable, unmodifiable and undeletable by user A. |

## Testing

Repo conventions — the standard suite `npm run verify` runs. **No separate simulation harness.** Coverage: append-then-list returns two rows; duplicate key → `409`; N rows → N credentials; cross-user key id → rejected on read, update and delete; dedupe by secret; a parked key reports `parked: true` with a positive `retryAfterMs`.

## Calls I made — check these while reading

1. Delete route shape: `/:provider/:keyId` rather than `/:keyId`, which would collide with the provider name on a single path segment.
2. **`409`** on duplicate submission, rather than `200` with the existing key, so a client cannot mistake a no-op for a successful add.
3. Full 64-char fingerprint rather than the 16-char truncation `pool.ts` uses for credential ids — it backs a unique index, so truncation buys nothing and costs collision risk.
4. Dedupe by secret at read time, rather than rejecting duplicate secrets at write time.

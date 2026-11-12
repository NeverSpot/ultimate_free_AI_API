# Phase C — Be good, not just available (Blocks 11–15)

> **Source of truth:** `PROJECT.md` §253–327 (Blocks 11–15 spec), Gates table §99, Directory layout §382.
> **Gate:** Policy test (`npm run test -- --test-name-pattern "policy"`) — swap routing store, `route()` untouched.
> **Verifier:** `npm run verify` (typecheck + lint + format:check + 233 unit + 27 integration).

---

## Block 11 — Accounting + Postgres

### Goal
Write one `requests` row per **terminal path** (success, failure, timeout, aborted). Spec schema: two tables (`requests` + `credentials`), no `gateway_keys` table.

### Files to Create/Modify
- `migrations/011_accounting.sql` — `requests` + `credentials` tables per PROJECT.md §255–288 exactly + indexes (`requests(created_at)`, `(provider, model, created_at)`, `(gateway_key_id, created_at)`, `(credential_id, created_at)`). **No `gateway_keys` table in spec — `gateway_key_id` is a bare `uuid` in `requests` (unresolved for now; the `gateway_keys` table may be added only if auth lands in this block, explicitly noting the deviation)**
- `src/telemetry/store.ts` — insert in `finally` block, batched, NUMERIC for money
- `src/core/execute.ts` — wire accounting after each attempt
- `test/integration/accounting.test.ts` — each path writes exactly one row

### Acceptance Criteria
```bash
npm run test:int -- --test-name-pattern "accounting"
# → success / failure / timeout / aborted each = 1 row
```

### Deviation Log
- (none yet — will record if schema shifts from `PROJECT.md`)

---

## Block 12 — Eval Harness

### Goal
100 self-grading prompts (25 × 4 buckets × 3 runs), emit markdown table with **n stated per cell**. No LLM-as-judge — circular and costs money.

### Files to Create/Modify
- `src/eval/prompts/` — 4 buckets, 25 files each, JSON Schema / exact match / hidden unit tests pass@1 / field-level exact match or F1
- `src/eval/grade.ts` — deterministic graders per bucket
- `src/eval/run.ts` — orchestration, markdown output
- `package.json` — add `npm run eval`

### Acceptance Criteria
```bash
npm run eval
# → markdown table with **n=3** stated per cell, pass@1 per bucket
```

### Deviation Log
- (none yet)

---

## Block 13 — `route()` + Routing-Table Store

### Goal
Extract `route(rankedCandidates, store)` pure function — takes ranked candidates from Block 9 and applies the routing table. Two stores: `json-store.ts` (hand-written) + `eval-store.ts` (eval scores). Policy test = swap store, `route()` untouched.

### Files to Create/Modify
- `src/routing/route.ts` — pure function: `route(rankedCandidates: Candidate[], store: RoutingStore) => Candidate[]`
- `src/routing/store.ts` — interface `RoutingStore { getScores(): Promise<Map<string, number>> }`
- `src/routing/json-store.ts` — reads static JSON
- `src/routing/eval-store.ts` — reads eval harness output
- `test/unit/policy.test.ts` — swap stores, assert identical `route()` path

### Acceptance Criteria
```bash
npm run test -- --test-name-pattern "policy"
# → both stores produce same ranked output for same candidates
```

### Deviation Log
- (none yet)

---

## Block 14 — User Spend Budget

### Goal
Pre-dispatch atomic reserve of **worst-case cost** via Lua; reconcile against actual `usage`; release delta. Reject with 429 *before* dispatch if cap would be exceeded.

### Files to Create/Modify
- `migrations/014_spend_budgets.sql` — `spend_budgets` table (user_id, cap_usd, period, reserved_usd)
- `src/budget/limiter.ts` — `reserve(key, worstCaseUsd)`, `reconcile(key, actualUsd)`, `release(key)`
- `src/budget/reserve.lua` — atomic check-and-decrement
- `src/core/execute.ts` — call reserve before first attempt, reconcile in finally
- `test/integration/budget.test.ts` — over-cap request → 429 before dispatch

### Acceptance Criteria
```bash
npm run test:int -- --test-name-pattern "budget"
# → request over cap = 429, zero upstream cost
```

### Deviation Log
- (none yet)

---

## Block 15 — Idempotency Keys

### Goal
`Idempotency-Key` → Redis, replay stored response, single-flight lock on concurrent duplicates. Streaming: store full response or last chunk + DONE.

### Files to Create/Modify
- `src/http/middleware/idempotency.ts` — Fastify preHandler, single-flight with `SET NX PX`
- `src/http/routes/chat-completions.ts` — integrate middleware, handle streaming replay
- `test/integration/idempotency.test.ts` — same key twice = 1 upstream call, 2 identical responses

### Acceptance Criteria
```bash
npm run test:int -- --test-name-pattern "idempotency"
# → duplicate key = 1 upstream call, identical body
```

### Deviation Log
- (none yet)

---

## Phase C Gate Summary

| Block | Verification Command | Status |
|-------|----------------------|--------|
| 11 | `npm run test:int -- --test-name-pattern "accounting"` | passed |
| 12 | `npm run eval` | passed |
| 13 | `npm run test -- --test-name-pattern "policy"` | passed |
| 14 | `npm run test:int -- --test-name-pattern "budget"` | passed |
| 15 | `npm run test:int -- --test-name-pattern "idempotency"` | pending |
| **Gate** | `npm run test -- --test-name-pattern "policy"` (swap store) | passed |

---

## Known Deviations from PROJECT.md (Decision Log)

| Block | PROJECT.md Spec | Actual Decision | Rationale | Date |
|-------|----------------|----------------|-----------|------|
| 11 | Two tables (`requests`, `credentials`); `gateway_key_id` is bare `uuid` | Add `gateway_keys` table *only if* auth lands in Block 11; otherwise leave unresolved FK | Spec has no `gateway_keys` table but FK semantics imply one; deferring to avoid scope creep | 2026-11-12 |
| 12 | 25 prompts per bucket × 4 buckets × 3 runs | Code generation bucket uses hidden unit tests, pass@1 | Matches "hidden unit tests, pass@1" in spec | 2026-11-12 |
| 13 | `route(rankedCandidates, store)` takes ranked candidates from Block 9 | Interface as `RoutingStore` with `getScores()`; `route()` applies table | Matches spec exactly | 2026-11-12 |
| 14 | Pre-dispatch reserve, reconcile, release delta | Atomic Lua reserve of worst-case cost; reject 429 before dispatch | Matches spec | 2026-11-12 |
| 15 | `Idempotency-Key` → Redis, replay, single-flight | Same | Matches spec | 2026-11-12 |

*Add rows as decisions diverge. Keep concise; cite ADR if needed.*
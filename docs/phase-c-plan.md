# Phase C — Be good, not just available (Blocks 11–15)

> **Source of truth:** `PROJECT.md` §253–327 (Blocks 11–15 spec), Gates table §99, Directory layout §382.
> **Gate:** Policy test (`npm run test -- --test-name-pattern "policy"`) — swap routing store, `route()` untouched.
> **Verifier:** `npm run verify` (typecheck + lint + format:check + 233 unit + 27 integration).

---

## Block 11 — Accounting + Postgres

### Goal
Write one `requests` row per **terminal path** (success, failure, timeout, aborted). Replace temp auth with `gateway_keys` table.

### Files to Create/Modify
- `migrations/011_accounting.sql` — `requests`, `credentials`, `gateway_keys` tables + indexes
- `src/telemetry/store.ts` — insert in `finally` block, batched, NUMERIC for money
- `src/core/execute.ts` — wire accounting after each attempt
- `src/http/routes/chat-completions.ts` — extract gateway key, pass to execute
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
100 self-grading prompts (25 × 4 buckets × 3 runs), emit markdown table with **n stated per cell**. No LLM-as-judge.

### Files to Create/Modify
- `src/eval/prompts/` — 4 buckets, 25 files each, JSON Schema / exact match / unit tests / field-level F1
- `src/eval/grade.ts` — deterministic graders per bucket
- `src/eval/run.ts` — orchestration, markdown output
- `package.json` — add `npm run eval`

### Acceptance Criteria
```bash
npm run eval
# → markdown table with n=3 per cell, pass rates per bucket
```

### Deviation Log
- (none yet)

---

## Block 13 — `route()` + Routing-Table Store

### Goal
Extract `route(candidates, store)` pure function. Two stores: `json-store.ts` (hand-written) + `eval-store.ts` (eval scores). Policy test = swap store, `route()` untouched.

### Files to Create/Modify
- `src/routing/route.ts` — pure function: `route(candidates: Candidate[], store: RoutingStore) => Candidate[]`
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
| 11 | `npm run test:int -- --test-name-pattern "accounting"` | pending |
| 12 | `npm run eval` | pending |
| 13 | `npm run test -- --test-name-pattern "policy"` | pending |
| 14 | `npm run test:int -- --test-name-pattern "budget"` | pending |
| 15 | `npm run test:int -- --test-name-pattern "idempotency"` | pending |
| **Gate** | `npm run test -- --test-name-pattern "policy"` (swap store) | pending |

---

## Known Deviations from PROJECT.md (Decision Log)

| Block | PROJECT.md Spec | Actual Decision | Rationale | Date |
|-------|----------------|----------------|-----------|------|
| — | — | — | — | — |

*Add rows as decisions diverge. Keep concise; cite ADR if needed.*
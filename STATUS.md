# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 12 — Eval harness
- **Last green verify:** `npm run verify` -> exit 0, **238 hermetic tests** (+33 integration)
- **Phase A (Aggregate): COMPLETE.** Blocks 1–10 merged to master at `7bdb247`.
- **Phase B (Survive 429): COMPLETE.** Capacity gate passed (3 creds @ 30 RPM → 60 RPM).

## Done

- Blocks 1–10: Core router, ledger, circuit breaker, failover ladder, SSE streaming
- Block 11: Accounting + Postgres telemetry store (one row per terminal path: success, failed, timeout, aborted)
  - `migrations/011_accounting.sql`, `src/telemetry/store.ts`, batched inserts, finally accounting in execute/executeStream

## Next

- Block 12 — Eval harness (`src/eval/`, 100 prompts, 25 per bucket, exact-match / JSON schema)

## Open items

- Ledger ceilings still null — hydrate from registry or `GET /auth/key`
- `parkUntil` has no channel through `ProviderError`; Block 9 calls `rateLimitVerdict()` directly
- `release()` not rollover-safe; needs a reservation token
- Pre-existing integration failure: `ledger: an exhausted rpw blocks even when rpm is clean` (test/integration/ledger.test.ts:119)

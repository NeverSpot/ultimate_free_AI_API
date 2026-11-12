# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 14 — User spend budget
- **Last green verify:** `npm run verify` -> exit 0, **289 hermetic tests** (+39 integration)
- **Phase A (Aggregate): COMPLETE.** Blocks 1–10 merged to master at `7bdb247`.
- **Phase B (Survive 429): COMPLETE.** Capacity gate passed (3 creds @ 30 RPM → 60 RPM).

## Done

- Blocks 1–10: Core router, ledger, circuit breaker, failover ladder, SSE streaming
- Block 11: Accounting + Postgres telemetry store (one row per terminal path)
- Block 12: Eval harness (100 self-grading prompts, 25 per bucket, exact-match / JSON schema)
- Block 13: `route()` + table store (json-store, eval-store, policy gate test)
- Block 14: User spend budget (`migrations/014_spend_budgets.sql`, `src/budget/limiter.ts`, `src/budget/reserve.lua`, execute integration, 429 before dispatch)

## Next

- Block 15 — Idempotency keys (`Idempotency-Key` -> Redis, replay stored response)

## Open items

- Ledger ceilings still null — hydrate from registry or `GET /auth/key`
- `parkUntil` has no channel through `ProviderError`; Block 9 calls `rateLimitVerdict()` directly
- `release()` not rollover-safe; needs a reservation token

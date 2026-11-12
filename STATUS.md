# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 15 — Idempotency keys
- **Last green verify:** `npm run verify` -> exit 0, **288 hermetic tests** (+27 integration)
- **Phase A (Aggregate): COMPLETE.** Blocks 1–10 merged to master at `7bdb247`.
- **Phase B (Survive 429): COMPLETE.** Capacity gate passed (3 creds @ 30 RPM → 60 RPM).
- **Phase C (Smarter Router): IN PROGRESS.** Blocks 11-13 & 15 done.

## Done

- Block 11: Accounting + Postgres telemetry store
- Block 12: Eval harness (100 prompts, 4 buckets, deterministic graders, n=3 markdown)
- Block 13: `route()` pure function, RoutingStore interface, JSON & eval stores, policy gate test
- Block 15: `Idempotency-Key` -> Redis lock & response cache, streaming/non-streaming replay, single-flight

## Next

- Block 14 (User spend budget) / Block 16 (Load test + metrics)

## Open items

- Ledger ceilings still null — hydrate from registry or `GET /auth/key`
- `parkUntil` has no channel through `ProviderError`; Block 9 calls `rateLimitVerdict()` directly
- `release()` not rollover-safe; needs a reservation token

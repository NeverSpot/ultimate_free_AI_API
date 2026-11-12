# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** Phase C complete (Blocks 11–15 done), Block 16 next
- **Last green verify:** `npm run verify` -> exit 0, **299 hermetic tests** (+39 integration)
- **Phase A (Aggregate): COMPLETE.** Blocks 1–10 merged to master at `7bdb247`.
- **Phase B (Survive 429): COMPLETE.** Capacity gate passed (3 creds @ 30 RPM → 60 RPM).
- **Phase C (Be good, not just available): COMPLETE.** Blocks 11–15 merged to master. Policy gate test passed.

## Done

- Block 11: Accounting + Postgres telemetry store (one row per terminal path)
- Block 12: Eval harness (100 prompts, 4 buckets, deterministic self-graders, n=3 markdown)
- Block 13: `route()` pure function, RoutingStore interface, JSON & eval stores, policy gate test
- Block 14: User spend budget (atomic Lua reserve, reconcile, release delta, 429 before dispatch)
- Block 15: `Idempotency-Key` -> Redis lock & response cache, streaming/non-streaming replay, single-flight

## Next

- Phase D / Block 16 — Mock-upstream load test (Artillery load test, p50/p95/p99)

## Do not touch without a human

`PROJECT.md` structure, `.env` / `.env.local`, git history rewrites, `git push` (no remote).

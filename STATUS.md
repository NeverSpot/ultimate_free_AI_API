# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 11 — Accounting + Postgres (telemetry store)
- **Last green verify:** `npm run verify` -> exit 0, **233 hermetic tests** (+27 integration)
- **Phase A (Aggregate): COMPLETE.** Blocks 1–10 merged to master at `7bdb247`.
- **Phase B (Survive 429): COMPLETE.** Capacity gate passed (3 creds @ 30 RPM → 60 RPM, zero client 429s).

## Done

- Block 6: multi-window ledger (rpm/rpd/rpw, atomic Lua, max-wait + window tag)
- Block 7: shared error classifier; 429 split by verdict (rate_limited vs exhausted)
- Block 8: circuit breaker per (provider, model) in Redis + credential parking per credential
  - OPEN breaker makes zero network calls (proven by fetch spy counter)
  - Dead key is not a dead provider
- Block 9: capacity-aware select + failover ladder (pure `route()`, one `execute()` loop)
- Block 10: SSE streaming for `/v1/chat/completions` (`src/http/sse.ts`, `router-runtime.ts`, streaming pipeline)

## Next

- Block 11 — Accounting + Postgres (one row per terminal path; success, failure, timeout, abort)

## Open items

- Ledger ceilings still null — hydrate from registry or `GET /auth/key`
- `parkUntil` has no channel through `ProviderError`; Block 9 calls `rateLimitVerdict()` directly
- `release()` not rollover-safe; needs a reservation token
- Pre-existing integration failure: `ledger: an exhausted rpw blocks even when rpm is clean` (test/integration/ledger.test.ts:119)

## Do not touch without a human

`PROJECT.md` structure, `.env` / `.env.local`, git history rewrites, `git push` (no remote).

# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 9 — wire breaker + parking into the request path (delegated)
- **Last green verify:** `npm run verify` -> exit 0, **206 hermetic tests** (+27 integration)
- **Phase A: COMPLETE.**

## Done

- Block 6: multi-window ledger (rpm/rpd/rpw, atomic Lua, max-wait + window tag)
- Block 7: shared error classifier; 429 split by verdict (rate_limited vs exhausted)
- Block 8: circuit breaker per (provider, model) in Redis + credential parking per credential
  - OPEN breaker makes zero network calls (proven by fetch spy counter)
  - Dead key is not a dead provider

## Open items

- Ledger ceilings still null — Block 7/8 must hydrate from registry or GET /auth/key
- parkUntil has no channel through ProviderError; Block 9 calls rateLimitVerdict directly
- release() not rollover-safe; needs a reservation token at Block 9
- Capacity test gates Phase B (after Block 9)

## Do not touch without a human

`PROJECT.md` structure, `.env` / `.env.local`, git history rewrites, `git push` (no remote).

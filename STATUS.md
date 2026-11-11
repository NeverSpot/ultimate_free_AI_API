# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 8 — circuit breaker + credential parking (delegated)
- **Last green verify:** `npm run verify` -> exit 0, **192 hermetic tests** (+13 integration)
- **Phase A: COMPLETE.** Phase B: Blocks 6-7 done, 8 in flight.

## Done in Phase B

- Block 6 `167c08f` — multi-window ledger (rpm/rpd/rpw, one atomic Lua, max-wait + window tag)
- Block 7 `cd3228e` — one shared error classifier; 429 split by verdict, not status:
  ordinary throttle -> rate_limited, Token Harbor free allowance -> exhausted (503), and its
  Retry-After of 3600 dropped as a ~170x lie against a 7-day reset

## Open items

- Ledger ceilings still `null` — nothing refuses a real provider until 8/9 hydrate them
- `parkUntil` has no channel through `ProviderError`; Block 9 must call `rateLimitVerdict()`
- `release()` not rollover-safe (needs a reservation token at Block 9)
- Capacity test now gates Phase B, after Block 9

## Do not touch without a human

`PROJECT.md` structure, `.env` / `.env.local`, git history rewrites, `git push` (no remote).

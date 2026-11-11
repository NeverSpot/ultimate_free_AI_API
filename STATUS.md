# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 7 — error classification + 429 semantics (Phase B), delegated
- **Last green verify:** `npm run verify` -> exit 0, **155 hermetic tests**
- **Phase A: COMPLETE.**

## Where we are

- Blocks 0-6 done. 155 hermetic + 13 integration tests.
- Block 6 shipped the multi-window ledger (`rpm`/`rpd`/`rpw`, one atomic Lua, max-wait,
  blocking window returned). Race proven with a non-atomic control that admitted 2 of 2.
- Build fixed: `scripts/copy-assets.mjs` ships `.lua` into `dist/`.
- Gate fixed: integration tests opt in via `npm_lifecycle_event === 'test:int'`, so an
  ambient `DATABASE_URL` no longer silently adds 5 tests to verify.

## Known gaps (deliberate, tracked)

- Ledger ceilings are `null` until Block 7/8 hydrate them — no real provider refuses yet.
- `release()` is not rollover-safe; needs a reservation token at Block 9.
- `retryAfterMs` is a floor; nothing consumes the window tag to park yet (Block 7).
- No `select()` snapshot for Block 9.

## Do not touch without a human

`PROJECT.md` structure, `.env` / `.env.local`, git history rewrites, `git push` (no remote).

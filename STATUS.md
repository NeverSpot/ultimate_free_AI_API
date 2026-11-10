# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 6 — rate-limit ledger (Phase B), delegated
- **Last green verify:** `npm run verify` -> exit 0, 149 hermetic tests
- **Phase A: COMPLETE** — aggregation done, Provider test passes.

## Phase A result

- [x] Blocks 0-5: Fastify layer, 3 adapters, credential pool, provider registry, Postgres persistence
- [x] `npm run smoke` live 3/3 · `npm run registry:list` 597 models · `npm run registry:sync` idempotent
- [x] **Provider test passes** (4th adapter, zero edits to existing files)
- [x] Last-known-good and delisting both proven live against real Postgres

## Plan correction

Copacity test moved from the Phase A gate to the **Phase B gate** — it needs the ledger
(Block 6) and the selector (Block 9). Content unchanged; only when it can run.

## Do not touch without a human

`PROJECT.md` structure, `.env` / `.env.local`, git history rewrites, `git push` (no remote).

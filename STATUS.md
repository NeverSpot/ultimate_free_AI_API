# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 5 — Postgres model registry (delegated, in flight)
- **Last green verify:** `npm run verify` -> exit 0, 134 tests, ~5s
- **Mode:** unattended overnight run. Target: finish **Phase A**.

## Overnight progress (2026-11-11)

- [x] Block 4 — registry + discovery + `registry:list` (599 models, 20 free, 3.2s) + Provider test
- [x] Single composition root `src/providers/defaults.ts`; invariant 2 restated truthfully
- [ ] Block 5 — Postgres `models` table, idempotent migrations, hourly refresh, last-known-good
- [ ] **Phase A gate** — Capacity test (3 credentials at 30 RPM serving 60 RPM, zero client 429s)

## Done

Blocks 0-4. Three adapters (NVIDIA / OpenRouter / Token Harbor), credential pool, provider
registry, `npm run smoke` live 3/3, 134 hermetic tests.

## Do not touch without a human

`PROJECT.md` structure, `.env` / `.env.local`, git history rewrites, `git push` (no remote exists).

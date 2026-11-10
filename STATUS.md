# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 4 — provider registry + free-model discovery (delegated, in flight)
- **Last green verify:** `npm run verify` -> exit 0, 124 tests, ~1s
- **Mode:** unattended overnight run. Target: finish **Phase A** (Blocks 4, 5, then the gate).

## Overnight plan (2026-11-11)

1. Block 4 — registry + discovery + `npm run registry:list` + the Provider test (4th adapter, zero edits).
2. Block 5 — Postgres `models` table, versioned migrations, hourly refresh, last-known-good retention.
3. **Phase A gate** — Provider test and the Capacity test (3 credentials at 30 RPM serving 60 RPM
   with zero client-visible 429s) must both pass.

## Done

- Blocks 0-3d: Fastify layer, three adapters, credential pool. 124 hermetic tests.
- `npm run smoke` passes live on all three providers (26s).
- Provider ids unified across pool / adapters / smoke; guarded by `provider-identity.test.ts`.
- CodeGraph indexed and adopted (AGENTS.md rule: `codegraph impact` before interface edits).

## Known red

- none

## Do not touch without a human

- `PROJECT.md` structure, `.env` / `.env.local`, git history rewrites, `git push` (no remote exists).

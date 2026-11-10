# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 0 — scaffold (complete, not yet committed)
- **Last green verify:** `npm run verify` passes on the scaffold
- **Next action:** commit the scaffold, then start Block 1 in `PROJECT.md`.

## Done

- git repo, tsconfig (strict, ES2022, CommonJS), build + typecheck split
- `npm run verify` gate: typecheck -> lint -> format -> tests
- Postgres 16 + Redis 7 via `docker compose up --wait`
- `AGENTS.md`, `CLAUDE.md` shim, Copilot instructions, docs skeleton

## Known red

- none

## Do not touch

- `PROJECT.md` structure — it is the spec of record
- `.env` / `.env.local` — real keys live there, never committed

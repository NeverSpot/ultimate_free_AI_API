# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 3 — Adapters + credential pool (implemented, verified, committed)
- **Last green verify:** `npm run verify` → exit 0, 124 tests, ~1.1s
- **Next action:** start Block 4 in `PROJECT.md` — Free-model discovery (`src/providers/registry.ts`, `npm run registry:list`).

## Done

- Block 1: Canonical types (`core/types.ts`), errors, IDs, mock adapter with injected RPM & failures
- Block 2: Fastify 5 server, `/v1/chat/completions` buffered path, `/healthz` probe aggregation
- Block 3: Adapters (`nvidia`, `openrouter`, `tokenharbor`) + `src/credentials/pool.ts` (SHA-256 stable IDs)
- End-to-end multi-provider live test runner: `npm run smoke` (scripts/smoke.ts)
- Total tests: 124 passing unit tests; CodeGraph adopted for structural analysis

## Known red

- none

## Do not touch

- `PROJECT.md` structure — it is the spec of record
- `.env` / `.env.local` — real keys live there, never committed

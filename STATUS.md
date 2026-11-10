# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** 2 — HTTP buffered path (implemented, verified, committed)
- **Last green verify:** `npm run verify` → exit 0, 19 tests, ~0.9s
- **Next action:** start Block 3 in `PROJECT.md` — real adapters (NVIDIA NIM, OpenRouter, Token Harbor) + the credential pool.

## Done

- Block 1 types pulled forward: `core/types.ts`, `core/errors.ts`, `core/ids.ts`
- `providers/types.ts` + deterministic `providers/mock.ts`
- `config/env.ts` — injected env, validates every problem at once
- Fastify 5 server: request-id hook, bearer auth, 501 boundary, OpenAI error envelope
- `/healthz` takes injected probes; unwired probes report `unknown`, never `ok`
- `test/unit/http.test.ts` — 14 `app.inject()` cases; 19 tests total

## Known red

- none

## Do not touch

- `PROJECT.md` structure — it is the spec of record
- `.env` / `.env.local` — real keys live there, never committed

# AGENTS.md

Operating manual for coding agents. Read `PROJECT.md` for the plan. This file holds
only what you cannot infer from the code.

**What this is:** one OpenAI-compatible endpoint in front of a pool of user-provided
LLM provider keys, with a Redis rate-limit ledger, capacity-first routing and failover.

**Out of scope — do not add:** UI or dashboard, semantic caching, billing, multi-region,
account creation or identity rotation.

## Commands

Run from the repo root. **If a command is not in this table, it does not exist yet.**

| Task | Command |
|---|---|
| install | `npm ci` |
| dev (watch) | `npm run dev` |
| build + run | `npm run build && npm start` |
| **verify — the gate** | `npm run verify` |
| one test file | `npm run test -- test/unit/foo.test.ts` |
| one test by name | `npm run test -- --test-name-pattern "ledger race"` |
| typecheck | `npm run typecheck` |
| lint / autofix | `npm run lint` / `npm run lint:fix` |
| postgres + redis | `npm run db:up` / `npm run db:down` |

`npm run verify` = typecheck -> lint -> format check -> tests, fail-fast. It must stay
under ~10s. A change that makes it slower is a bug.

## Architecture that is not visible from filenames

The request lifecycle is ordered. Do not reorder it.

1. normalise the client request to the canonical schema
2. build candidates: `(model, credential)` pairs with capacity left and breaker CLOSED
3. rank: capacity -> task fit -> least-recently-used spread -> quality tie-break
4. atomically reserve budget for the chosen pair (Redis, one Lua script)
5. execute with the failover ladder
6. reconcile actual usage, emit exactly one accounting event
7. stream or buffer to the client

- `select()` and `route()` are **pure functions**: no Redis, no `fetch`, no `Date.now()`.
  Time and availability are passed in.
- The routing target is a **(model, credential) pair**. Never a bare model.
- The Redis ledger is the only source of truth for remaining budget.

## Invariants — violating these is a bug even if tests pass

1. Rate limits are discovered at runtime. Never hardcode an RPM / RPD / TPM number.
2. Adding a provider = one new adapter file and zero edits elsewhere.
3. Every terminal path (success, parked 429, open breaker, timeout, client abort) writes
   exactly one accounting row. Write it in `finally`.
4. Breaker transitions are `CLOSED`/`OPEN`/`HALF_OPEN` only, stored in Redis, never in a
   module-level variable.
5. Streaming failover is allowed only **before the first token**.

## Where things live

| Path | Holds |
|---|---|
| `src/core/` | canonical types, `select()`, `route()`, `execute()` |
| `src/http/` | Express app, routes, middleware |
| `src/providers/` | one adapter per provider, plus the mock adapter |
| `src/credentials/` | the credential pool |
| `src/limits/` | Redis rate-limit ledger and its Lua script |
| `src/resilience/` | breaker, error classification, `retry-after` parsing |
| `src/telemetry/` | Postgres accounting |
| `src/eval/` | deterministic eval harness |
| `test/unit/` | hermetic tests — no network, no Docker |
| `docs/` | architecture, testing, ADRs — read on demand, never auto-loaded |

## Conventions

- CommonJS compiled by `tsc` to `dist/`. Tests run straight off `.ts` via `tsx`.
- Errors use OpenAI's envelope: `{"error":{"type","message","code"}}`. Never throw raw strings.
- Validate at the boundary; internal code trusts typed values.
- No new production dependency without asking.

## Forbidden

- Do not edit `dist/`, `node_modules/`, or `package-lock.json` by hand.
- Do not commit `.env` / `.env.local` / any real key. Template is `.env.example`.
- Do not hardcode provider rate limits.
- Do not change the adapter interface or the `route()` signature without an ADR.
- Do not `git push`, force-push, or delete branches.
- Do not add a UI or dashboard.

## Done means

`npm run verify` exits 0 and you paste its last lines as evidence. "Looks done" is not
done. The four gate tests in `PROJECT.md` §5 must keep passing after every block.

## Where state lives

- `STATUS.md` — where the last session stopped. Read it first, rewrite it last.
- `PROJECT.md` — the plan and the spec of record. Do not restructure it.
- `docs/adr/` — why a decision was made. Cite by ID.
- `git log --oneline` — one commit per block, `feat(block-NN): ...`.

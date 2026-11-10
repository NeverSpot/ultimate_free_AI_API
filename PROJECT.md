# Free-Tier LLM Gateway (BYOK)

A **free-tier aggregator and fallback manager** behind one OpenAI-compatible endpoint.

---

## 1. The problem this actually solves

Free provider tiers throttle hard. A single key on a strong model typically allows
roughly **30 requests per minute** — and each provider caps per-model, per-minute,
sometimes per-day. Cross that ceiling and *every* request returns `429` until the
window resets. Your app looks broken for the rest of the minute.

The usual coping strategies are all bad: sleep and retry (wastes your time),
hardcode a second provider (triples your code), or keep five keys in five `.env`
files and pick one by hand (forgets which is exhausted).

> **All limit figures are discovered at runtime, never hardcoded.**
> Free-tier limits change monthly and differ per model. Hardcoding them is the
> single fastest way to make this project stale.

## 2. What the gateway does

It accepts a **pool of user-provided keys** — several keys per provider, across
several providers — and turns them into one endpoint with **pooled capacity**.

- Tracks remaining budget per **(credential, model, window)** in Redis.
- Discovers which models each key can actually reach, and which of those are free.
- Routes each request to a target that **still has capacity** and is good at the task.
- Spreads load so one key is not exhausted while others sit idle.
- On `429`, reads the provider's `retry-after`, parks that credential, and reroutes.

Result: a pool of N free keys behaves like one endpoint with N x the ceiling, and
the caller never sees a `429`.

```
client request (OpenAI format)
  -> normalise to canonical schema
  -> candidates = (model, credential) pairs with capacity left, breaker CLOSED
  -> rank by task-fit score, then remaining budget, then least-recently-used
  -> atomically reserve budget for the chosen (model, credential)
  -> execute with failover ladder
       on 429 -> park credential until retry-after, next candidate
       on 5xx/timeout -> open breaker, next candidate
  -> stream or buffer response
  -> reconcile usage, emit terminal accounting event (every path)
```

## 3. Routing signal order

This order is the whole design. It differs from a normal LLM gateway:

| Priority | Signal | Why |
|---|---|---|
| 1 | **Capacity** — does this (model, credential) have budget left? | A brilliant model at 0 RPM is useless |
| 2 | **Task fit** — eval score in this bucket | After availability, pick the best available |
| 3 | **Spread** — least-recently-used credential | Prevent exhausting one key while others idle |
| 4 | Quality within the bucket | Tie-break only |

## 4. Foundation vs layer

| Component | Classification | Early requirement |
|---|---|---|
| Canonical schema + adapter interface | **Foundation** | Block 1 |
| **Credential pool (N keys per provider)** | **Foundation** | env-backed list from Block 3 |
| **Rate-limit ledger per (credential, model, window)** | **Foundation** | Redis, Block 6 |
| `route()` — capacity-aware selector | **Foundation** | pure function, no I/O |
| Circuit breaker state | **Foundation** | `CLOSED/OPEN/HALF_OPEN` in Redis |
| Failover ladder | **Foundation** | one loop inside `execute()` |
| Accounting event | **Foundation** | every terminal path |
| Free-model discovery / registry | Layer | after the selector exists |
| Eval harness | Layer | after the router exists |
| Key vault (AES-256-GCM) | Layer | env vars behind `getCredential()` |
| User spend budget | Layer | only matters for paid keys |
| Idempotency keys | Layer | after accounting |
| Semantic cache | **Dropped** | silent wrong answers |
| Dashboard / UI | **Dropped** | curl + README tables |

## 5. Foundation tests — the gate

No feature work begins until all four pass, and they re-run after every block.

> Naming note: the generic template calls these Extensibility / Substitution / Failure / Product. They are the same four; the project-specific names above are canonical here.

1. **Provider test** — add a 4th provider by writing one adapter file. No other edits.
2. **Policy test** — swap routing source from hand-written JSON to eval scores. `route()` untouched.
3. **Failure test** — kill one provider mid-load-run: p95 degrades, **success rate stays 100%**.
4. **Capacity test** — 3 mock credentials at 30 RPM each, a client asking for 60 RPM: **zero 429s reach the client**, throughput ≈ 90 RPM.

Test 4 is the one that proves the product exists.

---

## 6. Build blocks

**Rules of the build**

- One block at a time. Never two in flight.
- A block is finished when its **Done when** line passes — not when it feels done.
- Commit at the end of every block. One block, one commit, message = block number.
- **Learn comes first.** 20 min reading, 40 min spike, then build.
- If a block overruns 2x, cut scope — do not extend the block.

**Phases:** A = aggregate keys · B = survive 429 · C = be good, not just available · D = prove it.

**Verification contract.** Every block closes on a runnable command, never on prose.
Each command is created by the block that needs it — `AGENTS.md` lists only the ones
that exist today, so a command below becomes real when its block lands.

| # | Block | Closes when this exits 0 |
|---|---|---|
| 1 | Canonical schema + mock adapter | `npm run test -- --test-name-pattern "mock adapter"` |
| 2 | HTTP buffered path | `npm run smoke` (HTTP 200 + `choices[0].message.content`) |
| 3 | Adapters + credential pool | `npm run smoke -- --provider openrouter` (also `nvidia`, `tokenharbor`) |
| 4 | Free-model discovery | `npm run registry:list` (table of free models per provider) |
| 5 | Model registry table | `npm run db:migrate && npm run test:int -- --test-name-pattern "registry"` |
| 6 | Rate-limit ledger | `npm run test -- --test-name-pattern "ledger race"` |
| 7 | Error classification | `npm run test -- --test-name-pattern "classify"` (every taxonomy row) |
| 8 | Breaker / credential parking | `npm run test -- --test-name-pattern "breaker"` (0 calls while OPEN) |
| 9 | Capacity select + failover | `npm run test -- --test-name-pattern "capacity"` (0 client 429s) |
| 10 | Streaming (SSE) | `npm run test -- --test-name-pattern "sse"` (split chunk reassembles) |
| 11 | Accounting + Postgres | `npm run test:int -- --test-name-pattern "accounting"` (1 row per path) |
| 12 | Eval harness | `npm run eval` (markdown table, `n` stated per cell) |
| 13 | `route()` + table store | `npm run test -- --test-name-pattern "policy"` |
| 14 | User spend budget | `npm run test:int -- --test-name-pattern "budget"` (429 before dispatch) |
| 15 | Idempotency keys | `npm run test:int -- --test-name-pattern "idempotency"` (1 upstream call) |
| 16 | Load test + metrics | `npm run load` (4 numbers printed) |
| 17 | Docker + Nginx deploy | `docker compose up -d --wait && npm run smoke -- --stream` |
| 18 | Docs + demo | `npm run verify` + a manual five-minute clone test |

---

### Phase A — Aggregate

#### Block 0 — Repo & toolchain ✅ DONE

- **Build:** git repo, `tsconfig.json`, `.gitignore`, `.gitattributes`, `@types/node`.
- **Done when:** `npm run build` exits 0. ✅ Verified.

#### Block 1 — Canonical schema, adapter interface, mock provider

*Why first:* nothing can be built until the normalisation boundary exists. The
adapter interface must accept a **credential**, not read a global key — that one
decision is what makes pooling possible later.

- **Learn (2.5h):** OpenAI Chat Completions contract (`model`, `messages`, `stream`,
  `max_tokens`, `temperature`, `tools`, `stream_options`, `usage`); TS discriminated
  unions; `node:test` built-in runner.
- **Build:**
  - `src/core/types.ts` — `CanonicalRequest`, `CanonicalResponse`, `CanonicalChunk`, `Usage`.
  - `src/providers/types.ts` — `ProviderAdapter`: `id`, `chat(req, credential)`, `stream(req, credential)`, `listModels(credential)`.
  - `src/providers/mock.ts` — configurable latency, canned response, **injectable 429/500/timeout, and a per-credential RPM ceiling** so pooling is testable from day one.
  - `src/config/env.ts` — typed env reading.
- **Done when:** mock adapter returns a `CanonicalResponse`; test asserts shape and that the mock honours its own RPM ceiling.
- **Pitfall:** model the response on the *union* of what providers return, then down-convert per adapter. Not on OpenAI's shape alone.

#### Block 2 — HTTP layer (Fastify), buffered path

- **Learn (2h):** the Fastify lifecycle — `onRequest` -> `preHandler` -> `handler` -> `onSend` -> `onError` -> `onResponse`; JSON Schema request validation and `fast-json-stringify` response serialisation (it **strips unknown fields**, which is how provider payloads stop leaking); hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `Proxy-*`) must be stripped; connect vs read vs total timeout.
- **Build:** `src/http/server.ts` — Fastify 5 instance, pino logger, `onRequest` request-ID hook, `POST /v1/chat/completions` (non-streaming), `GET /healthz` with a schema. Route tests via `app.inject()` — no port binding, no network.
- **Done when:** `npm run test -- --test-name-pattern "http"` passes via `inject()`, and `curl` against the running server returns an OpenAI-shaped completion from the mock adapter.
- **Pitfall:** Fastify serialises responses from the route's `response` schema. A field missing from the schema is **silently dropped** — if `usage` vanishes from your JSON, the schema is wrong, not the handler.

#### Block 3 — Real adapters + the credential pool

- **Learn (2h):** each provider's OpenAI-compatible base URL, auth header, model-list endpoint, error body. **Spike:** `curl` all three with an identical body and write down every difference.
- **Build:**
  - `src/providers/{nvidia-nim,openrouter,tokenharbor}.ts`
  - `src/credentials/pool.ts` — load N credentials per provider from env; `getCandidates(provider)` returns all of them.
  - `getCredential(id)` as the single read path.
- **Done when:** two keys on the same provider both work through the endpoint, and the pool reports 2 available credentials.
- **Pitfall:** design the pool as a list from the start. A single-key design costs a rewrite here.

#### Block 4 — Free-model discovery

- **Learn (1h):** each provider's model-list shape; how to tell a free model from a paid one; what metadata exists.
- **Build:** `src/providers/registry.ts` — for each (provider, credential), fetch models, mark free/paid, context window, discovered limit hints.
- **Done when:** one command prints a table of free models per provider, plus which credentials can reach them.
- **Pitfall:** a model free yesterday may be paid today. Discovery is a runtime concern, not a config file.

#### Block 5 — Model registry table

- **Learn (1h):** `node-cron`, upsert semantics, stale-data handling.
- **Build:** `models(provider, model_id, context_window, is_free, price_in, price_out, rpm_limit, tpm_limit, rpd_limit, healthy, checked_at)` in Postgres, refreshed hourly.
- **Done when:** a delisted model drops out of candidates without an error; the registry survives a provider outage with last-known-good data.
- **Pitfall:** never let a failed refresh empty the table. Keep last-known-good and mark it stale.

---

### Phase B — Survive 429

#### Block 6 — Rate-limit ledger (the core of the product)

- **Learn (2.5h):** token bucket vs sliding-window counter vs fixed window; Redis `EVAL` / ioredis `defineCommand()`; why `GET` then `SET` races; TTL to natural reset boundaries.
- **Build:** `src/limits/ledger.ts` + `ledger.lua`.
  ```
  rl:{credId}:{model}:rpm   counter, TTL 60s
  rl:{credId}:{model}:rpd   counter, TTL to next midnight UTC
  ```
  One Lua script: *check all windows, increment if all pass, else return the wait time* — atomically.
- **Done when:** race spike — two concurrent requests against a ceiling of 1: exactly one succeeds, and the other gets a correct wait time. Not two successes.
- **Pitfall:** same lesson as the URL shortener's `INCR`. Any check-then-write across two round-trips is broken under concurrency.

#### Block 7 — Error classification

- **Learn (1h):** which failures are retryable, which need a *different* target.

| Status / condition | Kind | Retry? | Action |
|---|---|---|---|
| 400 / 422 | `client` | never | return to caller |
| 401 / 403 | `auth` | no | quarantine credential, try another credential |
| 404 model | `model_gone` | once | refresh registry, pick another model |
| **429** | `rate_limited` | **yes** | **park credential until `retry-after`, next candidate** |
| 408 / 504 / abort | `timeout` | yes | next candidate |
| 500 / 502 / 503 / 529 | `upstream` | yes | open breaker, next candidate |
| `context_length_exceeded` | `too_long` | no | route to larger-context model |
| `content_filter` | `blocked` | never | return to caller |

- **Build:** `src/resilience/classify.ts` returning a discriminated union; **`retry-after` parser** for both seconds and HTTP-date forms.
- **Done when:** every row unit-tested, including a `retry-after` header in each of its two formats.
- **Pitfall:** `retry-after` is the only honest signal about when capacity returns. Ignoring it and retrying blind is how you get a 429 storm.

#### Block 8 — Circuit breaker / cooldown

- **Learn (2.5h):** `CLOSED -> OPEN -> HALF_OPEN`, sliding failure window, cooldown, probe request.
- **Build:** `src/resilience/breaker.ts` — keyed per **(provider, model)**, and a separate credential-level park keyed per **credential** (a dead key is not a dead provider).
- **Done when:** opens after N failures, makes **zero** network calls while open, self-heals after cooldown.
- **Pitfall:** a `try/catch` fallback is not a breaker. Without `OPEN`, every request pays a full failed round-trip and your p95 dies.

#### Block 9 — Capacity-aware selection + failover ladder

- **Learn (1h):** review only.
- **Build:**
  - `src/routing/select.ts` — **pure function** `(candidates, ledgerSnapshot, table, policy) -> ranked targets`. No I/O.
  - `src/core/execute.ts` — one loop: rank → reserve budget → call → classify → park/break/next → max attempts → total deadline.
- **Done when:** **Failure test + Capacity test pass** — 30% injected 429s, success stays 100%; 3 credentials at 30 RPM serve 60 RPM with zero client-visible 429s.
- **Pitfall:** ranking must consume a *snapshot* of the ledger, not call Redis itself. Pure function in, I/O out.

#### Block 10 — Streaming (SSE)

- **Learn (3h):** SSE wire format, `data:` lines, `\n\n` delimiter, `[DONE]`, **one JSON object can arrive split across two TCP chunks** (accumulate until `\n\n`), backpressure, `AbortController`, `res.flushHeaders()`.
- **Build:** `stream: true` path. Failover **only before the first token**. Terminal `error` event on mid-stream failure.
- **Done when:** real stream proxies through; an artificially split chunk reassembles; a slow client does not grow RSS.
- **Pitfall:** **you cannot fail over after the first token** — retrying mid-stream duplicates output. Abort before first byte, emit an error event after it.

---

### Phase C — Be good, not just available

#### Block 11 — Accounting + Postgres

- **Learn (2h):** Postgres from a MySQL background (`timestamptz`, `numeric`, `ON CONFLICT`, partial indexes); `pg` driver; batched inserts; `NUMERIC` not `FLOAT` for money.
- **Build:** migrations + `src/telemetry/store.ts`. One row per **terminal path**.

  ```
  requests(
    id uuid pk, request_id text unique, gateway_key_id uuid,
    provider text, model text, credential_id uuid,
    task_bucket text,
    status text,              -- success | failed | timeout | aborted
    http_status int,
    prompt_tokens int, completion_tokens int, tokens_estimated bool,
    cost_usd numeric(12,6),
    latency_ms int, ttft_ms int,
    attempt_count int,        -- how many candidates tried
    route_reason text,        -- capacity | task_fit | spread | fallback
    error_kind text,
    created_at timestamptz default now()
  )

  credentials(
    id uuid pk, user_id uuid, provider text, label text,
    ciphertext bytea, iv bytea, auth_tag bytea,
    fingerprint text unique,  -- HMAC, for lookup without decrypting
    status text,              -- active | quarantined | revoked
    created_at timestamptz, last_used_at timestamptz
  )
  ```

  Indexes: `requests(created_at)`, `(provider, model, created_at)`, `(gateway_key_id, created_at)`, `(credential_id, created_at)`.
- **Done when:** success, upstream failure, timeout and client abort each write exactly one row.
- **Pitfall:** if accounting only fires on success, every metric you publish is a lie. Write in `finally`.

#### Block 12 — Eval harness

- **Learn (1.5h):** JSON Schema validation, exact-match grading, pass@1. **No LLM-as-judge** — circular and costs money.
- **Build:** `src/eval/` — 100 prompts, 25 per bucket, 3 runs each:

  | Bucket | Grading signal |
  |---|---|
  | JSON extraction | validate against JSON Schema |
  | Math | exact match |
  | Code generation | hidden unit tests, pass@1 |
  | Structured extraction | field-level exact match / F1 |

- **Done when:** one command emits a markdown table with **`n` stated** per cell.
- **Pitfall:** manual grading of 300 answers never finishes. Ship only buckets that grade themselves.

#### Block 13 — `route()` + routing-table store

- **Learn:** none new.
- **Build:** `src/routing/store.ts` (interface) with `json-store.ts` and `eval-store.ts`. `route()` takes the ranked candidates from Block 9 and applies the table.
- **Done when:** **Policy test passes** — swap the store, `route()` untouched.
- **Pitfall:** if `route()` imports the registry directly, every later change means editing the router.

#### Block 14 — User spend budget

- **Learn (1.5h):** rate limiting algorithms, then the reservation pattern.
- **Build:** pre-dispatch atomic reserve of worst-case cost via Lua; reconcile against actual `usage`; release the difference.
- **Done when:** a request that would exceed the cap is rejected with `429` **before** dispatch — zero cost incurred.
- **Pitfall:** "cut off when the cap is breached" is post-hoc. One 200K-token request blows straight through it.

#### Block 15 — Idempotency keys

- **Learn (0.5h):** idempotency semantics and what "stored response" means for streaming.
- **Build:** `Idempotency-Key` -> Redis, replay stored response, single-flight lock on concurrent duplicates.
- **Done when:** same key twice = one upstream call, two identical responses.
- **Pitfall:** agents retry on timeout. Without this every retry double-spends your pooled capacity.

---

### Phase D — Prove it

#### Block 16 — Mock-upstream load test

- **Learn (1.5h):** Artillery, reading p50/p95/p99, what each tells an interviewer.
- **Build:** `load/` — configurable latency, 429/500 injection, per-credential RPM ceilings, slow-client mode.
- **Done when:** four numbers in the README:
  1. **Throughput multiplier vs a single key** (the headline).
  2. **Client-visible 429 rate** (target: 0%).
  3. **p95 proxy overhead** (target: <30 ms).
  4. **Failover success rate**.
- **Pitfall:** never load-test real providers — 429 wall in the first second, and if you don't hit it you pay for it.

#### Block 17 — Deploy: Docker + Nginx + Postgres + Redis

- **Learn (1h):** `proxy_buffering off`, `proxy_read_timeout 300s`, `proxy_http_version 1.1`, `X-Accel-Buffering: no`.
- **Build:** `docker-compose.yml` (app + postgres + redis), Nginx reverse proxy with TLS.
- **Done when:** a **streamed** response works through Nginx end to end.
- **Pitfall:** default Nginx buffers responses and makes streaming look broken while the app is fine.

#### Block 18 — Docs, diagram, demo

- **Build:** README with architecture diagram, eval table, load-test numbers; 2-minute demo video; résumé bullets.
- **Done when:** a stranger can clone, `docker compose up`, and get a streamed completion in under 5 minutes.

---

## 7. Progress

> Block 1 was pulled forward into Block 2: the canonical types, `ProviderAdapter` contract
> and a deterministic mock landed with it. Still outstanding from Block 1: the mock's own
> RPM ceiling and injectable 429/500/timeout, plus its dedicated test file.

| # | Block | Learn | Built | Tested |
|---|---|---|---|---|
| 0 | Repo & toolchain | — | ✅ | ✅ |
| 1 | Canonical schema + mock adapter | ✅ | ◐ | ☐ |
| 2 | HTTP buffered path | ✅ | ✅ | ✅ |
| 3 | Real adapters + credential pool | ☐ | ☐ | ☐ |
| 4 | Free-model discovery | ☐ | ☐ | ☐ |
| 5 | Model registry table | ☐ | ☐ | ☐ |
| 6 | **Rate-limit ledger** | ☐ | ☐ | ☐ |
| 7 | Error classification + retry-after | ☐ | ☐ | ☐ |
| 8 | Circuit breaker / credential parking | ☐ | ☐ | ☐ |
| 9 | Capacity-aware select + failover | ☐ | ☐ | ☐ |
| 10 | Streaming (SSE) | ☐ | ☐ | ☐ |
| 11 | Accounting + Postgres | ☐ | ☐ | ☐ |
| 12 | Eval harness | ☐ | ☐ | ☐ |
| 13 | `route()` + table store | ☐ | ☐ | ☐ |
| 14 | User spend budget | ☐ | ☐ | ☐ |
| 15 | Idempotency keys | ☐ | ☐ | ☐ |
| 16 | Load test + metrics | ☐ | ☐ | ☐ |
| 17 | Docker + Nginx deploy | ☐ | ☐ | ☐ |
| 18 | Docs + demo | ☐ | ☐ | ☐ |

## 8. Directory layout

```
src/
  core/         types.ts, select.ts, route.ts, execute.ts, ids.ts
  http/         server.ts, routes/, middleware/
  providers/    types.ts, registry.ts, mock.ts, nvidia-nim.ts, openrouter.ts, tokenharbor.ts
  credentials/  pool.ts, vault.ts, store.ts
  limits/       ledger.ts, ledger.lua, window.ts
  routing/      store.ts, json-store.ts, eval-store.ts
  resilience/   breaker.ts, classify.ts, retry-after.ts
  budget/       limiter.ts, reserve.lua
  telemetry/    store.ts, logger.ts
  eval/         grade.ts, run.ts, prompts/
  config/       env.ts
test/
  unit/         hermetic, no network / Docker / real keys
  integration/  needs `npm run db:up`
  fakes/        fake provider adapter, fake redis, fake clock
migrations/     *.sql (numbered, up + down)
load/           artillery.yml + scenarios
docker/         Dockerfile, nginx.conf   (docker-compose.yml lives at the repo root)
scripts/        setup.mjs and one-off tooling
docs/           architecture.md, testing.md, adr/
artifacts/      gitignored; verify logs
```

Every directory above exists and is tracked. Create files inside it; do not invent sibling
directories — `AGENTS.md` carries the same map, and the two must stay in sync.

## 9. Locked decisions

- **Runtime:** Node 24, TypeScript 5.5, CommonJS, `tsc` -> `dist/`. Node 24 gives native `fetch`, web `ReadableStream`, `--env-file`, `node:test`.
- **Test runner:** `node:test` — zero dependencies.
- **HTTP client:** native `fetch` only. No axios.
- **Schema layer:** **TypeBox** (`@sinclair/typebox`) — native ajv integration, zero shims, types inferred from the schema so canonical types and HTTP schemas cannot drift.
- **Gateway auth (Phase A):** `Authorization: Bearer <ADMIN_TOKEN>`, constant-time compare in `preHandler`. A `gateway_keys` table replaces it at Block 11.
- **Response headers:** `x-request-id`, `x-gateway-provider`, `x-gateway-model`, `x-gateway-attempts`, `x-gateway-latency-ms`, `x-gateway-tokens-estimated`, plus `retry-after` on 429/503.
- **Timeouts:** 10s per attempt, 30s total request deadline. Both env-configurable.
- **HTTP framework:** **Fastify 5**. Native JSON Schema validation, `fast-json-stringify` serialisation that strips unknown fields, pino logging built in, and `app.inject()` for hermetic route tests. See `docs/adr/0002-http-framework.md`.
- **Database:** **PostgreSQL 16** — append-only telemetry, SQL aggregations for p95 and spend; `NUMERIC` for money, `timestamptz` for time. Local via Docker; hosted option Neon or Supabase.
- **State:** Redis for the rate-limit ledger, breaker state, credential parking, budget reservation, idempotency.
- **Routing target:** a **(model, credential) pair**, never a bare model.
- **Routing order:** capacity -> task fit -> spread -> quality.
- **Limits:** discovered at runtime, never hardcoded.
- **Streaming:** from Block 10. Failover **only before the first token**.
- **Selector:** pure function taking a ledger snapshot.
- **Mock provider:** from Block 1, with its own RPM ceilings.
- **Accounting:** one row per request, every terminal path.

## 10. Open decisions

- Budget unit: dollars, tokens, or both (Block 14).
- Whether the public demo ships with real keys at all (Block 17).
- Default spread policy when several candidates have equal capacity: round-robin or least-recently-used (Block 9).
- Whether to expose per-credential health in the API response headers (Block 11).

## 11. Environment

```
PORT=8080
DATABASE_URL=postgres://...
REDIS_URL=redis://...
NVIDIA_NIM_KEYS=key1,key2      # comma-separated; several keys per provider is the point
OPENROUTER_KEYS=key1
TOKENHARBOR_KEYS=key1,key2
MASTER_ENCRYPTION_KEY=         # 32-byte hex, read by the vault
ADMIN_TOKEN=
LOG_LEVEL=info
```

`.env` is gitignored. `getCredential()` is the only read path for provider keys.

## 12. Naming and positioning

Local folder is `Ultimate_frre_ai` (kept — WebStorm module config depends on it).
**The public GitHub repo must not be named after "free"** — use `llm-gateway` or
`byok-llm-gateway`.

Résumé language — describe the engineering, not the free-tier sourcing:

> Rate-limit-aware request distribution across a pool of BYOK credentials, with
> per-(credential, model) quota ledgers and `retry-after`-driven failover.

**If asked "isn't this circumventing provider limits?"** — the honest answer, and
the one to have ready: the gateway pools credentials the user already owns
(across providers, or across their own projects) and respects each provider's
advertised `retry-after`. It does not create accounts, rotate identities, or
evade any ceiling — it stops *wasting* capacity that is already paid for.
Do not build account-creation or identity-rotation features. That is the line
between capacity pooling and ToS abuse, and it is the difference between a
project you can present publicly and one you cannot.

## 13. Learning log

One line per block, so interview answers have dates and specifics.

| Block | Topic | Hours | What actually surprised me |
|---|---|---|---|
| | | | |

## 14. Agent setup

The repo is built to be driven by coding agents. Every file below exists for a measured
reason; none is decorative.

| File | Read by | Why it exists |
|---|---|---|
| `AGENTS.md` | Codex, Cursor, OpenCode, Copilot agent surfaces, Antigravity | Single canonical instruction source. ~90 lines, commands + invariants only |
| `CLAUDE.md` | Claude Code, Cursor | 3-line shim. Claude Code **ignores `AGENTS.md` whenever `CLAUDE.md` exists**, so this file `@`-imports it |
| `.github/copilot-instructions.md` | Copilot Chat in JetBrains / VS / Xcode | Self-contained. Those surfaces never read `AGENTS.md`, and Copilot has no import syntax |
| `STATUS.md` | every agent, first read | Cross-session handoff: current block, next action, known red |
| `docs/architecture.md` | on demand only | Decisions the code cannot show. Deliberately **not** auto-loaded |
| `docs/testing.md` | on demand only | Runner commands, determinism rules, test-naming convention |
| `docs/adr/0001-…` | on demand, cited by ID | Why capacity outranks quality |
| `.claude/settings.json` | Claude Code | Deny list: `.env` reads, `git push`, `reset`, `rm -rf`, volume wipes |

**Deliberately omitted:** `llms.txt` (a documentation-site convention — 97% of published
ones received zero requests), `GEMINI.md` (Gemini CLI retired for consumers; Antigravity
reads `AGENTS.md`), `.cursorrules` (absent from current Cursor docs), and any
`.cursor/rules/*.mdc` (this project is driven from WebStorm and the CLI).

**The command contract** — declared once in `package.json`, mirrored in `AGENTS.md`, never
renamed: `npm run verify` chains `typecheck -> lint -> format:check -> test`, fail-fast.
**Measured at 3.3s on this machine.** If it passes 10s, split it — a gate an agent will not
run is not a gate.

**Known limit:** prose "never do X" in a markdown file is non-deterministic. Enforcement
lives in `.claude/settings.json` deny rules and in `test/unit/repo-contract.test.ts`, which
fails `verify` if strict mode is disabled, `.env` stops being gitignored, a gate test is
deleted from this file, or `@types/node` drifts off the runtime major.

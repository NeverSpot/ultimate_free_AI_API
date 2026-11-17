# Architecture Deep Dive

This file records the design decisions the code cannot show: the routing signal
order, the layer rules, and why each choice was made.

## Request Flow

```
client (OpenAI format)
  → normalise to canonical schema
  → candidates = (model, credential) pairs with capacity left, breaker CLOSED
  → rank: capacity → task fit → LRU spread → quality
  → ATOMIC RESERVE  ← the step that makes pooling work
  → execute with failover ladder
  → reconcile usage, emit one accounting event (finally)
  → stream or buffer
```

### Extended Step-by-Step

1. **Client → Nginx** — TLS termination (if configured), SSE buffering disabled
   (`proxy_buffering off`, `chunked_transfer_encoding off`)
2. **Nginx → Gateway** — HTTP/1.1, empty `Connection` header for keepalive,
   `proxy_read_timeout 300s` for long tool-call streams
3. **Gateway → Normaliser** — Maps the incoming OpenAI-format body to
   `CanonicalRequest`. Validates via TypeBox JSON Schema; unknown fields stripped
   by `fast-json-stringify`
4. **Normaliser → Router** — `route()` is a **pure function**: it receives
   `(candidates, ledgerSnapshot, routingTable, policy)` and returns a ranked list.
   No Redis, no `fetch`, no `Date.now()` — time and availability are passed in
5. **Router → Ledger** — Redis Lua script atomically checks RPM/RPD/TPM windows
   and decrements in one round-trip. If all windows pass, the credential is
   reserved; otherwise the request gets the wait time for the earliest reset
6. **Router → Breaker** — Redis hash per `(provider, model)`:
   `CLOSED → OPEN → HALF_OPEN`. Zero network calls while OPEN
7. **Router → Budget** — Atomic Lua reserve of worst-case cost; reconcile
   against actual `usage` after response; release the delta
8. **Router → Idempotency** — `Idempotency-Key` header → Redis `SETNX` lock +
   response cache. Concurrent duplicates single-flight; replays return cached
   response
9. **Router → Provider Adapter** — Adapter-specific HTTP call (`chat()` or
   `stream()`). Each adapter normalises the provider's response back to
   `CanonicalResponse` / `CanonicalChunk`
10. **Response → Accounting** — One Postgres row per terminal path
    (success/failed/timeout/aborted). Written in `finally` — every path, no
    exceptions
11. **Response → Client** — Streamed (SSE with `text/event-stream`,
    `X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`) or
    buffered (JSON)

The atomic reserve (step 5) is the load-bearing step. Ranking alone cannot prevent
two concurrent requests from both consuming the last unit of a key's budget: the
ranking is a snapshot and is stale by the time it is acted on. Only a single Redis
operation that checks and decrements together is correct.

## Component Details

### Router (`src/core/select.ts`, `src/core/route.ts`)

Pure TypeScript function, deterministic, testable. Takes a ledger snapshot (not
Redis itself) and returns ranked `(model, credential)` pairs.

**Routing signal order** (the whole design):

| Priority | Signal | Why |
|----------|--------|-----|
| 1 | **Capacity** — does this (model, credential) have budget left? | A brilliant model at 0 RPM is useless |
| 2 | **Task fit** — eval score in this bucket | After availability, pick the best available |
| 3 | **Spread** — least-recently-used credential | Prevent exhausting one key while others idle |
| 4 | Quality within the bucket | Tie-break only |

**Product policy:** requests authenticated with a gateway key (`gk_…`) route
through the **free model pool only** — a named model id is preferred if it is free,
otherwise the best available free model is used. Paid model names are never
substituted and never return `404`.

### Rate-Limit Ledger (`src/limits/ledger.ts`, `src/limits/ledger.lua`)

Fixed-window + sliding-window Lua script, per-credential RPM/RPD/TPM. One atomic
Redis `EVAL` per request: check all windows, increment if all pass, else return
the wait time.

```
rl:{credId}:{model}:rpm   counter, TTL 60s
rl:{credId}:{model}:rpd   counter, TTL until next midnight UTC
cd:{credId}               parked-until timestamp, from retry-after
```

### Circuit Breaker (`src/resilience/breaker.ts`)

```
CLOSED ──(N failures in window)──► OPEN
OPEN   ──(cooldown elapsed)──────► HALF_OPEN
HALF_OPEN ──(probe success)──────► CLOSED
HALF_OPEN ──(probe failure)──────► OPEN
```

Two distinct faults, two distinct mechanisms:

| Fault | Scope | Mechanism |
|-------|-------|-----------|
| `429` on one key | one **credential** | park until the provider's `retry-after` |
| `5xx` / timeout | one **(provider, model)** | breaker opens, cooldown |

Conflating these takes down a healthy provider because one key ran dry.

### Spend Budget (`src/budget/limiter.ts`, `src/budget/reserve.lua`)

Atomic reserve (decrement) of worst-case cost via Lua before dispatch. After
response, reconcile against actual `usage` and release the delta. A request that
would exceed the cap is rejected with `429` **before** dispatch — zero cost incurred.

### Idempotency (`src/http/middleware/idempotency.ts`)

`Idempotency-Key` header → Redis `SETNX` lock + TTL'd response cache. Concurrent
duplicate requests single-flight (second request blocks on lock, then replays
cached response). Works for both buffered and streaming responses.

### Accounting (`src/telemetry/store.ts`)

One Postgres row per terminal request. Written in `finally` — covers success,
upstream failure, timeout, and client abort. Uses `NUMERIC(12,6)` for cost (not
`FLOAT`), `timestamptz` for time.

### Error Classification (`src/resilience/classify.ts`)

| Status / condition | Kind | Retry? | Action |
|--------------------|------|--------|--------|
| 400 / 422 | `client` | never | return to caller |
| 401 / 403 | `auth` | no | quarantine credential, try another |
| 404 model | `model_gone` | once | refresh registry, pick another model |
| **429** | `rate_limited` | **yes** | **park credential until `retry-after`, next candidate** |
| 408 / 504 / abort | `timeout` | yes | next candidate |
| 500 / 502 / 503 / 529 | `upstream` | yes | open breaker, next candidate |
| `context_length_exceeded` | `too_long` | no | route to larger-context model |
| `content_filter` | `blocked` | never | return to caller |

### Provider Adapters (`src/providers/`)

Each adapter implements the `ProviderAdapter` interface:
- `chat(req, credential)` — buffered response
- `stream(req, credential)` — SSE async iterator
- `listModels(credential)` — model discovery

```
src/providers/types.ts       # the ProviderAdapter interface
src/providers/defaults.ts    # the single composition root
src/providers/<name>.ts      # your adapter
```

Adding a provider = one new adapter file + one line in `src/providers/defaults.ts`.
Nothing else changes: every CLI reads the same composition root, so a new provider reaches
all of them without touching a script.

### Eval Harness (`src/eval/`)

100 prompts, 25 per bucket, 3 runs each. Deterministic self-graders:

| Bucket | Grading Signal |
|--------|----------------|
| `json_extraction` | Validate against JSON Schema |
| `math` | Exact match |
| `code_generation` | Hidden unit tests, pass@1 |
| `structured_extraction` | Field-level exact match / F1 |

No LLM-as-judge — circular and costs money.

## Data Stores

### Redis (hot-path truth)

| Key Pattern | Purpose | TTL |
|-------------|---------|-----|
| `rl:{credId}:{model}:rpm` | Request counter | 60s |
| `rl:{credId}:{model}:rpd` | Daily counter | Until midnight UTC |
| `cd:{credId}` | Credential park (from retry-after) | Provider-specified |
| `br:{provider}:{model}` | Breaker state hash | Cooldown period |
| `budget:{userId}` | Spend reservation | Budget window |
| `idem:{key}` | Idempotency lock + cache | 24h |

Redis is the hot-path source of truth for capacity, parking, and breaker state.
Never a durable record.

### Postgres (durable accounting)

| Table | Purpose |
|-------|---------|
| `requests` | One row per terminal request (success/failed/timeout/aborted) |
| `credentials` | Encrypted credential store (AES-256-GCM) |
| `models` | Discovered model registry, refreshed hourly |
| `spend_budgets` | Per-user spend caps |

Postgres is durable accounting. Never read on the hot path.

## Deployment Topology

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Nginx     │────►│  Gateway    │────►│  Postgres   │
│   :80/443   │     │   :8080     │     │   :5432     │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │    Redis    │
                    │   :6379     │
                    └─────────────┘
```

### Docker Compose Stack (`docker compose --profile app up`)

| Service | Image | Port | Healthcheck |
|---------|-------|------|-------------|
| `postgres` | `postgres:16-alpine` | 55432→5432 | `pg_isready` |
| `redis` | `redis:7-alpine` | 6379 | `redis-cli ping` |
| `gateway` | Built from `Dockerfile` | 8080 | `fetch /healthz` |
| `nginx` | `nginx:1.27-alpine` | 80 | `wget /healthz` |

### Nginx Streaming Configuration

Critical settings for SSE pass-through:
- `proxy_buffering off` — chunks pass immediately
- `chunked_transfer_encoding off` — reliability per HTML spec
- `proxy_http_version 1.1` + empty `Connection` header — keepalive
- `proxy_read_timeout 300s` — between chunks, not total response
- `gzip off` — no compression on event streams

App sends defense-in-depth headers:
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`
- SSE keepalive comments (`: keepalive\n\n`) every 15s of silence

## Why capacity outranks quality

A gateway in front of paid frontier models optimises cost, so it ranks quality first
and price second. This one sits in front of free tiers that hard-cap at roughly 30
requests per minute, so the binding constraint is **availability**, not model choice.
A brilliant model at 0 RPM is worth nothing. Hence: capacity first, quality last.

See `docs/adr/0001-routing-signal-order.md`.

## Exhaustion behaviour

When every candidate is parked, the client receives `503` with a `retry-after` header
matching the earliest park expiry. It does not queue: queueing converts a fast failure
into a slow one and hides the capacity ceiling from the operator.

## Failure modes

| Symptom | Likely component | Confirming signal |
|---------|------------------|-------------------|
| Client sees 429 | reserve not atomic | two requests passed the same ceiling |
| Throughput stuck at 1 key | candidate set built from one credential | `credentials` in the candidates log line |
| p95 spikes when a provider dies | breaker not opening | `breaker.Open` counter flat |
| Missing accounting rows | write not in `finally` | row count < request count |
| Streams truncated | failover attempted after first token | partial trajectory log |

## Out of scope

UI, semantic caching, billing, multi-region, account rotation. Each was considered and
dropped; do not reintroduce them without an ADR.

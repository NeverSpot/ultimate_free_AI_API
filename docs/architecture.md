# Architecture

Read `PROJECT.md` for the plan and the block order. This file records the decisions
the code cannot show.

## Request lifecycle

```
client (OpenAI format)
  -> normalise to canonical schema
  -> candidates = (model, credential) pairs with capacity left, breaker CLOSED
  -> rank: capacity -> task fit -> LRU spread -> quality
  -> ATOMIC RESERVE  <-- the step that makes pooling work
  -> execute with failover ladder
  -> reconcile usage, emit one accounting event (finally)
  -> stream or buffer
```

The atomic reserve is the load-bearing step. Ranking alone cannot prevent two
concurrent requests from both consuming the last unit of a key's budget: the ranking
is a snapshot and is stale by the time it is acted on. Only a single Redis operation
that checks and decrements together is correct.

## Why capacity outranks quality

A gateway in front of paid frontier models optimises cost, so it ranks quality first
and price second. This one sits in front of free tiers that hard-cap at roughly 30
requests per minute, so the binding constraint is **availability**, not model choice.
A brilliant model at 0 RPM is worth nothing. Hence: capacity first, quality last.

See `docs/adr/0001-routing-signal-order.md`.

## Breaker state machine

```
CLOSED --(N failures in window)--> OPEN
OPEN   --(cooldown elapsed)-----> HALF_OPEN
HALF_OPEN --(probe success)-----> CLOSED
HALF_OPEN --(probe failure)-----> OPEN
```

Two distinct faults, two distinct mechanisms:

| Fault | Scope | Mechanism |
|---|---|---|
| `429` on one key | one **credential** | park until the provider's `retry-after` |
| `5xx` / timeout | one **(provider, model)** | breaker opens, cooldown |

Conflating these takes down a healthy provider because one key ran dry.

## Ledger data model

Redis, one key per window:

```
rl:{credId}:{model}:rpm   counter, TTL 60s
rl:{credId}:{model}:rpd   counter, TTL until next midnight UTC
cd:{credId}               parked-until timestamp, from retry-after
br:{provider}:{model}     breaker state hash
```

All mutations are Lua scripts so check-and-increment is one atomic operation.

## Exhaustion behaviour

When every candidate is parked, the client receives `503` with a `retry-after` header
matching the earliest park expiry. It does not queue: queueing converts a fast failure
into a slow one and hides the capacity ceiling from the operator.

## Postgres vs Redis

- **Redis is hot-path truth** for capacity, parking and breaker state. Never a durable
  record.
- **Postgres is durable accounting** — one row per terminal request. Never read on the
  hot path.

An agent adding a ledger read to Postgres has inverted this rule.

## Failure modes

| Symptom | Likely component | Confirming signal |
|---|---|---|
| Client sees 429 | reserve not atomic | two requests passed the same ceiling |
| Throughput stuck at 1 key | candidate set built from one credential | `credentials` in the candidates log line |
| p95 spikes when a provider dies | breaker not opening | `breaker.Open` counter flat |
| Missing accounting rows | write not in `finally` | row count < request count |
| Streams truncated | failover attempted after first token | partial trajectory log |

## Out of scope

UI, semantic caching, billing, multi-region, account rotation. Each was considered and
dropped; do not reintroduce them without an ADR.

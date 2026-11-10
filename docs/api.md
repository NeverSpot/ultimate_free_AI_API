# API contract

**Phase A surface.** Status of each section is marked; anything marked *later* is a
documented gap, not an accident.

Base path: `/`. Auth: `Authorization: Bearer <gateway-key>` (compared in constant time
against `ADMIN_TOKEN` in Phase A; a `gateway_keys` table replaces it at Block 11).

Body limit `2 MiB` (`MAX_BODY_BYTES`). Per-attempt timeout `10s`, total request deadline
`30s` (`ATTEMPT_TIMEOUT_MS`, `REQUEST_DEADLINE_MS`).

---

## POST /v1/chat/completions — *Block 2*

OpenAI-compatible so a stock SDK works by changing `base_url` alone.

### Request body

| Field | Type | Req | Notes |
|---|---|---|---|
| `model` | string | no | **A hint, not a command.** The router normally picks. Echoed back as the model actually used |
| `messages` | array, min 1 | **yes** | `role`: `system` \| `user` \| `assistant`; `content`: string \| null |
| `temperature` | number 0–2 | no | default 1 |
| `top_p` | number 0–1 | no | |
| `max_tokens` | integer ≥ 1 | no | |
| `stop` | string \| string[1–4] | no | |
| `response_format` | `{type:'text'}` \| `{type:'json_object'}` | no | |
| `stream` | boolean | no | default false. **`true` → `501` until Block 10** |
| `user` | string | no | accepted, passed through |

### Ignored vs rejected — the rule that keeps `base_url` swap honest

Rejecting unknown fields (`additionalProperties: false`) looks strict and is **wrong here**:
a stock OpenAI client routinely sends `seed`, `presence_penalty`, `frequency_penalty`,
`store`, `service_tier`, `metadata`. Rejecting those breaks the one promise this API makes —
that you change `base_url` and nothing else.

So the boundary is lenient by default, with a hard split:

| Class | Examples | Behaviour |
|---|---|---|
| **Harmless** — cannot change the answer | `seed`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `store`, `metadata`, `service_tier`, `user` | accepted, **ignored**, logged at debug |
| **Meaning-changing** — we cannot honour it | `n` > 1, `logprobs`, `top_logprobs`, `tools`, `tool_choice`, `modalities`, `audio`, `stream: true` (until Block 10) | **`501 unsupported`** |
| **Malformed** — wrong type or missing required | `messages` absent, `temperature: "hot"` | **`400 invalid_request_error`** |

The principle: **ignore only what cannot change the answer; reject loudly what would.** A
silently dropped `n: 2` returns one choice and looks like a bug in the client. A `501` names
the cause.

### Response body — 200

```json
{
  "id": "chatcmpl-01JBQ4ZK8R5T2N9M3V7W1X4Y6A",
  "object": "chat.completion",
  "created": 1731250000,
  "model": "llama-3.3-70b-versatile",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 12, "completion_tokens": 40, "total_tokens": 52 }
}
```

`finish_reason`: `stop` \| `length` \| `content_filter` \| `error`.

**`usage` is strictly OpenAI-shaped.** Our internal `estimated` flag is *not* added to the
body — non-standard fields live in headers instead. Third-party clients that validate the
response should never see a field they do not know.

### Response headers

| Header | Example | Purpose |
|---|---|---|
| `x-request-id` | `01JBQ4…` | gateway ULID; echoes a supplied `x-request-id` if present |
| `x-gateway-provider` | `openrouter` | which provider served it |
| `x-gateway-model` | `llama-3.3-70b-versatile` | which model actually ran |
| `x-gateway-attempts` | `2` | how many candidates were tried |
| `x-gateway-latency-ms` | `412` | gateway-side elapsed time |
| `x-gateway-tokens-estimated` | `true` \| `false` | whether usage was measured or approximated |
| `retry-after` | `12` | present on `429` and `503` only |

These headers are the demo. `x-gateway-attempts: 3` followed by a 200 is the whole product in
one line.

### Status codes

| Code | When | Error `type` |
|---|---|---|
| 200 | served | — |
| 400 | invalid body, `too_long`, `content_filter` | `invalid_request_error` |
| 401 | missing or wrong gateway key | `authentication_error` |
| 404 | requested model not known to the registry | `invalid_request_error` |
| 429 | *this client* over its own limit (Block 13) | `rate_limit_error` |
| 501 | `stream: true` before Block 10, or unsupported parameter | `invalid_request_error` |
| 502 | every candidate failed with an upstream error | `api_error` |
| 503 | **all candidates parked** — upstream capacity exhausted | `service_unavailable` |
| 504 | total deadline exceeded | `api_error` |

**429 vs 503 is a deliberate distinction.** `429` means *you* are throttled; `503` means *we*
are out of upstream capacity. Different client behaviour follows: slow down vs retry later.
Both carry `retry-after`.

### Error envelope — every non-2xx, no exceptions

```json
{
  "error": {
    "message": "all credentials parked until 12s from now",
    "type": "service_unavailable",
    "code": "exhausted",
    "param": null
  }
}
```

Fastify's built-in validation errors and 404s are remapped into this shape by
`setErrorHandler` / `setNotFoundHandler`. A response without this envelope is a bug.

`ErrorKind` → `code` map: `client`→`invalid_request`, `auth`→`invalid_api_key`,
`model_gone`→`model_not_found`, `rate_limited`→`rate_limited`, `timeout`→`timeout`,
`upstream`→`upstream_error`, `too_long`→`context_length_exceeded`,
`blocked`→`content_filter`, `unsupported`→`unsupported`, exhaustion→`exhausted`.

---

## GET /healthz — *Block 2*

```json
{
  "status": "ok",
  "checks": { "redis": "unknown", "postgres": "unknown" },
  "version": "0.1.0",
  "uptime_s": 1234
}
```

| Condition | `status` | HTTP |
|---|---|---|
| all probes ok | `ok` | 200 |
| a probe not wired yet | `ok` | 200 |
| Postgres unreachable | `degraded` | 200 |
| Redis unreachable | `down` | 503 |

Each probe declares its own severity, so `healthz` never decides which dependency is
fatal: returning `down` means fatal (Redis), returning `degraded` means non-fatal
(Postgres — accounting degrades, traffic keeps flowing). An unwired probe reports
**`unknown`, never `ok`**: a health check that asserts an unchecked dependency is a
fabricated operational signal and hides a dead Redis behind a green dashboard.

Redis down is `down`, not `degraded`: without a ledger the gateway cannot reserve capacity,
and admitting traffic would over-serve keys into `429` storms. **Health checks do not count
toward rate limits and are never routed to a provider.**

---

## GET /v1/models — *Block 4/5*

```json
{
  "object": "list",
  "data": [
    {
      "id": "llama-3.3-70b-versatile",
      "object": "model",
      "owned_by": "openrouter",
      "context_window": 131072,
      "is_free": true
    }
  ]
}
```

OpenAI-compatible shape plus additive fields. Served from the registry cache — **never**
queries a provider on request. `context_window` and `is_free` are `null` when undiscovered.

---

## Deliberate gaps in Phase A

| Gap | Behaviour now | Closes at |
|---|---|---|
| `stream: true` | `501 unsupported` | Block 10 |
| `tools` / `tool_choice` | `501 unsupported` | post-Block 12, if eval needs it |
| `logprobs` / `top_logprobs` | `501 unsupported` | never |
| `n` > 1 | `501 unsupported` | never (single choice by design) |
| `idempotency-key` | accepted, **ignored**, logged at debug | Block 15 |
| `seed`, `presence_penalty`, etc. | accepted, ignored | never |
| Per-client rate limiting | absent — only the gateway key is checked | Block 13 |
| `/v1/models` | `501` | Block 4 |

A silent no-op is worse than a `501`. Anything unimplemented fails loudly.

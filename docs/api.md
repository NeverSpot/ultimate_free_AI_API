# API contract

**Phase A surface.** Status of each section is marked; anything marked *later* is a
documented gap, not an accident.

Base path: `/`. Auth has two layers:

- **API routes** (`/v1/chat/completions`, `/v1/user/keys`, …) require
  `Authorization: Bearer <gateway-key>` — a user `gk_…` key or the shared admin token
  (constant-time compare).
- **User session routes** (`/v1/user/*`) additionally accept the httpOnly `jwt` cookie set
  by login/register. A JWT-only request to `/v1/chat/completions` is **401**: the cookie is
  scoped to `/v1/user/*` so streaming stays off the CSRF surface.

Body limit `2 MiB` (`MAX_BODY_BYTES`). Per-attempt timeout `10s`, total request deadline
`30s` (`ATTEMPT_TIMEOUT_MS`, `REQUEST_DEADLINE_MS`).

---

## Auth & session — *Blocks 19–20 + JWT migration*

### `POST /v1/auth/register`

```json
{ "username": "alice", "email": "alice@example.com", "password": "minimum-8-chars" }
```

`201` with `{ user: { id, username, email }, gateway_api_key: "gk_…" }`. Also sets the
session cookie. The key is stored as a SHA-256 hash for auth plus an AES-256-GCM copy that
lets the owner view the same key again on `/keys`. Duplicate username/email → `409`; missing
fields or a non-object body → `400`.

### `POST /v1/auth/login`

```json
{ "username": "alice", "password": "minimum-8-chars" }
```

`200` with `{ userId, username }` and a `Set-Cookie` session. The same key is re-issued
(the server decrypts its stored copy); a legacy account created before encrypted storage has
no recoverable copy, so `gateway_api_key` is omitted and its current key keeps authenticating
until an explicit `POST /v1/auth/regenerate-key`. Wrong credentials → `401`.

### `POST /v1/auth/regenerate-key`

Username + password verify directly (the `/v1/auth/*` routes are exempt from the session
hook). Invalidates the old key immediately and returns `{ gateway_api_key: "gk_…" }`; that
key is stored encrypted for later logins. The old key then returns `401`.

### `POST /v1/auth/logout`

`200 { "ok": true }` and clears the cookie (`Max-Age=0`). Stateless JWT: logout does not
revoke an already-stolen token; tokens expire after 7 days.

### `GET /v1/user/me`

Requires the session cookie (or a gateway key). `200 { id, username, email }`,
`Cache-Control: no-store`. The frontend bootstraps its header and keys page from this.

### `GET /v1/user/gateway-key`

Requires the session cookie (or a gateway key). `200 { gateway_api_key: "gk_…" | null }`,
`Cache-Control: no-store`. Decrypts the stored copy and returns the same key login would
issue — it never rotates. `null` for a legacy hash-only account. The keys page calls this on
load, so clearing `localStorage` no longer hides the key while the session is valid.

### Session cookie contract

| Attribute | Value |
|---|---|
| Name | `jwt` |
| Value | HS256 JWT: `{ userId, username, iat, exp }`, 7-day expiry |
| `Path` | `/` |
| `HttpOnly` | yes |
| `SameSite` | `Strict` (documented same-site `localhost` deployment) |
| `Secure` | only when `NODE_ENV=production` |
| `JWT_SECRET` | optional in dev, **required ≥ 32 chars in production** |

### Scope rule

| Request | Result |
|---|---|
| JWT cookie → `/v1/user/keys`, `/v1/user/me` | `200` |
| JWT cookie → `/v1/chat/completions` | `401` |
| Gateway key / admin token → `/v1/user/keys` | gateway key `200`; admin `401` (no user context) |

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
| `stream` | boolean | no | default false. `true` → SSE (`text/event-stream`); failover only before the first chunk |
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
| **Meaning-changing** — we cannot honour it | `n` > 1, `logprobs`, `top_logprobs`, `tools`, `tool_choice`, `modalities`, `audio` | **`501 unsupported`** |
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
| 404 | `model_gone` from an upstream — admin-token requests only; `gk_` requests never 404, they fall back to the free pool | `invalid_request_error` |
| 429 | every reachable candidate is rate-limited or parked (upstream limits, not a per-client quota) | `rate_limit_error` |
| 501 | unsupported parameter (`n` > 1, `logprobs`, `tools`, …) | `invalid_request_error` |
| 502 | every candidate failed with an upstream error | `api_error` |
| 503 | no candidate has remaining capacity (`exhausted`), or every attempt failed with an upstream 5xx | `service_unavailable` |
| 504 | total deadline exceeded | `api_error` |

**429 vs 503 is a deliberate distinction.** `429` means every reachable candidate is
rate-limited or parked — an upstream limit, not a per-client quota. `503` means no candidate
is available at all. Both are retryable and both carry `retry-after`.

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

## GET /v1/models — OpenAI-compatible discovery

**Auth required** — a gateway key (`Authorization: Bearer gk_…`) or the shared admin
token. The JWT session cookie is **not** accepted here (it is scoped to `/v1/user/*`);
without a bearer credential, `401`.

```json
{
  "object": "list",
  "data": [
    {
      "id": "free",
      "object": "model",
      "created": 0,
      "owned_by": "gateway"
    }
  ]
}
```

**One model, by design.** The gateway picks the actual model at request time
(capacity → task fit → spread), so discovery does not enumerate the pool — it
advertises the single keyword callers use. Send `"model": "free"` (or omit
`model`) to chat; sending any other model id still routes through the free pool.

Clients that treat a model list as a hard contract (Continue.dev, agy, Codex,
Claude Code) can enable discovery against this endpoint without special-casing:
it returns exactly one id, and that id is the one that works.

---

## Deliberate gaps in Phase A

| Gap | Behaviour now | Closes at |
|---|---|---|
| `tools` / `tool_choice` | `501 unsupported` | post-Block 12, if eval needs it |
| `logprobs` / `top_logprobs` | `501 unsupported` | never |
| `n` > 1 | `501 unsupported` | never (single choice by design) |
| `idempotency-key` | accepted, **ignored**, logged at debug | Block 15 |
| `seed`, `presence_penalty`, etc. | accepted, ignored | never |
| Per-client rate limiting | absent — only the gateway key is checked | Block 13 |

A silent no-op is worse than a `501`. Anything unimplemented fails loudly.

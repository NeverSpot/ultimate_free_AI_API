# Using the Gateway — Integration Guide

**Availability by aggregation.** Free-tier LLM keys are capped per provider — cross a
limit and every request fails until the window resets. This gateway pools the **free
models from many providers behind one API key**, so a request that would `429` on one
provider is routed to another that still has capacity. One endpoint, one key, N× the
ceiling.

It is **OpenAI-compatible**: point your client at `http://localhost:8081/v1` and
authenticate with a `gk_…` gateway key.

Full contract: [`docs/api.md`](./api.md). Architecture: [`docs/architecture.md`](./architecture.md).

---

## 1. Get your gateway key

The gateway key is a `gk_…` string. Its SHA-256 hash authenticates requests, and an
AES-256-GCM copy is stored so the same key is returned on every login and shown on the
keys page. Regenerating it immediately invalidates the old key.

**Web UI (easiest).** Start the stack, open the keys page:

```bash
npm run sex          # backend :8081 + frontend :3000
# then open http://localhost:3000/keys
```

**Scripted.** Password minimum 8 characters:

```bash
curl -s -X POST http://localhost:8081/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","email":"alice@example.com","password":"correct-horse-battery"}'
```

```json
{
  "user": { "id": "db34…", "username": "alice", "email": "alice@example.com" },
  "gateway_api_key": "gk_…"
}
```

Rotate later with `POST /v1/auth/regenerate-key` (username + password).

> **Keep it out of git.** Put `gk_…` in an environment variable, never in source.

---

## 2. Add your provider keys (BYOK)

Your keys stay yours. The gateway encrypts them at rest (AES-256-GCM) and uses them to
reach the upstream providers.

```bash
curl -s -X POST http://localhost:8081/v1/user/keys \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"openrouter","providerKey":"sk-or-v1-…"}'
```

Supported providers: `openrouter`, `nvidia` (alias `nvidia-nim`), `tokenharbor`.

Verify (metadata only — never the secret):

```bash
curl -s http://localhost:8081/v1/user/keys -H "Authorization: Bearer $GATEWAY_API_KEY"
```

**Strict BYOK:** with no provider key saved, every chat returns `503 exhausted`. There is no
fallback to the operator's keys — the pool is exactly what you added.

Rotate: re-POST the same provider (it overwrites). Remove: `DELETE /v1/user/keys/openrouter`.

---

## 3. Just ask for `"free"`

**You do not need to know a model id.** Send `"model": "free"` — or omit `model` entirely —
and the gateway picks for you:

```bash
curl -s http://localhost:8081/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"free","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":32}'
```

What happens:

```
"model": "free"
   ↓  gateway collects EVERY free model reachable through your provider keys
   ↓  the router ranks them by the project's signal order:
   │    1. capacity   — does this (model, key) have budget left?
   │    2. task fit   — which model is best at this kind of request
   │    3. spread     — least-recently-used key first
   │    4. quality    — tie-break
   ↓  executes with failover: on 429/5xx it parks that key and tries the next
```

`"auto"` behaves the same as `"free"`.

User requests (gateway-key auth) always route through the **free model pool**. If you
send a specific model id, the gateway prefers it **only if** it is in the free pool;
otherwise it is ignored and your request runs on the best available free model — never
a paid substitution, never a `404`. Send `"model": "free"` or omit `model` to let the
gateway pick by capacity, task fit, spread and quality.

**Discover what exists** — `GET /v1/models` returns a single model entry, `free`:

```bash
curl http://localhost:8081/v1/models -H "Authorization: Bearer gk_…"
```

For the full registry (including models you cannot request), use:

```bash
npm run registry:list
```

```text
provider     models  free  samples
nvidia       32      18    bigcode/starcoder2-15b,google/gemma-3-12b-it,google/gemma-3-4b-it
openrouter   435     17    inclusionai/ling-3.2-flash:free,baidu/ernie-5.5-flash-preview:free,thinkingmachines/inkling-2-small:free
tokenharbor  85      4     mimo-v2.5:free,deepseek-v4-flash:free,deepseek-v4.1-flash:free

total: 552 models, 39 free, 513 unknown
```

---

## 4. Use with the OpenAI SDK

### Python

```bash
pip install openai
```

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8081/v1",
    api_key=os.environ["GATEWAY_API_KEY"],   # your gk_… key
)

resp = client.chat.completions.create(
    model="free",                              # gateway picks the model
    messages=[{"role": "user", "content": "Write a haiku about caching."}],
    max_tokens=64,
)
print(resp.choices[0].message.content)
print("served by:", resp.model)                # the model that actually answered
```

### Node / TypeScript

```bash
npm install openai
```

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8081/v1",
  apiKey: process.env.GATEWAY_API_KEY!,
});

const resp = await client.chat.completions.create({
  model: "free",
  messages: [{ role: "user", content: "Write a haiku about caching." }],
  max_tokens: 64,
});
console.log(resp.choices[0].message.content);
```

### Streaming

```python
stream = client.chat.completions.create(
    model="free",
    messages=[{"role": "user", "content": "Count to ten."}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

> Failover happens **before the first chunk**. Once tokens flow, a mid-stream failure
> surfaces as an error — a stream cannot be re-routed after bytes reach you.

---

## 5. Errors you will actually see

Every non-2xx uses the same envelope:

```json
{ "error": { "message": "…", "type": "service_unavailable", "code": "exhausted", "param": null } }
```

| Code | Means | Action |
|---|---|---|
| `400` | Malformed body | Fix the request |
| `401` | Missing/wrong `gk_…` key | Fix `Authorization: Bearer gk_…` |
| `404` | That model is unknown to your providers | Use `"free"`, or an id from `registry:list` |
| `429` | **You** are rate-limited | Slow down; honour `retry-after` |
| `503` | **No free capacity** — all keys parked, or none saved | Wait `retry-after`; check §2 |
| `504` | Upstream exceeded the 30 s deadline | Reduce `max_tokens`, retry |
| `501` | Unsupported parameter (`n`>1, `logprobs`, `tools`, …) | Remove it |

**`429` vs `503`:** `429` = *you* are throttled (back off). `503` = *the pool* has nothing
free right now (wait, retry). Both carry `retry-after` in seconds.

---

## 6. Endpoint reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/auth/register` | none | Create account; returns `gateway_api_key` |
| `POST` | `/v1/auth/login` | none | Username+password → session cookie + the same `gateway_api_key` |
| `POST` | `/v1/auth/regenerate-key` | none | Rotate the gateway key |
| `POST` | `/v1/auth/logout` | none | Clear the session cookie |
| `GET` | `/v1/user/me` | gateway key or cookie | Current user |
| `GET` | `/v1/user/gateway-key` | gateway key or cookie | Your gateway key (`null` for a legacy account) |
| `GET` | `/v1/user/keys` | gateway key or cookie | Your saved provider keys (metadata) |
| `POST` | `/v1/user/keys` | gateway key or cookie | Save a provider key (encrypted) |
| `DELETE` | `/v1/user/keys/:provider` | gateway key or cookie | Remove a provider key |
| `POST` | `/v1/chat/completions` | **gateway key** | Completions — `model: "free"` supported |
| `GET` | `/v1/providers/health` | gateway key | Upstream provider health |
| `GET` | `/healthz` | none | Liveness + dependency probes |

The httpOnly session cookie is accepted only on `/v1/user/*`; machine callers use a `gk_…` key.

> **Legacy accounts.** Accounts created before encrypted key storage existed have only a
> SHA-256 hash on the server. Login and `GET /v1/user/gateway-key` cannot return their key,
> but the current key keeps working. Regenerating issues a new key (and invalidates the old
> one), after which both return it.

---

## 7. Run the stack

```bash
npm run sex        # postgres + redis → migrations → backend :8081 → frontend :3000
```

Flags: `--no-docker` (services already up), `--keep-db` (leave containers), `--no-migrate`.
`Ctrl+C` stops everything.

Health check:

```bash
curl -s http://localhost:8081/healthz
```

---

## 8. New-integration checklist

- [ ] `gk_…` key in an env var, not in source
- [ ] At least one provider key saved (`POST /v1/user/keys`)
- [ ] `base_url` = `http://localhost:8081/v1`
- [ ] `model: "free"` (or omitted) unless you need a specific model
- [ ] Handles `429` (back off) vs `503` (wait/retry) via `retry-after`
- [ ] No unsupported parameters (`n`>1, `logprobs`, `tools`, `tool_choice`, `audio`)
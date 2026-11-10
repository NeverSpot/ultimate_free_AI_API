# Block 3b — Token Harbor adapter (plan)

Base URL `https://tokenharbor.ai/v1` (never `api.tokenharbor.com` — parked domain, 302).
OpenAI-compatible: `POST /chat/completions`, `GET /models`, `Authorization: Bearer <key>`.

## Files

- `src/providers/tokenharbor.ts` — new. `export class TokenHarborAdapter implements ProviderAdapter`,
  `id = 'tokenharbor'`, `supportsStreaming = false`, constructor `{ baseUrl?, fetchImpl? }` with
  injected `fetchImpl` and `DEFAULT_BASE_URL` fallback. Mirrors `src/providers/nvidia-nim.ts`.
- `test/unit/tokenharbor-adapter.test.ts` — new. Every test name starts `tokenharbor adapter:`.
  Stub `fetchImpl`; no network in tests.

Nothing else changes. No new deps. Never touch `src/http/`, `PROJECT.md`, `AGENTS.md`, `.env`.

## Spike observations (live, 2026-11-11, curl)

| Probe | Status | Body |
|---|---|---|
| chat `deepseek-v4.1-flash` | 200 | `{id,object:"chat.completion",created,model,choices:[{index,message:{role,content},finish_reason:"stop"}],usage:{prompt_tokens,completion_tokens,total_tokens}}` |
| bad key / no header | 401 | `{"error":{"message":"No valid API key found…","type":"invalid_api_key","code":"invalid_api_key"}}` |
| unknown model | 404 | `{"error":{"message":"Model '…' is not available…","type":"model_not_found","code":"model_not_found"}}` |
| empty `messages` | 400 | `{"error":{"message":"messages is required and must be a non-empty array.","type":"invalid_request_error","code":"invalid_request_error"}}` |
| `:free` model, allowance spent | 429 | `{"error":{"type":"free_tier_limit_reached"}}` + header `Retry-After: 3600` |
| `GET /models` | 200 | `{object,data:[{id,object,created,owned_by,label,blurb,tier,pricing{…},context_length,tool_call}]}` — 82 models |

Notes: `message` has only `role` and `content` (no `refusal`). `usage` was present on 200.
Error envelope is `{error:{message,type,code}}` — there is no `detail`/`title` field.
Model ids are bare names (`deepseek-v4.1-flash`); the 4 free ones end in `:free`.

## Error mapping

| Status | kind | message source |
|---|---|---|
| 400 | `client` | `error.message` |
| 401 / 403 | `auth` | `error.message` |
| 404 | `model_gone` | `error.message` |
| 429 | `rate_limited` | `error.message`, plus `retryAfterMs` parsed from `Retry-After` seconds |
| 5xx | `upstream` | `error.message` or `HTTP <status>` |
| other / non-JSON | `upstream` | `HTTP <status>` |

Unknown model is 404, so `model_gone`; the router may then drop that model. `stream()` throws
`ProviderError('unsupported', …)`. Aborted signal → `timeout`.

## Model mapping (`listModels`)

`id` → id, `provider: 'tokenharbor'`, `owned_by` → owned_by, `context_length` → `context_window`,
`is_free` = `true` when id ends with `:free`, otherwise **`null`** (never `false`: false would make
the router permanently skip a model that may be usable).

## Acceptance

```bash
npm run verify                                                   # exit 0
npm run test -- --test-name-pattern "tokenharbor adapter"        # all pass
```

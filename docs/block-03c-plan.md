# Block 3c — OpenRouter adapter plan

**Spike date:** 2026-11-10 · **Evidence:** `artifacts/spike/*` (gitignored) · **Impl:** OpenCode
**Base URL:** `https://openrouter.ai/api/v1` · `Authorization: Bearer <key>`

| Probe | Result |
|---|---|
| `GET /models` | `200`, **433** models, 771 KB, `Cache-Control: private, max-age=5` |
| `POST /chat/completions` bad key | `401` `{"error":{"message":"User not found.","code":401}}` |
| missing `Authorization` | `401` `{"error":{"message":"No cookie auth credentials found","code":401}}` |
| unknown model id | **`400`** `{"error":{"message":"<id> is not a valid model ID","code":400},"user_id":"…"}` |
| malformed `messages` | `400` `{"error":{"message":"Input required: specify \"prompt\" or \"messages\"","code":400}}` |
| happy path (`:free` model) | `200`; `usage` adds `cost`,`is_byok`,`cost_details`; `message.content` may be `null` (reasoning-only) |

`error.code` is a **number**, not a string, and there is no `error.type` field.

## Finding 1 — pricing values are STRINGS (all 433 models)

Type histogram over every `pricing` key: `prompt:string` 433/433, `completion:string` 433/433,
`overrides:object` 78/433. Zero is the string `"0"`. Eight models (`openrouter/auto`,
`openrouter/auto-code`, `openrouter/auto-beta`, `openrouter/fusion`, `openrouter/pareto-code`,
`openrouter/bodybuilder`, `typesafe/jev-router`, `nvidia/switchyard`) carry `"-1"` — a
*variable pricing* sentinel, **not** free. `pricing.prompt === 0` is false for all 433.

**Free rule.** `num()` coerces string|number, returning `null` for anything unparseable.
`is_free = true` iff `num(prompt) === 0 && num(completion) === 0` **and** every other numeric
pricing field is `<= 0`. Otherwise `null`. **Never `false`.** Live result: 16 true, 417 null.
Two half-zero models (`scaledown/summarize`, `scaledown/extract`: prompt > 0, completion `"0"`)
are correctly *not* free. A `:free` suffix is corroboration, never the rule — `openrouter/free`
and both `google/lyria-3-*` previews are zero-priced without it.

## Finding 2 — there are NO `x-ratelimit-*` headers

`200`, `400` and `401` responses expose no `x-ratelimit-*`, no `Retry-After`, no quota header.
The only quota surface is `GET /auth/key`: `is_free_tier:true`, `usage:0`,
`free_model_daily_requests:{used:1,limit:50,remaining:49}`, and
`rate_limit:{requests:-1,interval:"10s",note:"This field is deprecated and safe to ignore."}`.
So Block 6 **cannot** read limits from response headers; it must poll `GET /auth/key` (+
`GET /credits`) or learn limits from `429`s. Parse `Retry-After` defensively on `429` — no live
429 was produced, so that path is contract-only.

## Error mapping

| Upstream | Condition | kind | note |
|---|---|---|---|
| 200 | — | — | `usage.estimated = false`; usage is measured, not approximated |
| 400 | message matches `/is not a valid model ID/i` | `model_gone` | **live:** unknown ids are 400, never 404 |
| 400 | otherwise | `client` | |
| 401 | — | `auth` | |
| 402 | — | `auth` | not reproducible (`total_credits:0` still served a paid model); per-credential funding state, retrying the same key never succeeds |
| 404 | — | `model_gone` | |
| 429 | — | `rate_limited` | `retryAfterMs` from `Retry-After` when present |
| 5xx | — | `upstream` | |
| abort | `AbortError` / signal aborted | `timeout` | |

## Acceptance

`npm run verify` → exit 0, no pre-existing test lost · `npm run test -- --test-name-pattern "openrouter adapter"`

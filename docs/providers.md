# Providers — verified 2026-11-11

Base URLs and model-discovery shapes confirmed by live `GET /v1/models` against the
account keys in `.env`. Re-verify before Block 4 — free tiers change monthly and the
registry must discover limits at runtime, never trust this file.

| Provider | Base URL | Models | Free | Auth header |
|---|---|---|---|---|
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | 84 | no free flag — credit-based | `Authorization: Bearer <key>` |
| OpenRouter | `https://openrouter.ai/api/v1` | 433 | 16 with `pricing.prompt == "0"` or `:free` suffix | `Authorization: Bearer <key>` |
| Token Harbor | `https://tokenharbor.ai/v1` | 82 | 4 with `:free` suffix | `Authorization: Bearer <key>` |

## Discovery differences that will bite in Block 4

1. **Free is expressed differently by each provider, and a missing signal means `null`.**
   OpenRouter marks free models a `:free` id suffix *and* zero pricing. Token Harbor marks
   them with a `:free` suffix. NVIDIA has no free signal at all — access is credit-based, so
   `is_free` must be `null` (unknown), **not `false`**. Reporting `false` would make the
   router permanently skip a usable provider.
2. **Model counts differ by two orders of magnitude** (84 vs 433 vs 82). The registry
   table needs an index on `(provider, model_id)` and must tolerate ~600 rows on refresh.
3. **Ids are namespaced inconsistently.** NVIDIA uses `vendor/model` (`01-ai/yi-large`),
   OpenRouter uses `vendor/model`, Token Harbor uses bare names with a `:free` suffix
   (`deepseek-v4.1-flash:free`). The adapter must not assume a `/` in the id.

## Correction found during verification

The OpenCode provider config at `~/.config/opencode/opencode.json` points Token Harbor at
`https://api.tokenharbor.com/v1`. **That host is a parked domain** — it returns
`302 -> hugedomains.com`. The live endpoint is `https://tokenharbor.ai/v1`.
Hermes's own `config.yaml` already uses the correct host. Do not copy the base URL out of
the OpenCode config.

## Verified error envelopes (NVIDIA NIM, probed twice — by the worker and by Hermes)

NVIDIA does **not** return a uniform error shape. The adapter must handle all three:

| Case | Status | Body |
|---|---|---|
| Bad key | 401 | `{"status":401,"title":"Unauthorized","detail":"Invalid JWT serialization: Missing dot delimiter(s)"}` |
| **Unknown model** | **404** | **`404 page not found` — plain text, not JSON** |
| Empty `messages` | 400 | `{"message":"Validation: The 'messages' field cannot be empty...","type":"Bad Request","code":400}` |
| Malformed JSON | 400 | `{"error":{"message":"request body is not valid JSON","type":"invalid_request_error","param":null,"code":"invalid_json"}}` |

The plain-text 404 is the trap: calling `response.json()` on it throws, and a naive adapter
reports `upstream` instead of `model_gone`. `NvidiaNimAdapter` catches the parse failure and
maps 404 explicitly before falling back.

Confirmed independently: an unknown model (`definitely/not-a-real-model`) returns
`404` + `404 page not found`. So `404 -> model_gone` is correct for NVIDIA, but the
classification is only valid because the body is non-JSON — do not assume the same for the
other two providers, which return structured JSON errors.

## Correction — Token Harbor's `/models` is richer than first recorded

An earlier note in this file claimed Token Harbor has "no pricing field". **That was wrong.**
Each entry carries:

```
id, object, created, owned_by, label, blurb, tier,
pricing { input_usd_per_1m, output_usd_per_1m, cache_read_usd_per_1m, cache_write_usd_per_1m },
supports_prompt_cache, context_length, tool_call, function_call
```

Two fields matter beyond `id`:

- **`context_length`** is real (free models report 1,000,000–1,048,576), so `context_window`
  need not be `null` for this provider.
- **`tier`** is a coarse quality signal — `low`, `mid`, `high`. The four free models split
  `mimo-v2.5:free` → `mid`; the three DeepSeek/MiMo flash models → `low`. This is a free
  input to task-fit ranking in Block 13 and should be persisted in the registry.

## The rate-limit model is NOT uniform — this reshapes Block 6

Every one of Token Harbor's four `:free` models carries this in its `blurb`:

> *"Free-tier only — uses your rolling **7-day allowance**, then returns a rate-limit error.
> Never billed. Drop the ':free' suffix to use the paid route."*

Consequences that invalidate a naive RPM design:

1. **The window is a week, not a minute.** A ledger keyed only on `rpm` will let the gateway
   hammer a 7-day bucket until it empties, then sit dead for days with no idea why.
2. **`Retry-After` is misleading.** On free-allowance exhaustion Token Harbor returns
   `Retry-After: 3600` while the allowance actually resets days later (a probe saw the body
   name a reset date five days out). Honouring 3600 s would retry far too early, burning
   another 429 each minute.
3. **429 is overloaded.** The same status covers ordinary rate limiting and
   `free_tier_limit_reached`. They need different responses — back off seconds vs park for
   days — and the only discriminator is the `type` string in the body.

**Therefore the ledger must be multi-window** (`rpm`, `rpd`, `rpw`) with a per-(provider,
model) policy for which windows apply, and 429 handling must inspect `error.type`, not just
the status code. This is a Block 6 requirement, discovered here.

## Verified error envelopes — Token Harbor

Uniform JSON, unlike NVIDIA:

| Case | Status | Body |
|---|---|---|
| Bad / missing key | 401 | `{"error":{"message":"No valid API key found...","type":"invalid_api_key","code":"invalid_api_key"}}` |
| Unknown model | 404 | `{"error":{"message":"Model '...' is not available...","type":"model_not_found","code":"model_not_found"}}` |
| Empty `messages` | 400 | `{"error":{"message":"messages is required and must be a non-empty array.","type":"invalid_request_error","code":"invalid_request_error"}}` |
| Free allowance spent | 429 | `{"error":{"type":"free_tier_limit_reached"}}` + `Retry-After: 3600` |

No `detail` or `title` keys — the envelope is always `{error:{message,type,code}}`.

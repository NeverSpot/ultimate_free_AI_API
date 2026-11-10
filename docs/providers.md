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

1. **Free is not a field, it is a convention.** OpenRouter encodes it two ways —
   a `:free` id suffix *and* `pricing.prompt == "0"`. Token Harbor uses only the suffix.
   NVIDIA NIM has neither: access is credit-based, so `is_free` must be `null` (unknown),
   **not `false`**. Reporting `false` would make the router skip a usable provider.
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

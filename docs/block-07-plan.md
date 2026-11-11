# Block 7 — one classifier, honest 429s

**Gate:** `npm run verify` exit 0 (hermetic) + `node --import tsx --test test/unit/classify.test.ts
test/unit/park-decision.test.ts` green + `npm run test:int` still 13. `codegraph impact ProviderError`
= **52 before**. `src/core/errors.ts` is **not edited**: `src/http/errors.ts` has three exhaustive
switches with no `default`, so a new `ErrorKind`/field is a typecheck break in a forbidden file.

## API (`src/resilience/`)

`retry-after.ts` — `parseRetryAfterMs(value, now): number | undefined`: seconds (`"30"` → 30_000), HTTP-date (`Date.parse(v) - now`, clamped ≥ 0), garbage → `undefined`.

`classify.ts`
```ts
interface ParsedError { json: boolean; message?: string; type?: string; code?: string | number; text: string }
parseErrorBody(status: number, bodyText: string): ParsedError     // never throws
isRateLimitBody(parsed: ParsedError): boolean                     // rate-limit or allowance signal
type RateLimitVerdict =
  | { limit: 'throttle';  retryAfterMs: number | undefined; source: 'header' | 'none' }
  | { limit: 'allowance'; parkUntil: number | null };
rateLimitVerdict(status, parsed, headers, now): RateLimitVerdict | null
classifyStatus(status, parsed, headers, opts?: { provider?; profile?; now? }): ProviderError
```
`parseErrorBody` handles four bodies without throwing: **empty**; **plain text/HTML** (NVIDIA
`404 page not found`); **flat** NVIDIA (`{status,title,detail,message,type,code}`); **nested**
`{error:{message,type,code}}` with a string code (Token Harbor/OpenAI) or a numeric code
(OpenRouter). Non-JSON never contributes a message — `classifyStatus` falls back to `HTTP <status>`
— so no upstream HTML reaches a client.

## Per-provider quirks (`ERROR_PROFILES`, keyed by adapter id)

| Provider | auth | model_gone | 429 | notes |
|---|---|---|---|---|
| `nvidia` | 401,403 | 404 **by status alone** (plain-text body) | throttle | flat envelope, `detail` is the message |
| `openrouter` | 401,402 | 400 **iff** message matches `^<id> is not a valid model ID\.?$` (anchored) **and** not `type: invalid_request_error` **and** code absent-or-numeric; 404 too | throttle | numeric `code`, no `type` |
| `tokenharbor` | 401,403 | 404 | throttle **or** allowance (`type`/`code` = `free_tier_limit_reached`) | never 400-as-model_gone |
| generic | 401,403 | 404 | throttle | unknown adapter, OpenAI envelope |

Anchor + `type`/`code` guards: a malformed-body 400 (`request body is not valid JSON`) cannot match.

## 429 disambiguation

`RateLimitVerdict.limit` discriminates; `classifyStatus` maps the branches to **different kinds**:
- `throttle` → `rate_limited` + `retryAfterMs` from `Retry-After` (seconds or HTTP-date), `undefined`
  when absent — a fallback backoff is `parkDecision`'s job, not the adapter's.
- `allowance` → **`exhausted`**, `retryAfterMs` **dropped on purpose**: Token Harbor sends
  `Retry-After: 3600` on a 7-day allowance, a ~170× lie. `exhausted` needs no new kind — it already
  maps to `503 service_unavailable` / `code: exhausted` — "out for days, not seconds". Detail lives
  in `RateLimitVerdict.parkUntil`, parsed only from an explicit `error.resets_at`/`reset_at`/
  `retry_after` body field (ISO-8601 or epoch); absent → `null`.

## `park-decision.ts` — `parkDecision(o): { action: 'retry' | 'park'; waitMs: number; window? }`

Input `{ kind, retryAfterMs?, parkUntil?, window?, now? }`; `window` is the ledger tag from `reserve()`.

| condition | action | waitMs |
|---|---|---|
| `client`,`auth`,`model_gone`,`too_long`,`blocked`,`unsupported` | park | `Infinity` (never this run) |
| `exhausted` | park | `parkUntil-now` ?? `retryAfterMs` ?? `LEDGER_WINDOW_MS.rpw`; `window:'rpw'` |
| `window:'rpw'` / `'rpd'` | park | `retryAfterMs` ?? that window's length |
| `window:'rpm'` | retry | `retryAfterMs` ?? 0 |
| `rate_limited`, no window | retry if `retryAfterMs <= 60_000`, else park | `retryAfterMs` ?? 1_000 |
| `upstream`, `timeout` | park (next candidate) | `retryAfterMs` ?? 0 — cooldown is Block 8's |

`60_000`/`1_000` are reaction thresholds, not ceilings: no RPM/RPD/TPM number appears, so invariant 1 holds.

**Adapters.** `await response.text()`, then `parseErrorBody`; the success path `JSON.parse`s. Each adapter calls
only `classifyStatus(status, parsed, headers, { provider, profile })`; `chat`/`stream`/`listModels`
and `supportsStreaming` are unchanged. Acceptance: `npm run verify` exit 0 (<15 s), the two new test
files by name, `npm run test:int` (13), empty `git diff HEAD -- src/providers/types.ts src/core/errors.ts`.

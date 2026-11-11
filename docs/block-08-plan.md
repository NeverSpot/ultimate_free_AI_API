# Block 8 — circuit breaker + credential parking

**Gate:** `npm run verify` exit 0, hermetic, <15 s; `npm run test:int` green with `REDIS_URL` set.
`codegraph impact` before **and** after: `ProviderError` **51**, `rateLimitVerdict` **4** — only new
files are added, nothing existing is edited.

## Two faults, two mechanisms
| Fault | Scope | Key | Mechanism |
|---|---|---|---|
| `429` on one key | **credential** | `cd:{credentialId}` | parked until retry-after / window reset |
| `5xx` / timeout | **(provider, model)** | `br:{provider}:{model}` | breaker OPEN, cooldown, probe |

A `429` never opens a breaker. A `5xx` never parks a credential.

## State machine
```
CLOSED    --(failures in window >= threshold)---> OPEN       openedAtMs = now
OPEN      --(now - openedAtMs >= cooldownMs)----> HALF_OPEN  probesUsed = 1 (allow claims it)
HALF_OPEN --(probe success)---------------------> CLOSED     failure window cleared
HALF_OPEN --(probe failure)---------------------> OPEN       openedAtMs = now (fresh cooldown)
OPEN      --(success of a request started pre-open)> OPEN    no-op: only a probe closes
```
The last row matters: an in-flight success landing after the trip must not reopen the gate.

## Keys
```
br:{provider}:{model}     hash    state=closed|open|half_open, openedAtMs, probesUsed
br:{provider}:{model}:f   zset    failure events: score = ms, member = per-call nonce
cd:{credentialId}         string  parkedUntilMs, ttl = untilMs - now
```
One Lua script per transition path (`allow`, `recordFailure`, `recordSuccess`): read-decide-write is
one atomic step, as with the ledger. Idle targets expire via `PEXPIRE windowMs + cooldownMs`.

**Sliding, not consecutive.** A consecutive counter resets on any success, so a provider failing
30 % of requests — the p95 case here — never trips, and one success on replica A erases failures
counted on B. The window counts failures in the last 60 s whatever sits between them: one ZSET
member per failure, pruned by score on write.

**Probe limit = 1** (`createBreaker(client, { probeLimit })`). The probe answers a binary question —
is it reachable? — and each extra probe is another failing round-trip paid by the p95. `allow()`
claims the slot in the same script, so of 50 concurrent calls at cooldown expiry one reaches the
network and 49 get `{allowed:false}` with the remaining cooldown; without the claim, a herd.
Tradeoff: one lucky probe closes early and costs at most `threshold` failures — the trip's own price.

## Zero network calls while OPEN
`allow(target)` is the only gate and there is no escape hatch: `{allowed:false, retryAfterMs, state}`
comes back without the breaker touching a provider. Block 9 reads the permit before it builds a
request. Proven by a counter, not a comment — a fake `fetch` spy behind `if (permit.allowed)
fetch(...)` sees its call count **unchanged** across 20 calls made while OPEN.

## Parking
`park(cid, untilMs)` / `isParked(cid) -> {parked, retryAfterMs}` / `unpark(cid)` /
`applyDecision(cid, decision, now)`. The retry-vs-park rule stays in `parkDecision`: `retry` writes
nothing, `park` sets `now + waitMs`, `Infinity` (auth / model_gone) caps at `LEDGER_WINDOW_MS.rpw`, the
longest horizon known, so a rotated key recovers itself. `PTTL` is truth; parking touches no `br:`.

## Parameters and files
Cooldown is measured against `Redis TIME` in Lua so skewed replica clocks agree; the pure rules take
`now`, which is what the hermetic suite tests. Defaults are reaction costs, not ceilings — `windowMs
60_000`, `threshold 5`, `cooldownMs 30_000` — so invariant 1 holds: no RPM / RPD / TPM number appears.
Files: `src/resilience/{breaker.ts,breaker.lua,parking.ts}`, `test/unit/breaker-rules.test.ts`,
`test/integration/{breaker,parking}.test.ts`; the client seam is a local structural interface, so a
`LedgerClient` satisfies it and library code reads no `process.env`.

## Acceptance
1. `npm run verify` -> exit 0, hermetic, no drop from 192 tests.
2. `REDIS_URL=redis://127.0.0.1:6379 npm run test:int` green: N failures -> OPEN; `allow()` while OPEN
   -> not allowed **and fetch count 0**; cooldown -> HALF_OPEN; probe success -> CLOSED; probe failure
   -> OPEN with fresh cooldown; a 7-day credential park leaves another key on that provider serving.
# Block 6 — multi-window rate-limit ledger

**Gate:** `npm run verify` exit 0 (hermetic; the ledger suite self-skips) **and**, with Redis up,
`REDIS_URL=redis://127.0.0.1:6379 npm run test:int` green, including the `ledger race` case.
`codegraph impact discoverModels` = 8 symbols / 5 callers, untouched here (new files only).

## Schema & window semantics

Key `rl:{credentialId}:{modelId}:{window}` → integer usage count; TTL = window length: `rpm` 60_000,
`rpd` 86_400_000, `rpw` 604_800_000 ms (`LEDGER_WINDOW_MS`). TTL is written **only on creation**
(fixed window from first use): deviating from calendar-aligned reset keeps PTTL a real floor.

- *Applicable* = the policy names the window; *enforced* = it also carries a positive ceiling
  (applicable-without-ceiling tracks usage but cannot refuse).
- Refusal is all-or-nothing: when any enforced window is short, **no** window is incremented.
- `retryAfterMs` = PTTL of the blocking key (window length if the TTL is gone): a **floor**, never provider truth — Token Harbor answers `Retry-After: 3600` on a 7-day allowance.

## Policy shape

```ts
type Window = 'rpm' | 'rpd' | 'rpw';
interface LimitPolicy {
  rpm?: number | null; // null = window applies, ceiling not known yet
  rpd?: number | null;
  rpw?: number | null;
  observable: 'quota-endpoint' | 'inferred';
}
resolvePolicy(provider: ProviderId, modelId: string): LimitPolicy
```

`null` (not absence) preserves AGENTS invariant 1: structure is code, **ceilings are not**. Numbers
arrive at runtime — `models.rpm_limit`/`rpd_limit` from the registry, `/auth/key` for OpenRouter —
and re-enter via `withCeilings(policy, {...})`. Defaults: `nvidia` `{observable:'inferred'}`
(credit-based: no window, no signal); `openrouter` `{rpd:null, observable:'quota-endpoint'}`;
`tokenharbor` id ending `:free` `{rpw:null, observable:'inferred'}`; unknown → `{observable:'inferred'}`.

## Lua contract (`ledger.lua`, one EVALSHA per reserve)

KEYS = keys of the enforced windows; ARGV = `[cost, limit_1..n, ttlMs_1..n]`. Returns `{ok, index,
waitMs}`:

| case | ok | index | waitMs |
|---|---|---|---|
| reserved | 1 | 0 | 0 |
| refused | 0 | 1-based index of the **longest-waiting** blocked window | its PTTL |

Loop over **every** window (never `return` on the first failure) tracking the max PTTL; only when
that max is 0 does the script INCRBY each key and PEXPIRE the ones it created.

## Union, and why `retryAfterMs` is not enough

```ts
reserve({credentialId, modelId, policy, cost}) =>
  | { ok: true;  reservation: { credentialId, modelId, cost, reserved: {window,key,amount}[] } }
  | { ok: false; retryAfterMs: number; window: Window }
```

45 s means wait and retry, 6 days means park; `retryAfterMs` cannot separate them once the provider lies about its reset, but the `window` tag can: `rpm` → in-process wait, `rpd` → park to reset or switch credential, `rpw` → mark that credential exhausted for the provider.

`release(reservation)` DECRBYs the reserved amounts (clamped at 0, never creating a missing key, TTL
untouched) so a failed upstream does not permanently burn budget; `commit(reservation, actual)` shifts
usage by `actual - cost` identically. Both are Lua, for the same atomicity reason.

## Files

`src/limits/{policy,ledger,ledger.lua,redis}.ts`, `test/unit/limit-policy.test.ts` and
`test/integration/ledger.test.ts`. `createLedgerClient(url)` (ioredis `defineCommand` = free EVALSHA +
NOSCRIPT reload, `ioredis@5.11.1`) sits behind a `LedgerClient` interface; no `process.env` in `src/`.

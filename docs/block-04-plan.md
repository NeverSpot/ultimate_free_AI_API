# Block 4 — provider registry and free-model discovery

Baseline: HEAD `3618811`, tree clean, `npm run verify` exits 0 with **124 tests**, 13.5s wall.

## Codegraph baseline (measured, index 29 files / 600 nodes / 1756 edges)

- `codegraph impact ProviderAdapter` → **92** before, **109** after (+17 references from `registry.ts` and
  its test; `types.ts` is byte-identical, so the interface did not move — it merely gained consumers).
  **This block must not change that interface**; `registry.ts` consumes it as-is.
- `codegraph callers loadCredentialPool` → **6** before, **7** after (`scripts/registry-list.ts` is the new
  edge consumer — still **nothing in `src/`**). `discoverModels(registry, pool)` takes the pool as an
  argument, so the registry never reads `process.env`.

## Module API — `src/providers/registry.ts`

```ts
interface ProviderRegistry { get(id: ProviderId): ProviderAdapter | undefined; ids(): ProviderId[]; size(): number }
interface DiscoveryFailure { provider: ProviderId; kind: string; message: string }
interface DiscoveryResult { models: ModelInfo[]; failures: DiscoveryFailure[] }
createProviderRegistry(adapters: ProviderAdapter[]): ProviderRegistry   // duplicate id -> throw
discoverModels(registry: ProviderRegistry, pool: CredentialPool): Promise<DiscoveryResult>
```

`ids()`/discovery order = registration order (mirrors `pool.providers()`). Duplicate id **throws**
`Duplicate provider adapter id "<id>"` — last-wins silently hides a wiring bug, first-wins hides the
collision; both turn into "wrong provider answers". No `process.env`, no import of `scripts/`.

## Failure isolation (the rule)

Per adapter, `try { await adapter.listModels(cred) } catch`. `ProviderError` → `error.kind`; anything
else → `kind: 'unknown'`; `message` from `error.message`, never the credential (**never spread
`cred.secret`** — invariant 7). A throw goes to `failures` and the loop continues, so one dead key
cannot zero out a run. No credentials → `continue` **silently** (unconfigured is not a fault).
Sequential, for deterministic output. Known gap, recorded not hidden: `listModels` has no
`AbortSignal`, so a hung provider stalls the run — Block 12's problem, not a magic timeout here.

## Credentials: first only, do not merge

Use `pool.getCandidates(id)[0]`. `/models` is account-level, so keys of one provider return the same
catalog; merging would emit every model N times and break id uniqueness downstream. If the first key is
bad that is a genuine `auth` failure and must be visible — silently spending extra calls on key 2 would
hide a misconfigured `*_KEYS` var.

## Free-model rule per provider

The registry **never computes or rewrites** `is_free`; adapters own the signal, verbatim passthrough.
NVIDIA: always `null` (credit-based, no flag). OpenRouter: `:free` suffix **and** all pricing strings
zero. Token Harbor: `:free` suffix. `null` means unknown and is **never coerced to `false`** — `false`
would make the router skip a usable provider permanently. Counting is strictly `is_free === true`;
unknowns are shown separately, never folded into free or paid.

## Acceptance (all run by the architect, never claimed by the coder)

1. `npm run verify` → 0; 124 pre-existing tests intact (none deleted/skipped) + the new `provider registry:` tests.
2. `npm run test -- --test-name-pattern "provider registry"` → 0.
3. `npm run registry:list` → per-provider table, total, failures; exit 1 iff `failures` non-empty.
4. `tsc -p tsconfig.build.json` emits `src` only — no `dist/scripts`, no `dist/test`.
5. **Provider test**: a 4th fake adapter declared inline in `test/unit/provider-registry.test.ts`
   registers and is discovered with correct tagging, with **zero edits to existing files**. Proof, not assertion.

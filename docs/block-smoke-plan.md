# Block smoke — live end-to-end probe (`npm run smoke`)

Hermetic tests prove the adapters in isolation; nothing proves the adapters *and* the credential
pool work together against the real APIs. This script is that proof — and the demo.

## Contract — `scripts/smoke.ts`

- Loads config and the pool from `process.env` (`npm run smoke` supplies `.env`); never reads a
  key file itself. Builds a `provider -> adapter` map for `nvidia`, `openrouter`, `tokenharbor`
  using the real adapters with their default base URLs.
- **Provider ids are inconsistent today:** the pool keys NVIDIA creds as `nvidia-nim` while
  `NvidiaNimAdapter.id` is `nvidia`. Resolve it in ONE named constant
  `POOL_KEY: Record<ProviderId, ProviderId>` (`nvidia -> 'nvidia-nim'`), commented as a known
  mismatch awaiting an ADR. Do not edit `src/credentials/pool.ts`.
- For each selected provider with >= 1 credential: `listModels(cred)` -> print model count and
  how many are `is_free === true`; then `chat()` once with `Reply with exactly: PONG`,
  `max_tokens: 16`, printing returned model id, total tokens, `usage.estimated`, elapsed ms.
- Model choice: `--model <id>` if given, else first `is_free === true`, else first listed model.
- `--provider <id>` restricts the run to one provider (unknown id -> usage error, exit 1).
- Every call carries `AbortSignal.timeout(20_000)`; a hung provider cannot hang the script.
- Prints one aligned line per provider plus a summary line. Never prints `cred.secret`, an
  `Authorization` header, or a raw response body — errors are reduced to `ProviderError.kind`.
- `runSmoke(options)` must be exported and pure over injected `{ pool, adapters, write }` so the
  exit-code rule and the formatter are testable without the network; `main()` runs only under
  `if (require.main === module)`.

## Output format

```
provider      creds  models  free  model                        tokens  est    ms     status
nvidia            1      84     0  meta/llama-3.1-8b-instruct       24  false   812  ok
openrouter        1     433   118  liquid/lfm-2.5-2.6b:free           19  false   604  ok
tokenharbor       1      82    4   deepseek-v4.1-flash:free           18  false   431  ok
3 providers: 3 ok, 0 failed (2.4s)
```
Columns are sized from the data; `free` is `0` when the provider has no free signal (NVIDIA).

## Exit codes

`0` only when every selected provider succeeded. `1` if any selected provider throws, returns
zero models, or has no credential, and if none are selected. Failures print `FAILED <kind>` on the
row plus an `error[kind]` line; non-`ProviderError` throws print `FAILED unknown`.

## Acceptance

- `npm run typecheck` covers `scripts/` (include widened); `tsconfig.build.json` still `src` only.
- `npm run verify` -> exit 0, **105 + N tests**, 0 fail; verify stays hermetic (no smoke in it).
- `node --test test/unit/smoke-plan.test.ts` green with fake adapters only; `npm run smoke` and
  `npm run smoke -- --provider openrouter` print the real table.

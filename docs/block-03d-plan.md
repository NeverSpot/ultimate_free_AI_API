# Block 3d — credential pool

One free-tier key throttles at ~30 req/min, so a provider is really a *set* of keys;
`loadCredentialPool` turns `NVIDIA_NIM_KEYS`, `OPENROUTER_KEYS` and `TOKENHARBOR_KEYS` into
the `Credential[]` that later blocks iterate to pick (model, credential) pairs.

## API — `src/credentials/pool.ts`

`loadCredentialPool(raw: NodeJS.ProcessEnv): CredentialPool`, pure over the injected env map
in the `loadConfig` style: it never reads `process.env`; tests pass a literal, production
passes `process.env` at the edge. `CredentialPool` is `getCandidates(p)` (empty array for an
unknown provider, never a throw), `providers()` (only providers holding >= 1 credential),
`credentialsFor(p)`, and `size(p?)` (total when the argument is omitted).

## Parsing rules

- Env var to provider is a data table, one line each: `NVIDIA_NIM_KEYS`->`nvidia-nim`,
  `OPENROUTER_KEYS`->`openrouter`, `TOKENHARBOR_KEYS`->`tokenharbor`.
- Split on `,`, `trim()` each entry, drop empty/whitespace-only ones, so `""`, `"  "`,
  `"a,,b"` and `"a, ,b"` all parse without error. Unset or empty yields `[]`, not an error.
- Throws one aggregated `Error` (`loadConfig` pattern) only for genuinely malformed input:
  a non-string value, or an entry with an interior newline.
- Returned arrays are copies; mutating them cannot corrupt the pool.

## `Credential.id` = `provider + "-" + sha256(provider + "\0" + secret).slice(0,16)`

- **Stable across restarts** — pure function of (provider, key): no counter, clock or file,
  so reordering `.env` cannot change an existing id.
- **Never reveals the key** — a 16-hex-char truncated SHA-256 of a 64-char random key is
  preimage-resistant; the key is never embedded, prefixed or trimmed into the id.
- **Provider is hashed in**, so one key under two providers yields two distinct ids.
- **Readable** (`openrouter-9f2a1c...` greps in logs): `label` adds an ordinal such as
  `openrouter-1`, for human tracing only — `id` is identity, `label` is never a key.
- Collision (two keys, one provider, same 16 chars) is astronomically unlikely; the loader
  widens *all* colliding ids in that provider to 32 chars rather than merging or throwing.

## Duplicates and redaction

Same key twice under one provider yields **one** credential (dedupe on the secret string
before id assignment, first wins); the same key string under two providers yields **two**;
`"k1,k1, ,k1"` yields one, because blanks drop before dedupe.

`secret` is a **non-enumerable** own property, plus `toJSON()` returning `{ id, provider,
label }` and `toString()` returning `credential:<id>`: so `JSON.stringify`, `String`,
`console.log` and error messages cannot print the key, while `cred.secret` still works for
the adapters. Errors name the entry index and its length, never the value.

## Files and acceptance

New: `src/credentials/pool.ts`, `test/unit/credential-pool.test.ts` (names start `credential pool:`).
Forbidden: `.env`, `src/http/`, adapters, `PROJECT.md`, `AGENTS.md`, `package-lock.json`.

`npm run verify` -> exit 0 with >= 92 tests; `npm run test -- --test-name-pattern "credential
pool"` -> 10+ pass, 0 fail; `git status --porcelain` -> only the two new files; plus a live
probe over the real `.env` printing only `provider -> count` and ids, never secrets.

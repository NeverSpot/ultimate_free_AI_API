# Block 5 — Persist Model Registry in Postgres

## Objective
Store every discovered model in a Postgres `models` table with idempotent migrations, a one-shot `registry:sync` command, and an optional hourly `--watch` mode. **Last-known-good** semantics: if a provider's `listModels` throws mid-refresh, its existing rows survive untouched — never deleted, never dropped.

---

## Migration Strategy

**Runner:** `src/db/migrate.ts` + `npm run db:migrate`
- Creates `schema_migrations(version text primary key, applied_at timestamptz not null default now())` if absent.
- Scans `migrations/*.sql` in lexical order, applies each inside a **single transaction**.
- **Idempotent:** on second run, version exists -> nothing runs, exits 0.

**File:** `migrations/0001_models.sql`
```sql
create table if not exists models (
  provider text not null,
  model_id text not null,
  context_window int,
  is_free boolean,
  owned_by text,
  rpm_limit int,
  tpm_limit int,
  rpd_limit int,
  healthy boolean not null default true,
  checked_at timestamptz not null,
  primary key (provider, model_id)
);

create index if not exists idx_models_provider_is_free on models (provider, is_free);
create index if not exists idx_models_checked_at on models (checked_at);
```

---

## Table Shape Rationale

| Column | Type | Notes |
|--------|------|-------|
| provider | text | ProviderId — matches `CredentialPool.providers()` |
| model_id | text | Raw model id (namespaced: `vendor/model` or bare with `:free`) |
| context_window | int | From `ModelInfo.context_window` (real for Token Harbor, null for NVIDIA) |
| is_free | boolean **NULLABLE** | `true` / `false` / **`null` (unknown)** — never default false. NVIDIA is always `null`. |
| owned_by | text | `ModelInfo.owned_by` |
| rpm_limit | int | Reserved for Block 6 (multi-window ledger) |
| tpm_limit | int | Reserved for Block 6 |
| rpd_limit | int | Reserved for Block 6 |
| healthy | boolean | Default `true`; set `false` only if a provider throws on chat, not on `listModels` |
| checked_at | timestamptz | Timestamp of the refresh that produced this row |

**PK:** `(provider, model_id)` — one row per provider-model pair, upsert on conflict.

---

## Refresh Semantics (Last-Known-Good)

`scripts/registry-sync.ts` (`npm run registry:sync`, `npm run registry:sync -- --watch`):

1. Load credential pool from `process.env` (only at script edge).
2. Build registry from `defaultAdapters()`.
3. Call `discoverModels(registry, pool)` → `{ models, failures }`.
4. **Upsert** all `models` into `models` table with `checked_at = now()` (single transaction).
   - `ON CONFLICT (provider, model_id) DO UPDATE SET …`
5. **Do NOT delete** rows for providers that appear in `failures` or have no credentials.
   - A provider with `failures.length > 0` keeps all its old rows, `checked_at` stays stale.
   - A provider with **zero credentials** is "unconfigured" — also keeps old rows.
6. Print summary:
   ```
   Upserted: 599 models
   Providers refreshed: 3
   Skipped (error): tokenharbor [auth] Invalid API key
   Skipped (no creds): nvidia
   ```
7. Exit code: 0 if at least one provider refreshed, 1 if **all** configured providers failed.

**Why not delete on failure?**
- A transient 401 / network blip must not wipe a working catalog.
- The router (Block 6+) reads from this table — stale data is better than zero data.
- The `checked_at` index lets a future `stale_after` query surface providers that need a manual kick.

---

## Module Breakdown

| Module | Responsibility |
|--------|----------------|
| `src/db/client.ts` | `createDbClient(connectionString)` → `pg.Pool` wrapper (no `process.env` inside) |
| `src/db/migrate.ts` | Migration runner (idempotent, transactional) |
| `src/registry/store.ts` | `upsertModels(client, models, checkedAt)`, `listModels(client)`, `providersSummary(client)` |
| `scripts/registry-sync.ts` | One-shot + `--watch` CLI (hourly `setInterval`, clean `SIGINT`) |
| `test/unit/registry-store.test.ts` | Pure mapping (hermetic, no DB) |
| `test/integration/registry-store.test.ts` | Real Postgres, **self-skips unless `DATABASE_URL` set** |

---

## Acceptance Commands

```bash
# 1. Pre-existing tests still pass
npm run verify              # must exit 0, 134 tests

# 2. DB up + migration (twice = idempotent)
npm run db:up
npm run db:migrate          # applies 0001
npm run db:migrate          # no-op, exits 0

# 3. One-shot sync with real keys
npm run registry:sync       # upserts ~599 rows, prints counts

# 4. Integration test (manual, not in verify)
DATABASE_URL=postgres://gateway:gateway@127.0.0.1:55432/gateway npm run test:int

# 5. Last-known-good proof
#    a) After successful sync, count tokenharbor rows
#    b) TOKENHARBOR_KEYS=bad npm run registry:sync
#    c) Count tokenharbor rows again — MUST BE SAME
```

---

## Codegraph Impact (Pre-delegation)

- `codegraph impact discoverModels` → **4 affected symbols**
- `codegraph callers discoverModels` → **3 callers** (`registry.ts`, `provider-registry.test.ts`, `registry-list.ts`)

No shared interface changes required — `discoverModels` is the stable seam.

---

## Files Allowed for OpenCode

```
migrations/0001_models.sql
src/db/client.ts
src/db/migrate.ts
src/registry/store.ts
scripts/registry-sync.ts
test/unit/registry-store.test.ts
test/integration/registry-store.test.ts
package.json (scripts: db:migrate, registry:sync, test:int)
```

---

## Files Forbidden

`.env`, `docs/`, `PROJECT.md`, `AGENTS.md`, `package-lock.json`, `src/http/`, `src/providers/types.ts`, `src/providers/registry.ts`, `src/providers/defaults.ts`, `src/credentials/pool.ts`

---

## Constraints (from AGENTS.md)

- **Invariant 7:** Never spread a Credential.
- **No `process.env` inside library code** — only at script edges (`index.ts`, `scripts/*`).
- `npm run verify` **hermetic**, no Docker, ~15s max.
- Integration tests **self-skip** when `DATABASE_URL` unset.
- **Dependency policy:** only `pg` + `@types/pg` added — no migration lib, no ORM, no cron lib.
- Do not touch `src/http/`.
- Do not commit.
# Phase 2 — Docker Compose Deploy

## Goal
Containerize the LLM gateway and extend the existing Compose stack so `docker compose --profile app up -d` runs the full stack (postgres + redis + gateway) with zero manual setup. The containerized stack must support:
- PostgreSQL for accounting (`011_accounting.sql`) and spend budgets (`014_spend_budgets.sql`)
- Redis for rate limiting, budget reserve (Lua), and idempotency keys
- The gateway service itself, built from a new `Dockerfile`
- Migration execution via `npm run db:migrate`

## Codebase reality (verified — do not contradict)
- `docker-compose.yml` **already exists** — it defines `postgres:16-alpine` (host port **55432**, because a native Windows Postgres service owns 5432) and `redis:7-alpine` (host port 6379), project name `gateway`, named volumes `pgdata` / `redisdata`, healthchecks. It is what `npm run db:up` uses for integration tests. **Extend it — do NOT recreate, rewrite, or re-port it.**
- No `Dockerfile` exists anywhere in the repo — creating one is correct.
- `.env.example` **already exists** — extend it in place with missing vars only; do not clobber.
- `docker/` directory exists and is empty except `.gitkeep`.
- Health endpoint is **`/healthz`** (registered via `registerHealthz(app, deps.probes)` in `src/http/server.ts`), NOT `/health`.
- Port comes from `src/config/env.ts` → `DEFAULT_PORT = 8080`, overridable via `PORT`.
- package.json: `engines.node` = **`>=24.12.0 <25`**, `packageManager` = **npm@11.8.0** — the Dockerfile MUST use a Node 24 image, not Node 20.
- `npm run build` = `tsc -p tsconfig.build.json && node scripts/copy-assets.mjs`; copy-assets copies non-TS assets (`.lua` / `.sql` etc.) that `tsc` alone misses — e.g. `src/budget/reserve.lua`. If this is skipped, runtime breaks with ENOENT.

## Files to Create/Modify

### 1. `Dockerfile` (NEW — multi-stage, Node 24)
```dockerfile
# ---- Build stage ----
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
# Full install INCLUDING devDependencies — `npm run build` needs typescript/tsx/eslint deps.
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 8080

# Alpine has NO curl by default — probe with node fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
```
Notes:
- Do NOT `npm ci --omit=dev` before `npm run build` — tsc would be missing and the build fails.
- Do NOT copy `.env` into the image; use runtime env / compose `environment:`.

### 2. `docker-compose.yml` (EXTEND — keep the existing `postgres` and `redis` blocks exactly as committed; ADD a gateway service under an `app` profile)
Append to the existing file — do not rewrite it:

```yaml
  gateway:
    build: .
    profiles: ["app"]
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      # Container-to-container inside the compose network: INTERNAL 5432, NOT host 55432.
      - DATABASE_URL=postgresql://gateway:gateway@postgres:5432/gateway
      - REDIS_URL=redis://redis:6379
      - ADMIN_TOKEN=${ADMIN_TOKEN:-dummy-token}
      - PORT=${PORT:-8080}
      - LOG_LEVEL=${LOG_LEVEL:-info}
      - NODE_ENV=production
    ports:
      - "${PORT:-8080}:8080"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    restart: unless-stopped
```
Why a profile: `npm run db:up` currently brings up only pg + redis (integration tests need exactly those). Keeping `gateway` under the `app` profile preserves that workflow; `docker compose --profile app up -d --wait` brings up everything.

### 3. `.env.example` (extend IN PLACE — missing vars only)
Add these if absent:
```env
ADMIN_TOKEN=change-me-in-real-env
PORT=8080
LOG_LEVEL=info
NODE_ENV=development
# Host-facing URLs (running the gateway on the HOST against compose pg/redis):
DATABASE_URL=postgresql://gateway:gateway@127.0.0.1:55432/gateway
REDIS_URL=redis://127.0.0.1:6379
```
Do NOT commit a real `.env`.

### 4. `scripts/setup.mjs` — no change needed. It is idempotent (`.env.example` → `.env`). Keep as is.

### 5. Commit the new files
```bash
git add Dockerfile docker-compose.yml .env.example docs/phase-2-docker-compose-deploy.md
git commit -m "feat(phase-2): docker compose deploy (pg+redis+gateway)"
```

## Acceptance Criteria
1. `docker compose --profile app build` succeeds on this Windows/Docker Desktop host.
2. `docker compose --profile app up -d --wait` brings up postgres, redis and gateway — all healthy.
3. `npm run db:migrate` applies `0001_models.sql`, `011_accounting.sql`, `014_spend_budgets.sql` against `127.0.0.1:55432`.
4. `npm run verify` passes (typecheck + lint + format:check + tests).
5. `npm run test:int` passes (all integration tests).
6. `curl http://127.0.0.1:8080/healthz` returns 200.
7. `docker compose --profile app down` then `up -d --wait` — data persists in the `pgdata` / `redisdata` volumes.
8. The pre-existing postgres/redis behaviour is unchanged — `npm run db:up` must still bring up only pg + redis (gateway is behind the `app` profile).

## Verification Steps
1. **Build and run**:
```bash
docker compose --profile app build
docker compose --profile app up -d --wait
npm run db:migrate
npm run verify
npm run test:int
```
2. **Verify stack**:
```bash
curl http://127.0.0.1:8080/healthz
```
3. **Verify persistence**: `down` → `up -d --wait` → DB rows persist.

## Deviation Log
| Date | Deviation | Resolution |
|------|-----------|------------|
|      |           |            |

## Decision Log
| Date | Decision | Rationale |
|------|----------|-----------|
|      | gateway under `profiles: ["app"]` | Keeps `npm run db:up` (integration tests) unchanged |
|      | Host port 55432 | 5432 is owned by native Windows Postgres service |

## Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Dockerfile build fails (Windows/Docker Desktop quirks) | High | Pin `node:24-alpine`, no platform-specific shell, no curl dependency (node fetch) |
| Port conflict 5432 | Medium | Never use 5432 on host — 55432 only; in-compose uses internal 5432 |
| Build missing devDependencies | High | `npm ci` (full) in builder, `npm prune --omit=dev` at the END |
| Volume data loss | High | Named volumes `pgdata` / `redisdata` (existing compose) — do not rename |
| `.env` committed | High | Never commit `.env`; `.env.example` only |
| Copy-assets silent drop | Medium | Builder uses `npm run build` (build script already copies `.lua`/`.sql`) |

## Notes
- The gateway talks to compose services over the Docker network: `postgres:5432`, `redis:6379`. The HOST uses `127.0.0.1:55432`, `127.0.0.1:6379`. Mixing these breaks everything — keep both straight.
- No secrets in the image; all config via env.

## Notes for User
1. **Ready to hand to Antigravity** — use the prompt below.
2. **Post-deploy**: update `STATUS.md` (Phase B → 100%), then Phase D plan proceeds as-is.
3. **Not MVP yet** until `docker compose --profile app up -d --wait` is green and healthz returns 200 on this machine.

# Deploying Ultimate Free AI Endpoint

Two deployables:

| Piece | What it is | Where it runs |
| --- | --- | --- |
| Gateway (this repo root) | Fastify API, OpenAI-compatible `/v1` routes | Container from `Dockerfile` |
| Frontend (`frontend/`) | Next.js App Router, builds to static routes | Any static host or `next start` |

## 1. Priority order

1. **Secrets and origins** — `ADMIN_TOKEN`, `MASTER_ENCRYPTION_KEY`, `JWT_SECRET` (all 32+ chars), `CORS_ORIGIN`, `FRONTEND_URL`, `OAUTH_CALLBACK_BASE`, `MAIL_TRANSPORT`. Missing any of these either refuses to boot or silently breaks browser login.
2. **Database schema** — the app never migrates on boot. The `migrate` compose service runs `dist/db/migrate.js` once, before the gateway starts.
3. **Frontend API base** — `NEXT_PUBLIC_API_URL` is baked in at build time; set it before `npm run build`, not at runtime.
4. **TLS and ingress** — `docker/nginx.conf` in front of the gateway; terminate TLS at the edge (nginx, Caddy, or the platform load balancer).
5. **Provider keys** — `NVIDIA_NIM_KEYS` / `OPENROUTER_KEYS` / `TOKENHARBOR_KEYS` (comma-separated, pooled) or per-user keys stored encrypted through `/v1/user/keys`.

## 2. Generate secrets

```bash
openssl rand -hex 32   # ADMIN_TOKEN
openssl rand -hex 32   # MASTER_ENCRYPTION_KEY  (rotating this invalidates stored provider keys)
openssl rand -hex 32   # JWT_SECRET
```

Put them in `.env` next to `docker-compose.yml` (git-ignored). Never bake them into an image:
`.dockerignore` excludes `.env*`.

## 3. Bring up the stack

```bash
# Build the image (migrations are copied into it)
docker compose --profile app build

# Deploy: base file (dev-safe defaults) + production overlay (fails hard on missing secrets)
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --wait

# Verify
curl -fsS http://127.0.0.1:8080/healthz
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app ps
docker compose logs --tail=50 migrate gateway
```

`--wait` only returns once every container is healthy, and `gateway` will not start until `migrate`
has exited `0`. Deployment order is enforced by `depends_on` conditions, not by hand.

Local development keeps the short forms: `npm run db:up` (postgres + redis only) and
`npm run db:migrate`.

## 4. Frontend

```bash
cd frontend
NEXT_PUBLIC_API_URL=https://api.example.com/v1 npm run build
npm run start          # or upload the static output to your host
```

`NEXT_PUBLIC_API_URL` must include the `/v1` suffix. Because it is inlined at build time, changing
the API host requires a rebuild, not a restart. Leave it unset for the single-domain Vercel setup in
section 10: the client then calls same-origin `/v1`, which `vercel.json` proxies to the gateway.

## 5. OAuth provider consoles

Register these exact redirect URIs (`OAUTH_CALLBACK_BASE` = public API origin):

- `{OAUTH_CALLBACK_BASE}/v1/auth/oauth/google/callback`
- `{OAUTH_CALLBACK_BASE}/v1/auth/oauth/github/callback`

Leaving `GOOGLE_CLIENT_ID` / `GITHUB_CLIENT_ID` empty disables that provider; the login page only
offers providers that are configured. Email OTP signup still requires a working mail transport.

## 6. Mail

`NODE_ENV=production` refuses `MAIL_TRANSPORT=console`. Use `smtp` (`SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`) or `resend` (`RESEND_API_KEY`), and set `MAIL_FROM` to a
sender the provider has verified. `OTP_DEV_RETURN_CODE=false` in production — the API must never
echo a signup code.

## 7. Post-deploy checks

```bash
curl -fsS http://127.0.0.1:8080/healthz                     # 200
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://127.0.0.1:8080/v1/models | head -c 300           # registry non-empty
curl -s -o /dev/null -w '%{http_code}\n' \
     -H 'Origin: https://app.example.com' \
     http://127.0.0.1:8080/v1/models                        # 200, CORS header present
```

Then walk the real user flow: signup → OTP or OAuth → `/keys` → save a provider key → one chat
completion with a `gk_` gateway key.

## 8. Operational notes

- **Backups:** `pgdata` volume holds users, gateway keys and encrypted provider keys. Losing it
  means losing every stored provider key; `MASTER_ENCRYPTION_KEY` loss is equally fatal.
- **Scaling:** multiple gateway replicas are fine (shared Postgres + Redis), but the `migrate`
  service must run as a single instance.
- **Ports:** `db:up` publishes Postgres on `127.0.0.1:55432` and Redis on `127.0.0.1:6379` so a
  native Windows Postgres on 5432 does not collide. Both are bound to loopback only; do not widen
  them in production.
- **No reverse-proxy TLS here:** `nginx.conf` is plain HTTP on port 80 for a single host behind a
  TLS-terminating edge.

## 9. Known gaps before public launch

- No CI pipeline in this repo; `npm run verify` is the gate and must be run before every deploy.
- No automatic Postgres backup job.
- Load evidence is smoke-level (~208 requests against a mock upstream), not production traffic.
- Rate-limit and spend-cap behaviour under real multi-tenant traffic is unproven.

## 10. Vercel (multi-service project)

`vercel.json` at the repo root deploys both pieces as one project on one domain:

| Service | Root | Built from | Serves |
| --- | --- | --- | --- |
| `gateway` | `.` | `Dockerfile` (`runtime: container`) | `/v1`, `/v1/*`, `/healthz` |
| `frontend` | `frontend` | Next.js (`framework: nextjs`) | everything else |

Each service is internal by default; the top-level `rewrites` are the only public entry points, most
specific first. No service binding is declared: the frontend calls the gateway from the browser over
the shared domain, and bindings only reach server-side functions, never the client bundle.

Before the first deploy:

1. Link the project — `vercel link` then `vercel deploy`, or connect the Git repo in the dashboard.
2. Set the gateway variables in Project → Settings → Environment Variables (Production):
   `ADMIN_TOKEN`, `MASTER_ENCRYPTION_KEY`, `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, `PORT=8080`,
   `NODE_ENV=production`, `CORS_ORIGIN`, `FRONTEND_URL` and `OAUTH_CALLBACK_BASE` all set to the
   deployment origin, plus the mail settings from section 6 and any provider key pools.
3. **`PORT=8080` is required.** Vercel sends container traffic to port 80 unless the project sets
   `PORT`; the image listens on 8080 and cannot bind 80 as the non-root `node` user.
4. Host Postgres and Redis outside Vercel (Neon or Supabase, Upstash): container services have no
   persistent volume, so `pgdata` does not exist here. Run the schema once from your machine with
   `DATABASE_URL=<prod> npm run db:migrate` — the app never migrates on boot.
5. Leave `NEXT_PUBLIC_API_URL` unset so the browser uses same-origin `/v1`. Set it only when the API
   lives on a different domain, and remember it is baked in at build time.

Verify against the deployment domain:

```bash
curl -fsS https://<domain>/healthz                              # 200
curl -fsS -H "Authorization: Bearer ***" \
     https://<domain>/v1/models | head -c 300                   # registry non-empty
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/      # 200, Next.js HTML
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/login # 200
```

Unverified on this path: streaming chat completions (SSE) through the platform proxy, and container
cold-start latency after idle. Exercise one long streaming completion after the first deploy.

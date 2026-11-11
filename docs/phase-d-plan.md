# Phase D — Prove it and ship it (Blocks 16–18)

> **Source of truth:** `PROJECT.md` §329–350 (Blocks 16–18 spec), §99 Gates table, §382 load/ dir, §118–120 verification contract.
> **Gate:** load numbers match README claims (Block 16); streamed response end-to-end through Nginx (Block 17); stranger clone <5 min (Block 18).
> **Verifier:** `npm run verify`. Load test runs **against mock upstream only** — never real providers.

---

## Block 16 — Mock-upstream load test

### Learn (1.5h)
Artillery, reading p50/p95/p99, what each tells an interviewer.

### Goal
4 README numbers:
1. **Throughput multiplier vs a single key** (the headline).
2. **Client-visible 429 rate** (target: **0%**).
3. **p95 proxy overhead** (target: **<30 ms**).
4. **Failover success rate**.

### Files to Create/Modify
- `load/artillery.yml` — scenario, target `http://127.0.0.1:PORT`, phases (warm-up, ramp, sustain)
- `load/scenarios/gateway.yml` — POST /v1/chat/completions (buffered + streamed)
- `load/mock-upstream.ts` — configurable latency, 429/500 injection, per-credential RPM ceilings, slow-client mode
- `package.json` — add `npm run load`
- `load/report.md` — output of 4 numbers, checked into README

### Acceptance Criteria
```bash
npm run load
# → prints 4 numbers above; client-visible 429 = 0%
# → failover success rate printed
# → p95 proxy overhead <30ms
```

### Pitfall
**Never load-test real providers.** You will 429 in the first second — and if you don't, you pay for it.

### Deviation Log
- (none yet)

---

## Block 17 — Deploy: Docker + Nginx + Postgres + Redis

### Learn (1h)
`proxy_buffering off`, `proxy_read_timeout 300s`, `proxy_http_version 1.1`, `X-Accel-Buffering: no`.

### Goal
A **streamed** response works through Nginx end-to-end.

### Files to Create/Modify
- `docker/Dockerfile` — production image (multi-stage: build + runtime, non-root user)
- `docker/nginx.conf` — reverse proxy: `proxy_buffering off`, `proxy_read_timeout 300s`, `proxy_http_version 1.1`, `X-Accel-Buffering: no` header, TLS termination
- `docker-compose.yml` — add `app` + `nginx` services; existing `gateway-postgres-1` + `gateway-redis-1` stay
- `.env.example` — `NGINX_PORT`, `DATABASE_URL`, `REDIS_URL`, `ADMIN_TOKEN` stubs (no real values)

### Acceptance Criteria
```bash
docker compose up -d --wait && npm run smoke -- --stream
# → SSE chunks stream through Nginx, not buffered
# → X-Accel-Buffering: no present in response headers
```

### Pitfall
Default Nginx buffers responses and makes streaming look broken while the app is fine. Test the stream explicitly.

### Deviation Log
- (none yet)

---

## Block 18 — Docs, diagram, demo

### Goal
A stranger can clone, `docker compose up`, and get a streamed completion in **under 5 minutes**.

### Files to Create/Modify
- `README.md` — rewrite: architecture diagram, eval table, load-test numbers, quick-start (clone → compose up → stream), API examples
- `docs/architecture.md` — or link from README: SVG/diagram of gateway → router → ledger → breaker → provider adapter flow
- `docs/eval-table.md` — replay Block 12 eval output table
- `load/report.md` — 4 load-test numbers from Block 16
- Résumé bullets updated (Priyanshu_SDE_Intern_2026.pdf — **only with explicit approval**)

### Acceptance Criteria
```bash
npm run verify   # exit 0
# Stranger clone test (manual): fresh clone, docker compose up, streamed completion <5min
# README must include: 4 load numbers, eval table, architecture diagram, quick-start
```

### Deviation Log
- (none yet)

---

## Phase D Gate Summary

| Block | Verification Command | Status |
|-------|----------------------|--------|
| 16 | `npm run load` (4 numbers) | pending |
| 17 | `docker compose up -d --wait && npm run smoke -- --stream` | pending |
| 18 | `npm run verify` + manual clone test (<5 min) | pending |
| **Gate** | Load numbers match README claims | pending |

---

## Known Deviations from PROJECT.md (Decision Log)

| Block | PROJECT.md Spec | Actual Decision | Rationale | Date |
|-------|----------------|----------------|-----------|------|
| — | — | — | — | — |

*Add rows as decisions diverge. Keep concise; cite ADR if needed.*
# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** Block 19 — User registration & gateway API key (Phase E — User Identity)
- **Last green verify:** `npm run verify` -> exit 0, **381 hermetic tests**
- **Phase A (Aggregate): COMPLETE.** Blocks 1–10 merged to master at `7bdb247`.
- **Phase B (Survive 429): 100% COMPLETE.** Capacity gate passed + Docker Compose deploy (`d39e7f4`).
- **Phase C (Be good, not just available): COMPLETE.** Blocks 11–15 merged to master.
- **Phase D (Prove it): COMPLETE.** Block 16 (load test), Block 17 (Docker + Nginx), Block 18 (docs + demo). Merged to master.
- **Phase E (User Identity): IN PROGRESS.** Block 19 auth routes wired end-to-end (register/login/regenerate + user provider keys); Next.js login/keys flow verified in-browser; migration 038 repairs `user_provider_keys` (`label`, `active`).
- **Phase F (Provider Key Vault): PENDING.** Blocks 21–22.
- **Phase G (User-Aware Routing): PENDING.** Block 23.
- **Phase H (Frontend Dashboard): PENDING.** Block 24.

## Done

- Blocks 1–18 (Phases A–D) merged to master: telemetry, eval, route(), budget limiter, idempotency, load test, Docker + Nginx, README + docs.

## Next

- Block 19: user registration & gateway API key (Tasks 6+), then Blocks 20–24.

## Do not touch without a human

`PROJECT.md` structure, `.env` / `.env.local`, git history rewrites, `git push` (no remote).

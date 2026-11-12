# STATUS

> Handoff file. Read first, rewrite last. Keep under 25 lines.

- **Current block:** Block 18 complete (Docs, diagram, demo — stranger clone <5 min)
- **Last green verify:** `npm run verify` -> exit 0, **344 hermetic tests** (2.06s)
- **Phase A (Aggregate): COMPLETE.** Blocks 1–10 merged to master at `7bdb247`.
- **Phase B (Survive 429): 100% COMPLETE.** Capacity gate passed + Docker Compose deploy (`d39e7f4`).
- **Phase C (Be good, not just available): COMPLETE.** Blocks 11–15 merged to master.
- **Phase D (Prove it): COMPLETE.** Block 16 (load test), Block 17 (Docker + Nginx), Block 18 (docs + demo).

## Done

- Blocks 11–15: Phase C complete (telemetry, eval harness, route(), budget limiter, idempotency).
- Block 16: Mock upstream load test (Artillery, 4 metrics, report.md).
- Block 17: Production Dockerfile, Nginx streaming proxy, docker compose stack.
- Block 18: README rewrite (features, quick-start, Mermaid diagram, load numbers, eval table), docs/architecture.md extended, docs/eval-table.md, scripts/demo.sh.

## Next

- All 18 blocks complete. Merge `opencode/block-18-docs-demo` to master.

## Do not touch without a human

`PROJECT.md` structure, `.env` / `.env.local`, git history rewrites, `git push` (no remote).

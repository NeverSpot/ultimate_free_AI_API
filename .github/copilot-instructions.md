# LLM Gateway — Copilot instructions

Stack: Node 24, TypeScript (CommonJS, ES2022), Express, PostgreSQL 16, Redis, Docker.
One OpenAI-compatible endpoint in front of a pool of user-provided LLM provider keys.

## Commands

```
npm ci
npm run dev
npm run build && npm start
npm run verify
npm run test -- test/unit/foo.test.ts
npm run test -- --test-name-pattern "ledger race"
npm run db:up
```

## Invariants

- Rate limits are discovered at runtime; never hardcode RPM/RPD/TPM.
- Routing target is a `(model, credential)` pair, never a bare model.
- `select()` and `route()` are pure functions — no Redis, no `fetch`, no `Date.now()`.
- Every terminal path writes exactly one accounting row, in `finally`.
- Streaming failover only before the first token.

## Conventions

- Errors use `{"error":{"type","message","code"}}`, never raw strings.
- Validate at the boundary; internal code trusts typed values.
- No new production dependency without asking.

## Do not

- Edit `dist/`, `node_modules/`, or `package-lock.json`.
- Commit `.env`, `.env.local`, or any real key.
- Add a UI or dashboard.
- Run destructive git commands.

## Definition of done

`npm run verify` exits 0. Report its last lines as evidence.

Full context lives in `AGENTS.md` — read it before large changes.

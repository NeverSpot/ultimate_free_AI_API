# ADR-0002 — Fastify 5 as the HTTP layer

- **Status:** accepted
- **Date:** 2026-11-10
- **Supersedes:** the Express choice made implicitly in Block 2 of `PROJECT.md`

## Context

The gateway is a thin, high-concurrency proxy. Per request it does: parse a JSON body,
validate it, run a pure selection function, perform one Redis round-trip, one upstream
`fetch`, then serialise a response. There is almost no business logic on the hot path, so
the framework's overhead and its serialisation behaviour both matter directly to the p95
number this project is measured on.

## Decision

Use **Fastify 5**.

## Reasons

1. **Response serialisation is schema-driven and strips unknown fields.** Provider payloads
   are wider than the canonical response; Fastify dropping undeclared fields is a structural
   guarantee that a provider's internals never leak to a client. In Express this is manual
   whitelisting, which rots.
2. **`app.inject()` gives hermetic route tests.** No port binding, no race on startup, no
   network in unit tests — which is exactly the constraint the verify gate imposes.
3. **The lifecycle hooks are the terminal-path guarantee.** `onResponse` fires on success,
   error, timeout and abort, so the single-accounting-event invariant becomes structural
   rather than a `try/finally` someone can forget.
4. **pino logging is built in**, removing a dependency and giving structured JSON logs that
   an agent can grep.
5. Native JSON Schema validation at the boundary satisfies the "validate at the boundary"
   convention without a middleware stack.

## Alternatives rejected

- **Express 5** — no native schema validation or serialisation, no `inject()`, needs
  `express-async-errors`-class shims for rejected promises, and its middleware chain hides
  the request lifecycle from the type system.
- **Hono** — excellent on edge runtimes, but this deploys as a long-lived Node process and
  gains nothing here.
- **Bare `node:http`** — maximum control, zero help; would re-implement routing, validation
  and serialisation for no measurable gain at this scale.

## Consequences

- **Streaming (Block 10) requires `reply.hijack()`** and direct writes to `reply.raw`. After
  hijack, Fastify must never touch the response again — sending a Fastify error after
  hijacking corrupts the stream. This is the main new footgun and belongs in `AGENTS.md`.
- Every route needs a `response` schema, or fields silently disappear.
- Express middleware is not available. Nothing planned here needs it.

## What would force a revisit

Benchmarks showing Fastify's serialisation is the p95 bottleneck, or a requirement to run on
an edge runtime.

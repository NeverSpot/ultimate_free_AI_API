# ADR-0001 — Routing ranks capacity above quality

- **Status:** accepted
- **Date:** 2026-11-10

## Context

The gateway fronts free provider tiers that hard-cap per (credential, model, window) at
roughly 30 requests per minute. A request routed to an excellent model that has exhausted
its window fails with `429` and must be retried elsewhere, costing a wasted round-trip and
a user-visible failure if no other candidate exists.

## Decision

Rank candidates: **capacity -> task fit -> least-recently-used spread -> quality**.

## Alternatives rejected

- **Quality-first** — starves the moment the best model hits its ceiling, which for free
  tiers is the normal case, not the edge case.
- **Round-robin** — ignores per-model caps entirely; two models with different ceilings get
  equal shares and the smaller one exhausts first.
- **Hardcoded limits** — free-tier limits change monthly and differ per model. Any
  hardcoded number is wrong within weeks.

## Consequences

- The rate-limit ledger becomes the hottest path in the system and must be atomic.
- An eval harness is required to supply the task-fit score; without it, step two degrades
  to a static preference list.
- When every candidate is parked the system must fail fast with `503` + `retry-after`
  rather than queue.

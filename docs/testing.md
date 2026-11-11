# Testing

## Runner

`node:test` via `tsx`. Zero test framework dependency.

```
npm test                                  # everything (Node's default discovery)
npm run test -- test/unit/x.test.ts       # one file
npm run test -- --test-name-pattern "x"   # one test by name  <- works because no glob is pinned
npm run test:watch                        # watch mode

# The `test` script deliberately does NOT pin a glob. Pinning `"test/**/*.test.ts"`
# makes npm append `--test-name-pattern` AFTER the positional glob, where Node treats it
# inconsistently — a filter would silently execute 41 of 92 tests. Let Node discover.
```

Tests are hermetic: no network, no Docker, no real keys. Anything needing Postgres or
Redis belongs in `test/integration/` and runs behind `npm run db:up`.

## Layout

```
test/
  unit/          pure and adapter-level, hermetic, < 10s total
  integration/   needs postgres/redis, run explicitly
  fakes/         fake provider adapter, fake redis, fake clock
```

## Determinism

- Inject the clock. Never `sleep()` to test a rate-limit window; advance a fake clock.
- The mock adapter owns its own RPM ceiling so pooling is testable without the network.
- Print the seed on failure so a randomised run is replayable.

## Test naming

Name each test after the invariant it protects, not the function it calls.

```
test('ledger: 2 concurrent reservations against ceiling 1 -> exactly 1 succeeds')
test('breaker: OPEN makes zero network calls')
test('failover: 30% injected 429 -> 100% client success')
```

`test('ledger works')` tells an agent nothing about what broke.

## The four gate tests

| Gate | Proves | Where |
|---|---|---|
| Provider test | adding a provider is one file | `test/unit/providers` |
| Policy test | routing source is swappable | `test/unit/routing` |
| Failure test | one dead provider does not surface | `test/unit/failover` |
| Capacity test | the pool beats a single key | `test/unit/capacity` |

If a gate test cannot fail, it is not a gate test.

## What must never be mocked

The atomic reservation step. Mocking it hides the only bug the product can have.

## What must always be mocked

Network, clock, provider keys. A unit test that reaches a real provider is a broken
test, not an integration test.

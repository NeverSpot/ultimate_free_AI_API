# Block 9 — router: capacity-aware selection + failover ladder

Wire breaker + parking into the request path. Router order (PROJECT.md §3): **capacity -> task fit -> spread -> quality**.

## Files

- `src/routing/select.ts` — NEW. Pure function, no I/O:
  `select(candidates, ledgerSnapshot, evalTable, taskBucket) -> ranked {modelId, credentialId, score}[]`
  - capacity: ledgerSnapshot key `{credentialId}:{modelId}` → remaining > 0 first
  - task fit: evalTable[taskBucket][modelId] (0..1), higher first
  - spread: least-recently-used credential first (LRU timestamp on credential)
  - quality: evalTable quality score, tie-break only
- `src/core/execute.ts` — NEW. One loop:
  `execute(req, candidates, ledger, adapters, opts) -> CanonicalResponse`
  1. rank via select()
  2. for each candidate: `ledger.reserve(...)` → if `{ok:false}` try next
  3. `adapter.chat()` → on success `ledger.commit()` + return
  4. on `ProviderError`: classify → rate_limited = park credential; upstream/timeout = open breaker; client/auth/etc = abort
  5. maxAttempts + totalDeadlineMs caps
- `src/http/routes/chat-completions.ts` — EDIT. Replace direct provider call with `execute()`.
- `test/unit/select.test.ts` — NEW hermetic
- `test/unit/execute.test.ts` — NEW hermetic (fake adapters/ledger/clock)

## Tests must cover

- capacity beats task fit when one credential exhausted
- task fit wins among equal capacity
- LRU spread among equal capacity+fit
- failover: rate_limited on first → second succeeds
- failover: upstream on first → breaker opens → second succeeds
- all fail within deadline → error
- reserve fail → next candidate, zero network

## Acceptance

- `npm run verify` exit 0, hermetic count >= 206
- `npm run test:int` pass
- `npm run smoke` pass (3 providers)
- `git diff --name-only` only touches files listed above

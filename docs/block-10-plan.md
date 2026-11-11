# Block 10 — Streaming (SSE)

**Goal:** Implement `stream: true` for `/v1/chat/completions` with SSE wire format, **failover only before first token**, and proper backpressure handling.

## Files to Create/Modify

### 1. `src/core/execute.ts` — ADD streaming support
- New `executeStream()` function that returns `AsyncIterable<CanonicalResponseChunk>`
- Stream adapter interface: `adapter.stream(request, credential, signal)` → `AsyncIterable<CanonicalResponseChunk>`
- **Critical rule:** Failover **ONLY** before first chunk yielded. After first chunk → emit error event, do NOT retry.
- Each chunk: `{ choices: [{ delta: { content?: string }, finish_reason?: string, index: number }], usage?: {...} }`
- Handle `AbortSignal` from client disconnect

### 2. `src/providers/types.ts` — ADD streaming interface
```typescript
export interface ProviderAdapter {
  chat(request: CanonicalRequest, credential: Credential, signal?: AbortSignal): Promise<CanonicalResponse>;
  stream?(request: CanonicalRequest, credential: Credential, signal?: AbortSignal): AsyncIterable<CanonicalResponseChunk>;
}
```

### 3. `src/providers/mock.ts` — ADD mock streaming
- Implement `stream()` that yields chunks over time (simulate TTFT + token-by-token)
- Respect `signal` for cancellation
- Configurable chunk delay, total tokens

### 4. `src/http/routes/chat-completions.ts` — WIRE streaming
- Remove the `throw new ApiError('unsupported', 'stream: true...')` at line 81-83
- Branch on `canonical.stream`:
  - `false` → existing `routerRuntime.run()` path
  - `true` → new `routerRuntime.runStream()` path
- SSE response: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
- `res.flushHeaders()` before first chunk
- Write `data: <json>\n\n` for each chunk
- Write `data: [DONE]\n\n` at end
- Handle client disconnect (AbortSignal) → cancel upstream stream

### 5. `src/http/routes/router-runtime.ts` (NEW) — EXTRACT runtime logic
- Extract `RouterRuntime` class from `buildRouterRuntime()` in chat-completions.ts
- Add `runStream()` method alongside `run()`
- Both share: ledger, breaker, parking, adapterMap, policies, candidates, LRU, evalTable

### 6. Tests (hermetic)
- `test/unit/execute-stream.test.ts` — fake adapter, verify:
  - Chunks reassembled correctly across split TCP frames
  - Failover works **before** first chunk, NOT after
  - Client abort cancels upstream
  - Slow client doesn't grow RSS (backpressure)
  - `[DONE]` sent on completion

## Acceptance Criteria
```bash
npm run verify          # exit 0, format clean, 223+ tests
npm run test:int        # pass (if streaming integration test added)
# Manual: curl -N -H "stream: true" ... # shows SSE chunks
```

## Key Constraints (from PROJECT.md §239-244)
- **Failover only before first token** — cannot retry mid-stream (duplicates output)
- Terminal `error` event on mid-stream failure
- One JSON object can arrive split across two TCP chunks → accumulate until `\n\n`
- Backpressure: slow client must not grow RSS
- `AbortController` + `res.flushHeaders()` pattern


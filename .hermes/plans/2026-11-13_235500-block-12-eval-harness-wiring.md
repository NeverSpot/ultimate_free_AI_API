# Plan: Block 12 — Eval Harness Wired into Routing Task-Fit Scores

**Goal:** Make the eval harness write results to disk and feed real per-bucket model scores into `src/routing/select.ts`'s `EvalTable` so task-fit differentiation (currently always 0.5) actually influences model selection.

**Current context / assumptions:**
- Repo: `C:/Users/rishu/WebstormProjects/Ultimate_frre_ai`
- Branch: `agy/block-12-eval-harness` (cut from `master`)
- Master is at `09bf2df` with Blocks 0–24 merged. `npm run verify` exits 0, 344 tests pass.
- Backend: Node 24, TypeScript 5.5, CommonJS, Fastify 5, `node:test`, TypeBox, native `fetch`.
- `src/eval/grade.ts` and `src/eval/run.ts` are fully implemented and tested (`test/unit/eval.test.ts` passes).
- `src/eval/run.ts` `main()` (line 329) runs eval and `console.log(report.markdown)` but writes nothing to disk.
- `package.json` `"eval"` script: `node --import tsx src/eval/run.ts`.
- `src/routing/eval-store.ts` `EvalRoutingStore` parses `eval-results.json` / `eval-results.md` from disk into `RoutingStore` scores (flat + per-bucket).
- `src/routing/select.ts` `createDefaultEvalTable()` returns empty `Map` → all models get 0.5 task fit → task fit never differentiates models in `select()`.
- `src/core/execute.ts` (lines 198, 510) and `src/http/routes/chat-completions.ts` (line 95) default to `createDefaultEvalTable()` when no `evalTable` is provided.
- `src/routing/route.ts` `route()` applies `EvalRoutingStore` scores as overlay, but `select()`'s `EvalTable` (the primary task-fit signal) is never populated from eval output.
- `src/eval/prompts/` has 100 prompts (25 per bucket: json_extraction, math, code_generation, structured_extraction).
- No API keys, no secrets, no credentials in any file.
- Verification gate per task: `npm run test -- --test-name-pattern "<pattern>"` → exit 0.
- Final gate: `npm run eval` (writes results to disk) + `npm run verify` → exit 0.

**Architecture / proposed approach:**
- Extend `src/eval/run.ts` `main()` to write `eval-results.json` and `eval-results.md` to the repo root after computing the report (in addition to console output).
- Create `src/routing/eval-table-loader.ts`: `loadEvalTable()` — instantiates `EvalRoutingStore` (reads `eval-results.json` / `eval-results.md` from disk, falls back to `DEFAULT_EVAL_SCORES`), converts per-bucket scores into `EvalTable` format (`Map<TaskBucket, Map<string, number>>`).
- Wire `loadEvalTable()` into `src/http/routes/chat-completions.ts` (line 95) and `src/core/execute.ts` (lines 198, 510) as the default when no `deps.evalTable` is provided.
- Tasks follow TDD: write failing test → implement → verify pass → commit per task.

---

## Step-by-step tasks

### Task 12.1 — Make `main()` write eval results to disk

**Files:**
- `src/eval/run.ts` (MODIFY) — `main()` function (line 329)

**Code change in `main()`:**
After `console.log(report.markdown);` (line 361), add:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';

// ... inside main(), after console.log(report.markdown):

const resultsDir = process.cwd();
fs.writeFileSync(
  path.join(resultsDir, 'eval-results.json'),
  JSON.stringify(report, null, 2),
);
fs.writeFileSync(
  path.join(resultsDir, 'eval-results.md'),
  report.markdown,
);
if (!quiet) {
  console.log(`\nEval results written to eval-results.json and eval-results.md`);
}
```

And add `import * as fs from 'node:fs'; import * as path from 'node:path';` at the top of the file (line 1 area).

**Verification commands:**
1. `cd "C:/Users/rishu/WebstormProjects/Ultimate_frre_ai" && npx tsc --noEmit` → exit 0
2. `npm run eval` → exit 0, creates `eval-results.json` and `eval-results.md` in repo root, markdown contains "n=3 per cell" and bucket names
3. `cat eval-results.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['model'], d['overall']['passAt1'])"` → prints model name and pass rate

**Commit:** `git add src/eval/run.ts eval-results.json eval-results.md && git commit -m "feat(block-12): eval main writes results to disk"` → clean tree

---

### Task 12.2 — Create `src/routing/eval-table-loader.ts`

**Files:**
- `src/routing/eval-table-loader.ts` (CREATE)
- `test/unit/eval-table-loader.test.ts` (CREATE)

**Code — `src/routing/eval-table-loader.ts`:**
```typescript
import { EvalRoutingStore } from './eval-store';
import type { EvalTable, TaskBucket } from './select';

const BUCKET_NAMES: ReadonlyArray<TaskBucket> = [
  'json_extraction',
  'math',
  'code_generation',
  'structured_extraction',
];

/**
 * Load eval results from disk and convert to EvalTable format for select().
 * Reads eval-results.json / eval-results.md via EvalRoutingStore.
 * Falls back to DEFAULT_EVAL_SCORES if no results file exists.
 * Each TaskBucket gets the flat (overall) scores as its task-fit map.
 */
export function loadEvalTable(): EvalTable {
  const store = new EvalRoutingStore();
  const evalTable: EvalTable = new Map();

  for (const bucket of BUCKET_NAMES) {
    const bucketScores = store.getScoresSync(bucket);
    const modelMap = new Map<string, number>();
    for (const [modelId, score] of bucketScores.entries()) {
      modelMap.set(modelId, score);
    }
    evalTable.set(bucket, modelMap);
  }

  return evalTable;
}

export default { loadEvalTable };
```

**Code — `test/unit/eval-table-loader.test.ts`:**
```typescript
import { test, expect } from 'node:test';
import { loadEvalTable } from '../../src/routing/eval-table-loader';

test('loadEvalTable: returns EvalTable with all four buckets', (t) => {
  const table = loadEvalTable();
  assert.ok(table instanceof Map);
  assert.equal(table.size, 4);
  for (const b of ['json_extraction', 'math', 'code_generation', 'structured_extraction'] as const) {
    assert.ok(table.has(b), `Missing bucket: ${b}`);
    const m = table.get(b)!;
    assert.ok(m.size > 0, `Bucket ${b} has no model scores`);
    for (const [, score] of m.entries()) {
      assert.ok(score >= 0 && score <= 1, `Score out of range: ${score}`);
    }
  }
});

test('loadEvalTable: scores are deterministic across calls', (t) => {
  const a = loadEvalTable();
  const b = loadEvalTable();
  for (const bucket of a.keys()) {
    const ma = a.get(bucket)!;
    const mb = b.get(bucket)!;
    assert.deepEqual([...ma.entries()], [...mb.entries()]);
  }
});
```

**Verification commands:**
1. `npx tsc --noEmit` → exit 0
2. `npm run test -- --test-name-pattern "eval-table-loader"` → exit 0, output contains "ok"

**Commit:** `git add -A && git commit -m "feat(block-12): eval table loader for routing task-fit"` → clean tree

---

### Task 12.3 — Wire `loadEvalTable()` into `chat-completions.ts`

**Files:**
- `src/http/routes/chat-completions.ts` (MODIFY)

**Code change (line 95):**
Replace:
```typescript
const evalTable: EvalTable = deps.evalTable ?? createDefaultEvalTable();
```
With:
```typescript
import { loadEvalTable } from '../../routing/eval-table-loader';
// ...
const evalTable: EvalTable =
  deps.evalTable ??
  (deps.evalTable === undefined ? loadEvalTable() : createDefaultEvalTable());
```

Simpler replacement:
```typescript
const evalTable: EvalTable = deps.evalTable ?? loadEvalTable();
```

**Verification commands:**
1. `npx tsc --noEmit` → exit 0
2. `npm run test -- --test-name-pattern "chat-completions"` → exit 0
3. `npm run test -- --test-name-pattern "http"` → exit 0

**Commit:** `git add -A && git commit -m "feat(block-12): wire eval table into chat-completions"` → clean tree

---

### Task 12.4 — Wire `loadEvalTable()` into `execute.ts`

**Files:**
- `src/core/execute.ts` (MODIFY)

**Code changes:**
Line 198: Replace `evalTable = createDefaultEvalTable(),` with `evalTable = loadEvalTable(),`
Line 510: Same replacement in `executeStream`.

Add import at top of file:
```typescript
import { loadEvalTable } from '../routing/eval-table-loader';
```

**Verification commands:**
1. `npx tsc --noEmit` → exit 0
2. `npm run test -- --test-name-pattern "execute"` → exit 0
3. `npm run test -- --test-name-pattern "execute-stream"` → exit 0

**Commit:** `git add -A && git commit -m "feat(block-12): wire eval table into execute()"` → clean tree

---

### Task 12.5 — Verify end-to-end: `npm run eval` + `npm run verify`

**Files:** None (verification only)

**Verification commands:**
1. `npm run eval` → exit 0, writes `eval-results.json` and `eval-results.md`, console shows markdown table with `n=3 per cell`
2. `npm run verify` → exit 0 (typecheck + lint + format:check + test, 344+ tests)
3. `git status --porcelain` → clean (except `.hermes/` operational dir)

**Commit:** `git add -A && git commit -m "feat(block-12): verify pass after eval wiring"` → clean tree

---

## Tests / validation (TDD cycle per task)

For every code task:
1. **Write failing test first** — `npm run test -- --test-name-pattern "<task-name>"` → expected: exit 1, test fails
2. **Implement minimally** — exact code from task steps above
3. **Run test to verify pass** — `npm run test -- --test-name-pattern "<task-name>"` → expected: exit 0, output contains "ok"
4. **Commit** — `git add -A && git commit -m "feat(block-12): <description>"` → expected: clean working tree

Final gate:
- `npm run eval` → exit 0, writes `eval-results.json` + `eval-results.md`
- `npm run verify` → exit 0, 344 tests pass

## Risks, tradeoffs, and open questions

| Risk | Mitigation |
|------|-----------|
| `EvalRoutingStore` constructor reads disk synchronously — called on every request if used as default in `chat-completions.ts` | Cache the loaded `EvalTable` in a module-level variable after first load; add reload only on explicit request. Low risk: disk read is fast (~1ms). |
| `EvalRoutingStore.getScoresSync(bucket)` returns flat scores for unknown buckets (falls back to `flatScores`) — not truly per-bucket if markdown only has overall | Acceptable: flat scores are better than 0.5 defaults. Per-bucket scoring works when markdown has bucket columns. |
| `loadEvalTable()` uses `DEFAULT_EVAL_SCORES` when no results file exists — these are hardcoded model scores, not real eval output | Document that `npm run eval` must be run at least once to generate real scores. Default is a fallback, not a substitute. |
| `src/core/execute.ts` and `chat-completions.ts` both call `loadEvalTable()` independently — potential double disk read | Acceptable for now; module-level caching can be added in a follow-up block if profiling shows it matters. |
| `eval-results.json` / `eval-results.md` written to repo root — could be accidentally committed | Add to `.gitignore` or leave uncommitted (they're build artifacts). The routing store reads them at runtime from disk. |

**Open question:** Should `eval-results.json` be gitignored? It's a build artifact that gets regenerated on every `npm run eval`. Recommend adding `eval-results.*` to `.gitignore` in a follow-up.

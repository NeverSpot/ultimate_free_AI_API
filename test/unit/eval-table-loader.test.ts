import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { EvalTable, TaskBucket } from '../../src/routing/select';
import { loadEvalTable } from '../../src/routing/eval-table-loader';

const TASK_BUCKETS: ReadonlyArray<TaskBucket> = [
  'code',
  'reasoning',
  'creative',
  'analysis',
  'general',
] as const;

describe('eval-table-loader', () => {
  it('loadEvalTable returns an EvalTable with all five task buckets', () => {
    const table = loadEvalTable();
    assert.ok(table instanceof Map);
    assert.equal(table.size, 5);
    for (const bucket of TASK_BUCKETS) {
      assert.ok(table.has(bucket), `missing task bucket: ${bucket}`);
      const modelMap = table.get(bucket);
      assert.ok(modelMap, `task bucket ${bucket} is undefined`);
      assert.ok(modelMap!.size > 0, `task bucket ${bucket} has no model scores`);
      for (const score of modelMap!.values()) {
        assert.ok(
          Number.isFinite(score) && score >= 0 && score <= 1,
          `score out of [0,1]: ${score}`,
        );
      }
    }
  });

  it('loadEvalTable is deterministic across calls', () => {
    const first = loadEvalTable();
    const second = loadEvalTable();
    assert.deepEqual(first, second);
  });

  it('loadEvalTable returns an EvalTable typed as Map<TaskBucket, Map<string, number>>', () => {
    const table: EvalTable = loadEvalTable();
    assert.ok(table instanceof Map);
    assert.equal(table.size, 5);
  });
});

import { EvalRoutingStore } from './eval-store';
import type { EvalTable, TaskBucket } from './select';

/** Maps eval harness buckets onto the routing task buckets. */
const EVAL_BUCKET_TO_TASK_BUCKET: Record<string, TaskBucket> = {
  json_extraction: 'analysis',
  math: 'reasoning',
  code_generation: 'code',
  structured_extraction: 'analysis',
};

const TASK_BUCKETS: ReadonlyArray<TaskBucket> = [
  'code',
  'reasoning',
  'creative',
  'analysis',
  'general',
] as const;

function clampScore(score: number): number {
  if (!Number.isFinite(score) || score < 0) return 0;
  if (score > 1) return score / 100;
  return score;
}

/**
 * Load task-fit scores for routing from the persisted eval harness results.
 *
 * Instantiates EvalRoutingStore (which reads eval-results.json /
 * eval-results.md from disk, falling back to DEFAULT_EVAL_SCORES) and
 * converts per-bucket scores into an EvalTable keyed by routing TaskBucket.
 * Every TaskBucket receives the mapped bucket scores; buckets without a
 * mapped eval source fall back to the overall (flat) scores. Scores are
 * clamped to 0..1 so harness percentages never distort routing.
 */
export function loadEvalTable(): EvalTable {
  const store = new EvalRoutingStore();
  const evalTable: EvalTable = new Map<TaskBucket, Map<string, number>>();

  for (const taskBucket of TASK_BUCKETS) {
    const modelMap = new Map<string, number>();

    for (const [evalBucket, targetBucket] of Object.entries(EVAL_BUCKET_TO_TASK_BUCKET)) {
      if (targetBucket !== taskBucket) continue;
      const bucketScores = store.getScoresSync(evalBucket);
      for (const [modelId, score] of bucketScores.entries()) {
        modelMap.set(modelId, clampScore(score));
      }
    }

    if (modelMap.size === 0) {
      const flatScores = store.getScoresSync();
      for (const [modelId, score] of flatScores.entries()) {
        modelMap.set(modelId, clampScore(score));
      }
    }

    evalTable.set(taskBucket, modelMap);
  }

  return evalTable;
}

export default { loadEvalTable };

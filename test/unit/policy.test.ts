import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Credential } from '../../src/providers/types';
import { EvalRoutingStore } from '../../src/routing/eval-store';
import { JsonRoutingStore } from '../../src/routing/json-store';
import { route, routeAsync, type Candidate } from '../../src/routing/route';
import type { RoutingStore } from '../../src/routing/store';

function createCred(id: string, provider = 'mock'): Credential {
  const cred: Record<string, unknown> = { id, provider };
  Object.defineProperty(cred, 'secret', {
    value: `secret-for-${id}`,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return cred as unknown as Credential;
}

function makeCandidate(
  modelId: string,
  credentialId: string,
  providerId = 'mock',
  score?: number,
): Candidate {
  return {
    modelId,
    credential: createCred(credentialId, providerId),
    providerId,
    adapterId: providerId,
    ...(score !== undefined ? { score } : {}),
  };
}

test('policy gate: swapping RoutingStore (json-store vs eval-store) leaves route() untouched and produces identical ranked output', async () => {
  // Shared score profile for three models
  const scores = {
    'smart-model': 0.95,
    'balanced-model': 0.85,
    'fast-model': 0.7,
  };

  const jsonStore = new JsonRoutingStore(scores);
  const evalStore = new EvalRoutingStore(scores);

  const candidates: Candidate[] = [
    makeCandidate('fast-model', 'cred-1'),
    makeCandidate('smart-model', 'cred-2'),
    makeCandidate('balanced-model', 'cred-3'),
  ];

  // Route with json-store
  const routedJson = route(candidates, jsonStore);

  // Route with eval-store (route() function is completely untouched)
  const routedEval = route(candidates, evalStore);

  // Both stores produce the exact same ranked output
  assert.deepEqual(
    routedJson.map((c) => c.modelId),
    ['smart-model', 'balanced-model', 'fast-model'],
  );
  assert.deepEqual(
    routedEval.map((c) => c.modelId),
    ['smart-model', 'balanced-model', 'fast-model'],
  );
  assert.deepEqual(routedJson, routedEval);

  // Async route counterpart also yields identical results
  const routedJsonAsync = await routeAsync(candidates, jsonStore);
  const routedEvalAsync = await routeAsync(candidates, evalStore);
  assert.deepEqual(routedJsonAsync, routedEvalAsync);
});

test('policy gate: RoutingStore interface contract is fulfilled by both stores', async () => {
  const scores = { 'model-a': 0.9, 'model-b': 0.8 };
  const stores: RoutingStore[] = [new JsonRoutingStore(scores), new EvalRoutingStore(scores)];

  for (const store of stores) {
    const asyncScores = await store.getScores();
    assert.ok(asyncScores instanceof Map, 'getScores() must return Promise<Map>');
    assert.equal(asyncScores.get('model-a'), 0.9);
    assert.equal(asyncScores.get('model-b'), 0.8);

    assert.ok(typeof store.getScoresSync === 'function', 'getScoresSync() should be available');
    const syncScores = store.getScoresSync!();
    assert.ok(syncScores instanceof Map, 'getScoresSync() must return Map');
    assert.equal(syncScores.get('model-a'), 0.9);

    // Defensive copy check: mutating returned map must not corrupt store
    syncScores.set('model-a', 0.0);
    assert.equal(store.getScoresSync!().get('model-a'), 0.9);
  }
});

test('policy: stable tie-breaking preserves input order (Block 9 LRU/capacity order)', () => {
  const store = new JsonRoutingStore({
    'shared-model': 0.9,
  });

  const candidates: Candidate[] = [
    makeCandidate('shared-model', 'cred-early-lru'),
    makeCandidate('shared-model', 'cred-mid-lru'),
    makeCandidate('shared-model', 'cred-late-lru'),
  ];

  const routed = route(candidates, store);

  // When scores are identical, original LRU order must be preserved
  assert.deepEqual(
    routed.map((c) => c.credential.id),
    ['cred-early-lru', 'cred-mid-lru', 'cred-late-lru'],
  );
});

test('policy: unlisted models receive default score and route gracefully', () => {
  const store = new JsonRoutingStore({
    'known-high': 0.95,
  });

  const candidates: Candidate[] = [
    makeCandidate('unlisted-model-1', 'cred-1'),
    makeCandidate('known-high', 'cred-2'),
    makeCandidate('unlisted-model-2', 'cred-3'),
  ];

  const routed = route(candidates, store, { defaultScore: 0.5 });

  assert.equal(routed[0]?.modelId, 'known-high');
  // Both unlisted models have defaultScore 0.5, their original relative order is preserved
  assert.equal(routed[1]?.modelId, 'unlisted-model-1');
  assert.equal(routed[2]?.modelId, 'unlisted-model-2');
});

test('policy: pure function guarantees - no mutation and credential secret preserved', () => {
  const store = new JsonRoutingStore({
    'model-x': 0.9,
  });

  const originalCandidate = makeCandidate('model-x', 'cred-x');
  const candidates: Candidate[] = [originalCandidate];

  const routed = route(candidates, store);

  // Input array not mutated
  assert.notEqual(routed, candidates);
  assert.equal(candidates.length, 1);

  // Invariant 7: credential secrets are preserved (own non-enumerable property)
  assert.equal(routed[0]?.credential.secret, 'secret-for-cred-x');
  assert.equal(routed[0]?.credential, originalCandidate.credential);
});

test('policy: empty candidate list returns empty array', () => {
  const store = new JsonRoutingStore();
  assert.deepEqual(route([], store), []);
});

test('policy: json-store loads from real JSON file on disk', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'json-store-test-'));
  const filePath = join(tempDir, 'routing.json');
  try {
    writeFileSync(
      filePath,
      JSON.stringify({
        'file-model-1': 0.92,
        'file-model-2': 0.77,
      }),
      'utf8',
    );

    const store = new JsonRoutingStore(filePath);
    const candidates = [makeCandidate('file-model-2', 'c2'), makeCandidate('file-model-1', 'c1')];

    const routed = route(candidates, store);
    assert.deepEqual(
      routed.map((c) => c.modelId),
      ['file-model-1', 'file-model-2'],
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('policy: eval-store parses markdown eval report with n stated per cell', () => {
  const markdownOutput = `
| Model | JSON Extraction | Math | Code Generation | Pass@1 |
| --- | --- | --- | --- | --- |
| openrouter/anthropic/claude-3.5-sonnet | 0.98 (n=3) | 0.92 (n=3) | 0.96 (n=3) | 0.96 |
| nvidia/meta/llama-3.1-70b-instruct | 0.88 (n=3) | 0.82 (n=3) | 0.85 (n=3) | 0.85 |
| mock-model | 0.75 (n=3) | 0.70 (n=3) | 0.72 (n=3) | 0.72 |
`;

  const store = new EvalRoutingStore(markdownOutput);
  const candidates = [
    makeCandidate('mock-model', 'c1'),
    makeCandidate('nvidia/meta/llama-3.1-70b-instruct', 'c2'),
    makeCandidate('openrouter/anthropic/claude-3.5-sonnet', 'c3'),
  ];

  const routed = route(candidates, store);
  assert.deepEqual(
    routed.map((c) => c.modelId),
    ['openrouter/anthropic/claude-3.5-sonnet', 'nvidia/meta/llama-3.1-70b-instruct', 'mock-model'],
  );
});

test('policy: eval-store loads from real JSON eval report file on disk', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'eval-store-test-'));
  const filePath = join(tempDir, 'eval-results.json');
  try {
    writeFileSync(
      filePath,
      JSON.stringify({
        results: [
          { model: 'eval-model-low', score: 0.65 },
          { model: 'eval-model-high', score: 0.93 },
        ],
      }),
      'utf8',
    );

    const store = new EvalRoutingStore(filePath);
    const candidates = [
      makeCandidate('eval-model-low', 'c1'),
      makeCandidate('eval-model-high', 'c2'),
    ];

    const routed = route(candidates, store);
    assert.deepEqual(
      routed.map((c) => c.modelId),
      ['eval-model-high', 'eval-model-low'],
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

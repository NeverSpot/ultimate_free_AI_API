import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Credential } from '../../src/providers/types';
import {
  classifyTaskBucket,
  createDefaultEvalTable,
  reservationKey,
  select,
  type EvalTable,
  type LedgerSnapshot,
  type LruMap,
} from '../../src/routing/select';

function cred(id: string, provider = 'mock'): Credential {
  return { id, provider, secret: `secret-${id}` };
}

function candidate(modelId: string, credential: Credential, providerId = credential.provider) {
  return { modelId, credential, providerId, adapterId: providerId };
}

test('select: capacity beats task fit when one credential is exhausted', () => {
  const c1 = cred('cred-1', 'openrouter');
  const c2 = cred('cred-2', 'nvidia');

  const evalTable: EvalTable = createDefaultEvalTable();
  evalTable.set(
    'code',
    new Map([
      ['best-coder', 0.99],
      ['backup-model', 0.3],
    ]),
  );

  const snapshot: LedgerSnapshot = new Map([
    [reservationKey(c1.id, 'best-coder'), { remaining: 0, ttlMs: 30_000 }],
    [reservationKey(c2.id, 'backup-model'), { remaining: 5, ttlMs: 30_000 }],
  ]);

  const ranked = select([candidate('best-coder', c1), candidate('backup-model', c2)], snapshot, {
    evalTable,
    taskBucket: 'code',
    lru: new Map(),
  });

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.modelId, 'backup-model');
  assert.equal(ranked[0]?.credential.id, 'cred-2');
});

test('select: task fit wins among equal capacity', () => {
  const c1 = cred('cred-1');
  const c2 = cred('cred-2');
  const c3 = cred('cred-3');

  const evalTable: EvalTable = createDefaultEvalTable();
  evalTable.set(
    'code',
    new Map([
      ['model-low', 0.2],
      ['model-high', 0.95],
      ['model-mid', 0.7],
    ]),
  );

  const snapshot: LedgerSnapshot = new Map([
    [reservationKey(c1.id, 'model-low'), { remaining: 100, ttlMs: 60_000 }],
    [reservationKey(c2.id, 'model-high'), { remaining: 5, ttlMs: 60_000 }],
    [reservationKey(c3.id, 'model-mid'), { remaining: 50, ttlMs: 60_000 }],
  ]);

  const ranked = select(
    [candidate('model-low', c1), candidate('model-high', c2), candidate('model-mid', c3)],
    snapshot,
    { evalTable, taskBucket: 'code', lru: new Map() },
  );

  assert.deepEqual(
    ranked.map((r) => r.modelId),
    ['model-high', 'model-mid', 'model-low'],
  );
});

test('select: LRU spread wins among equal capacity and task fit', () => {
  const cRecent = cred('cred-recent');
  const cOld = cred('cred-old');
  const cNever = cred('cred-never');

  const evalTable: EvalTable = createDefaultEvalTable();
  evalTable.set('general', new Map([['shared-model', 0.8]]));

  const lru: LruMap = new Map([
    [cRecent.id, 2_000],
    [cOld.id, 1_000],
  ]);

  const ranked = select(
    [
      candidate('shared-model', cRecent),
      candidate('shared-model', cOld),
      candidate('shared-model', cNever),
    ],
    new Map(),
    { evalTable, taskBucket: 'general', lru },
  );

  assert.deepEqual(
    ranked.map((r) => r.credential.id),
    ['cred-never', 'cred-old', 'cred-recent'],
  );
});

test('select: quality tie-break wins when capacity, task fit, and LRU are equal', () => {
  const c1 = cred('cred-1');
  const c2 = cred('cred-2');

  const evalTable: EvalTable = createDefaultEvalTable();
  evalTable.set(
    'code',
    new Map([
      ['model-a', 0.8],
      ['model-b', 0.8],
    ]),
  );
  evalTable.set(
    'general',
    new Map([
      ['model-a', 0.4],
      ['model-b', 0.9],
    ]),
  );

  const lru: LruMap = new Map([
    [c1.id, 1_000],
    [c2.id, 1_000],
  ]);

  const ranked = select([candidate('model-a', c1), candidate('model-b', c2)], new Map(), {
    evalTable,
    taskBucket: 'code',
    lru,
  });

  assert.deepEqual(
    ranked.map((r) => r.modelId),
    ['model-b', 'model-a'],
  );
});

test('select: limit caps returned targets and 0 returns all', () => {
  const candidates = [
    candidate('m1', cred('c1')),
    candidate('m2', cred('c2')),
    candidate('m3', cred('c3')),
    candidate('m4', cred('c4')),
  ];

  const evalTable: EvalTable = createDefaultEvalTable();
  const limited = select(candidates, new Map(), {
    evalTable,
    taskBucket: 'general',
    lru: new Map(),
    limit: 2,
  });
  const all = select(candidates, new Map(), {
    evalTable,
    taskBucket: 'general',
    lru: new Map(),
    limit: 0,
  });

  assert.equal(limited.length, 2);
  assert.equal(all.length, 4);
});

test('select: pure function does not mutate candidates, snapshot, or lru', () => {
  const c1 = cred('c1');
  const c2 = cred('c2');
  const input = [candidate('m1', c1), candidate('m2', c2)];
  const snapshot: LedgerSnapshot = new Map([
    [reservationKey(c1.id, 'm1'), { remaining: 2, ttlMs: 1000 }],
  ]);
  const lru: LruMap = new Map([[c1.id, 500]]);

  select(input, snapshot, {
    evalTable: createDefaultEvalTable(),
    taskBucket: 'general',
    lru,
  });

  assert.equal(input[0]?.credential.id, 'c1');
  assert.equal(input[1]?.credential.id, 'c2');
  assert.equal(snapshot.size, 1);
  assert.equal(lru.size, 1);
});

test('classifyTaskBucket: classifies request content into expected buckets', () => {
  assert.equal(
    classifyTaskBucket({ messages: [{ role: 'user', content: 'Debug this TypeScript function' }] }),
    'code',
  );
  assert.equal(
    classifyTaskBucket({ messages: [{ role: 'user', content: 'Prove this logic theorem' }] }),
    'reasoning',
  );
  assert.equal(
    classifyTaskBucket({ messages: [{ role: 'user', content: 'Write a short poem about rain' }] }),
    'creative',
  );
  assert.equal(
    classifyTaskBucket({ messages: [{ role: 'user', content: 'Summarize these notes' }] }),
    'analysis',
  );
  assert.equal(
    classifyTaskBucket({ messages: [{ role: 'user', content: 'Hello there' }] }),
    'general',
  );
});

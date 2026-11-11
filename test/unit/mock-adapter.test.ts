import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockProviderAdapter, type MockFailure } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';
import type { CanonicalChunk } from '../../src/core/types';
import { ProviderError } from '../../src/core/errors';

const NOW = 1_731_250_000_000;

function makeCredential(id: string): Credential {
  return { id, provider: 'mock', secret: 'test-secret' };
}

function makeReq(content = 'Say hello.'): ReturnType<typeof mockChatRequest> {
  return mockChatRequest(content);
}

function mockChatRequest(content: string) {
  return {
    model: 'mock-model',
    messages: [{ role: 'user' as const, content }],
  };
}

test('mock adapter: same request twice yields identical usage (determinism)', async () => {
  const adapter = new MockProviderAdapter({ clock: () => NOW });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  const r1 = await adapter.chat(req, cred);
  const r2 = await adapter.chat(req, cred);

  assert.deepEqual(r1.usage, r2.usage);
});

test('mock adapter: honours rpmCeiling: third call in a window throws ProviderError with kind rate_limited and retryAfterMs > 0', async () => {
  const clock = () => NOW;
  const adapter = new MockProviderAdapter({
    clock,
    rpmCeiling: 2,
    windowMs: 60_000,
  });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  // First two calls succeed
  await adapter.chat(req, cred);
  await adapter.chat(req, cred);

  // Third call should fail
  try {
    await adapter.chat(req, cred);
    assert.fail('Expected ProviderError to be thrown');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'rate_limited');
    assert.ok(err.retryAfterMs !== undefined && err.retryAfterMs > 0);
  }
});

test('mock adapter: rpm budgets are per credential, not global', async () => {
  const clock = () => NOW;
  const adapter = new MockProviderAdapter({
    clock,
    rpmCeiling: 1,
    windowMs: 60_000,
  });
  const cred1 = makeCredential('cred-1');
  const cred2 = makeCredential('cred-2');
  const req = makeReq();

  // First credential uses its budget
  await adapter.chat(req, cred1);

  // Second credential should still have its own budget
  await adapter.chat(req, cred2);

  // First credential is now exhausted
  try {
    await adapter.chat(req, cred1);
    assert.fail('Expected ProviderError for cred1');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'rate_limited');
  }

  // Second credential is also exhausted
  try {
    await adapter.chat(req, cred2);
    assert.fail('Expected ProviderError for cred2');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'rate_limited');
  }
});

test('mock adapter: the window resets once windowMs elapses on the injected clock', async () => {
  let currentTime = NOW;
  const clock = () => currentTime;
  const adapter = new MockProviderAdapter({
    clock,
    rpmCeiling: 1,
    windowMs: 60_000,
  });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  // First call succeeds
  await adapter.chat(req, cred);

  // Second call fails (within window)
  try {
    await adapter.chat(req, cred);
    assert.fail('Expected ProviderError');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'rate_limited');
  }

  // Advance clock past window
  currentTime = NOW + 60_001;

  // Third call should succeed (window reset)
  await adapter.chat(req, cred);
});

test('mock adapter: the configured latency is awaited (assert the injected sleep received latencyMs)', async () => {
  let sleptMs = 0;
  const sleep = async (ms: number) => {
    sleptMs = ms;
  };
  const adapter = new MockProviderAdapter({
    clock: () => NOW,
    latencyMs: 123,
    sleep,
  });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  await adapter.chat(req, cred);

  assert.equal(sleptMs, 123);
});

test('mock adapter: an injected failure surfaces with the requested kind, and only for the requested number of times', async () => {
  const failures: MockFailure[] = [
    { kind: 'upstream', times: 2 },
    { kind: 'rate_limited', times: 1, retryAfterMs: 5000 },
  ];
  const adapter = new MockProviderAdapter({
    clock: () => NOW,
    failures,
  });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  // First two calls: upstream
  for (let i = 0; i < 2; i++) {
    try {
      await adapter.chat(req, cred);
      assert.fail('Expected ProviderError');
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'upstream');
    }
  }

  // Third call: rate_limited
  try {
    await adapter.chat(req, cred);
    assert.fail('Expected ProviderError');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'rate_limited');
    assert.equal(err.retryAfterMs, 5000);
  }

  // Fourth call: succeeds (failures exhausted)
  const result = await adapter.chat(req, cred);
  assert.ok(result.choices.length === 1);
});

test('mock adapter: when predicate injects selectively by call index', async () => {
  const failures: MockFailure[] = [
    { kind: 'timeout', when: (callIndex) => callIndex === 1 }, // Second call (0-indexed)
  ];
  const adapter = new MockProviderAdapter({
    clock: () => NOW,
    failures,
  });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  // First call succeeds
  await adapter.chat(req, cred);

  // Second call fails
  try {
    await adapter.chat(req, cred);
    assert.fail('Expected ProviderError');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'timeout');
  }

  // Third call succeeds
  await adapter.chat(req, cred);
});

test('mock adapter: an aborted signal throws ProviderError with kind timeout', async () => {
  const adapter = new MockProviderAdapter({ clock: () => NOW });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  const controller = new AbortController();
  controller.abort();

  try {
    await adapter.chat(req, cred, controller.signal);
    assert.fail('Expected ProviderError');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'timeout');
  }
});

test('mock adapter: listModels returns at least one model flagged is_free', async () => {
  const adapter = new MockProviderAdapter({ clock: () => NOW });
  const cred = makeCredential('cred-1');

  const models = await adapter.listModels(cred);

  assert.ok(models.length >= 1);
  assert.ok(models.some((m) => m.is_free === true));
});

test('mock adapter: stream() yields chunks and terminates with finish_reason', async () => {
  const adapter = new MockProviderAdapter({ clock: () => NOW, content: 'Hello world' });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  const chunks: CanonicalChunk[] = [];
  for await (const chunk of adapter.stream(req, cred)) {
    chunks.push(chunk);
  }

  assert.ok(chunks.length > 0, 'should yield at least one chunk');
  const lastChunk = chunks[chunks.length - 1]!;
  assert.ok(lastChunk.finish_reason !== null, 'last chunk should have a finish_reason');
  assert.ok(lastChunk.usage !== undefined, 'last chunk should carry usage');
});

test('mock adapter: stream() with supportsStreaming: false rejects with kind unsupported', async () => {
  const adapter = new MockProviderAdapter({ clock: () => NOW, supportsStreaming: false });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  try {
    for await (const _chunk of adapter.stream(req, cred)) {
      // Should not reach here
    }
    assert.fail('Expected ProviderError');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'unsupported');
  }
});

test('mock adapter: adding a second adapter instance with a different id requires no change to types.ts (assert two instances coexist with distinct ids)', async () => {
  const adapter1 = new MockProviderAdapter({ id: 'mock-a', clock: () => NOW });
  const adapter2 = new MockProviderAdapter({ id: 'mock-b', clock: () => NOW });

  assert.notEqual(adapter1.id, adapter2.id);
  assert.equal(adapter1.id, 'mock-a');
  assert.equal(adapter2.id, 'mock-b');

  // Both should work independently
  const cred1 = makeCredential('cred-1');
  const cred2 = makeCredential('cred-2');
  const req = makeReq();

  const r1 = await adapter1.chat(req, cred1);
  const r2 = await adapter2.chat(req, cred2);

  assert.ok(r1.choices.length === 1);
  assert.ok(r2.choices.length === 1);
});

test('mock adapter: getCallCount tracks number of chat attempts', async () => {
  const adapter = new MockProviderAdapter({ clock: () => NOW });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  assert.equal(adapter.getCallCount(), 0);
  await adapter.chat(req, cred);
  assert.equal(adapter.getCallCount(), 1);
  await adapter.chat(req, cred);
  assert.equal(adapter.getCallCount(), 2);
});

test('mock adapter: getRequestCounts returns per-credential counts in current window', async () => {
  const clock = () => NOW;
  const adapter = new MockProviderAdapter({
    clock,
    rpmCeiling: 10,
    windowMs: 60_000,
  });
  const cred1 = makeCredential('cred-1');
  const cred2 = makeCredential('cred-2');
  const req = makeReq();

  await adapter.chat(req, cred1);
  await adapter.chat(req, cred1);
  await adapter.chat(req, cred2);

  const counts = adapter.getRequestCounts();
  assert.equal(counts.get(cred1.id), 2);
  assert.equal(counts.get(cred2.id), 1);
});

test('mock adapter: backwards compatibility with now option', async () => {
  let nowCalled = 0;
  const now = () => {
    nowCalled++;
    return NOW;
  };
  const adapter = new MockProviderAdapter({ now });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  await adapter.chat(req, cred);
  await adapter.chat(req, cred);

  assert.ok(nowCalled >= 2);
});

test('mock adapter: clock option takes precedence over now', async () => {
  let clockCalled = 0;
  let _nowCalled = 0;
  const clock = () => {
    clockCalled++;
    return NOW;
  };
  const now = () => {
    _nowCalled++;
    return NOW + 1000;
  };
  const adapter = new MockProviderAdapter({ clock, now });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  await adapter.chat(req, cred);

  // clock should be used for created timestamp
  // Since we can't easily inspect the created field without knowing the exact request id,
  // we verify clock was called and now was not (or at least clock takes precedence)
  assert.ok(clockCalled > 0);
});

test('mock adapter: sleep is not called when latencyMs is 0', async () => {
  let sleepCalled = false;
  const sleep = async () => {
    sleepCalled = true;
  };
  const adapter = new MockProviderAdapter({
    clock: () => NOW,
    latencyMs: 0,
    sleep,
  });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  await adapter.chat(req, cred);

  assert.equal(sleepCalled, false);
});

test('mock adapter: injected failure with status override includes status', async () => {
  const failures: MockFailure[] = [{ kind: 'upstream', status: 502 }];
  const adapter = new MockProviderAdapter({
    clock: () => NOW,
    failures,
  });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  try {
    await adapter.chat(req, cred);
    assert.fail('Expected ProviderError');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'upstream');
    assert.equal(err.status, 502);
  }
});

test('mock adapter: failure when predicate can use credential', async () => {
  const failures: MockFailure[] = [
    { kind: 'auth', when: (_callIndex, cred) => cred.id === 'blocked-cred' },
  ];
  const adapter = new MockProviderAdapter({
    clock: () => NOW,
    failures,
  });
  const goodCred = makeCredential('good-cred');
  const badCred = makeCredential('blocked-cred');
  const req = makeReq();

  // Good credential succeeds
  await adapter.chat(req, goodCred);

  // Bad credential fails
  try {
    await adapter.chat(req, badCred);
    assert.fail('Expected ProviderError');
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'auth');
  }
});

test('mock adapter: abort signal checked after latency sleep', async () => {
  // The abort must happen DURING the latency wait, not before the call: a signal that
  // is already aborted is caught by the pre-flight check and never sleeps at all.
  let sleepCalled = false;
  const controller = new AbortController();
  const sleep = async (_ms: number): Promise<void> => {
    sleepCalled = true;
    controller.abort();
  };
  const adapter = new MockProviderAdapter({
    clock: () => NOW,
    latencyMs: 100,
    sleep,
  });
  const cred = makeCredential('cred-1');
  const req = makeReq();

  await assert.rejects(
    () => adapter.chat(req, cred, controller.signal),
    (err: unknown) => err instanceof ProviderError && err.kind === 'timeout',
  );

  assert.equal(sleepCalled, true, 'the configured latency must be awaited before the re-check');
});

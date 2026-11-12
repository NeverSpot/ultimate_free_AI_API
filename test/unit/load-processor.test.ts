import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import processor, {
  calculatePercentiles,
  printOverheadStats,
  sampleLogNormalLength,
  generateLogNormalString,
  setLogNormalPrompt,
  recordOverhead,
  resetOverheads,
  overheads,
  MOCK_LATENCY_MS,
} from '../../load/processor';

describe('artillery load processor', () => {
  beforeEach(() => {
    resetOverheads();
  });

  it('MOCK_LATENCY_MS is 60', () => {
    assert.equal(MOCK_LATENCY_MS, 60);
  });

  it('calculatePercentiles handles empty samples', () => {
    const res = calculatePercentiles([]);
    assert.equal(res.p50, 0);
    assert.equal(res.p95, 0);
    assert.equal(res.p99, 0);
    assert.equal(res.count, 0);
  });

  it('calculatePercentiles computes p50, p95, and p99 accurately', () => {
    // 100 samples from 1 to 100
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const res = calculatePercentiles(samples);
    assert.equal(res.count, 100);
    assert.equal(res.p50, 51);
    assert.equal(res.p95, 96);
    assert.equal(res.p99, 100);
  });

  it('sampleLogNormalLength returns integer bounded between min and max', () => {
    for (let i = 0; i < 50; i++) {
      const len = sampleLogNormalLength(100, 2000);
      assert.ok(Number.isInteger(len));
      assert.ok(len >= 100, `Expected >= 100, got ${len}`);
      assert.ok(len <= 2000, `Expected <= 2000, got ${len}`);
    }
  });

  it('sampleLogNormalLength safely handles degenerate bounds without NaN', () => {
    assert.equal(sampleLogNormalLength(0, 0), 1);
    assert.equal(sampleLogNormalLength(50, 50), 50);
    const negativeHandled = sampleLogNormalLength(-10, 20);
    assert.ok(Number.isInteger(negativeHandled));
    assert.ok(negativeHandled >= 1 && negativeHandled <= 20);
    assert.ok(!Number.isNaN(negativeHandled));
  });

  it('setLogNormalPrompt and recordOverhead safely operate when next callback is omitted', () => {
    assert.doesNotThrow(() => {
      setLogNormalPrompt(
        { json: { messages: [{ role: 'user', content: '' }] } },
        { vars: {} },
        null,
      );
    });
    assert.doesNotThrow(() => {
      recordOverhead({}, { timings: { phases: { total: 70 } } }, {}, null);
    });
  });

  it('generateLogNormalString produces a string with log-normal length', () => {
    const str = generateLogNormalString(100, 2000);
    assert.equal(typeof str, 'string');
    assert.ok(str.length >= 100);
    assert.ok(str.length <= 2000);
  });

  it('setLogNormalPrompt populates request body and context', (t, done) => {
    const requestParams = {
      json: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: '' }],
      },
    };
    const context = { vars: {} };

    setLogNormalPrompt(requestParams, context, null, (err) => {
      assert.equal(err, undefined);
      const content = requestParams.json.messages[0]?.content;
      assert.ok(content !== undefined && content.length >= 100);
      assert.equal((context.vars as Record<string, unknown>).prompt, content);
      done();
    });
  });

  it('recordOverhead subtracts 60ms mock latency from elapsed time', (t, done) => {
    const requestParams = {};
    const response = {
      timings: {
        phases: {
          total: 62.5, // 62.5ms response time
        },
      },
    };

    recordOverhead(requestParams, response, {}, null, (err) => {
      assert.equal(err, undefined);
      assert.equal(overheads.length, 1);
      assert.equal(overheads[0], 2.5); // 62.5 - 60 = 2.5ms overhead
      done();
    });
  });

  it('default processor registers request and done event handlers', () => {
    const ee = new EventEmitter();
    processor(ee);

    // Simulate 2 requests: 61ms and 65ms
    ee.emit('request', { responseTime: 61 });
    ee.emit('request', { responseTime: 65 });

    assert.equal(overheads.length, 2);
    assert.equal(overheads[0], 1); // 61 - 60
    assert.equal(overheads[1], 5); // 65 - 60

    // Emitting done prints stats without throwing
    ee.emit('done');

    const stats = printOverheadStats([10, 20, 30]);
    assert.equal(stats.count, 3);
    assert.equal(stats.p50, 20);
  });
});

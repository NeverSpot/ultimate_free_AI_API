import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  deepEqual,
  extractCode,
  extractJson,
  extractMathValue,
  grade,
  gradeCodeGeneration,
  gradeJsonExtraction,
  gradeMath,
  gradeStructuredExtraction,
  validateJsonSchema,
} from '../../src/eval/grade';
import {
  BUCKET_NAMES,
  formatMarkdownReport,
  loadPrompts,
  parseArgs,
  runEval,
} from '../../src/eval/run';

describe('eval harness: grade.ts', () => {
  describe('deepEqual', () => {
    it('compares primitives and nulls', () => {
      assert.equal(deepEqual(1, 1), true);
      assert.equal(deepEqual('a', 'a'), true);
      assert.equal(deepEqual(true, true), true);
      assert.equal(deepEqual(null, null), true);
      assert.equal(deepEqual(1, 2), false);
      assert.equal(deepEqual(null, {}), false);
    });

    it('compares arrays deeply', () => {
      assert.equal(deepEqual([1, [2, 3]], [1, [2, 3]]), true);
      assert.equal(deepEqual([1, 2], [1, 3]), false);
      assert.equal(deepEqual([1, 2], [1]), false);
    });

    it('compares objects deeply', () => {
      assert.equal(deepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }), true);
      assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
      assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
    });
  });

  describe('extractJson', () => {
    it('extracts raw JSON string', () => {
      const res = extractJson('{"name":"Alice","age":30}');
      assert.deepEqual(res, { name: 'Alice', age: 30 });
    });

    it('extracts JSON from markdown code fence', () => {
      const text = 'Here is the result:\n```json\n{"score": 98.5}\n```\nHope it helps!';
      const res = extractJson(text);
      assert.deepEqual(res, { score: 98.5 });
    });

    it('extracts outer JSON object when surrounded by conversational text', () => {
      const text =
        'Sure, the extracted record is {"id": "123", "valid": true}. Let me know if you need more.';
      const res = extractJson(text);
      assert.deepEqual(res, { id: '123', valid: true });
    });

    it('throws if no valid JSON can be extracted', () => {
      assert.throws(() => extractJson('This is purely plain text with no json.'));
    });
  });

  describe('validateJsonSchema', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 2 },
        age: { type: 'integer', minimum: 0 },
        tags: { type: 'array', items: { type: 'string' } },
        role: { enum: ['admin', 'user'] },
      },
      required: ['name', 'age'],
    };

    it('validates a compliant object', () => {
      const validData = { name: 'Bob', age: 25, tags: ['dev'], role: 'admin' };
      const res = validateJsonSchema(schema, validData);
      assert.equal(res.valid, true);
    });

    it('fails when a required property is missing', () => {
      const invalidData = { name: 'Bob' };
      const res = validateJsonSchema(schema, invalidData);
      assert.equal(res.valid, false);
      assert.match(res.error ?? '', /Missing required property: age/);
    });

    it('fails when type does not match', () => {
      const invalidData = { name: 'Bob', age: 'twenty-five' };
      const res = validateJsonSchema(schema, invalidData);
      assert.equal(res.valid, false);
      assert.match(res.error ?? '', /Expected integer/);
    });

    it('fails when enum does not match', () => {
      const invalidData = { name: 'Bob', age: 25, role: 'guest' };
      const res = validateJsonSchema(schema, invalidData);
      assert.equal(res.valid, false);
      assert.match(res.error ?? '', /not in enum list/);
    });
  });

  describe('gradeJsonExtraction', () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        year: { type: 'integer' },
      },
      required: ['title', 'year'],
    };

    it('passes valid JSON adhering to schema', () => {
      const output = '```json\n{"title": "Dune", "year": 1965}\n```';
      const res = gradeJsonExtraction(output, schema);
      assert.equal(res.passed, true);
      assert.equal(res.score, 1.0);
    });

    it('fails when output cannot be parsed as JSON', () => {
      const res = gradeJsonExtraction('Not valid JSON', schema);
      assert.equal(res.passed, false);
      assert.equal(res.score, 0.0);
      assert.match(res.error ?? '', /JSON parse error/);
    });

    it('fails when JSON does not satisfy schema', () => {
      const output = '{"title": "Dune"}';
      const res = gradeJsonExtraction(output, schema);
      assert.equal(res.passed, false);
      assert.equal(res.score, 0.0);
      assert.match(res.error ?? '', /Missing required property: year/);
    });
  });

  describe('extractMathValue & gradeMath', () => {
    it('extracts boxed and answer-prefixed numbers', () => {
      assert.equal(extractMathValue('\\boxed{42}').num, 42);
      assert.equal(extractMathValue('The answer is: 1081.').num, 1081);
      assert.equal(extractMathValue('Result = 3.1415').num, 3.1415);
      assert.equal(extractMathValue('1,024').num, 1024);
    });

    it('grades numeric exact match', () => {
      const pass = gradeMath('The answer is 715.', 715);
      assert.equal(pass.passed, true);
      assert.equal(pass.score, 1.0);

      const fail = gradeMath('The answer is 714.', 715);
      assert.equal(fail.passed, false);
      assert.equal(fail.score, 0.0);
    });

    it('grades string exact match', () => {
      const pass = gradeMath('3/4', '3/4');
      assert.equal(pass.passed, true);
      assert.equal(pass.score, 1.0);

      const fail = gradeMath('5/8', '3/4');
      assert.equal(fail.passed, false);
      assert.equal(fail.score, 0.0);
    });
  });

  describe('extractCode & gradeCodeGeneration', () => {
    it('extracts code from markdown block', () => {
      const fenced = '```javascript\nfunction add(a, b) { return a + b; }\n```';
      assert.equal(extractCode(fenced), 'function add(a, b) { return a + b; }');
    });

    it('passes when hidden test cases pass', () => {
      const code = 'function add(a, b) { return a + b; }';
      const testCases = [
        { input: [1, 2], expected: 3 },
        { input: [-3, 3], expected: 0 },
      ];
      const res = gradeCodeGeneration(code, 'add', testCases);
      assert.equal(res.passed, true);
      assert.equal(res.score, 1.0);
    });

    it('fails when a test case produces wrong output', () => {
      const code = 'function add(a, b) { return a - b; }';
      const testCases = [{ input: [1, 2], expected: 3 }];
      const res = gradeCodeGeneration(code, 'add', testCases);
      assert.equal(res.passed, false);
      assert.equal(res.score, 0.0);
      assert.match(res.error ?? '', /failed/);
    });

    it('fails when code throws a syntax or execution error', () => {
      const badCode = 'function add(a, b) { return a + ; }';
      const res = gradeCodeGeneration(badCode, 'add', []);
      assert.equal(res.passed, false);
      assert.equal(res.score, 0.0);
      assert.match(res.error ?? '', /error/i);
    });

    it('fails when entrypoint function is missing', () => {
      const code = 'function multiply(a, b) { return a * b; }';
      const res = gradeCodeGeneration(code, 'add', []);
      assert.equal(res.passed, false);
      assert.equal(res.score, 0.0);
      assert.match(res.error ?? '', /not a function/);
    });
  });

  describe('gradeStructuredExtraction', () => {
    const target = {
      vendor: 'CloudHost',
      invoice_id: 'INV-100',
      total: 320.5,
    };

    it('passes exact match from JSON', () => {
      const output = '{"vendor": "CloudHost", "invoice_id": "INV-100", "total": 320.5}';
      const res = gradeStructuredExtraction(output, target);
      assert.equal(res.passed, true);
      assert.equal(res.score, 1.0);
    });

    it('passes exact match from key: value lines', () => {
      const output = 'vendor: CloudHost\ninvoice_id: INV-100\ntotal: 320.5';
      const res = gradeStructuredExtraction(output, target);
      assert.equal(res.passed, true);
      assert.equal(res.score, 1.0);
    });

    it('computes partial F1 score when some fields match', () => {
      const output = '{"vendor": "CloudHost", "invoice_id": "WRONG-ID", "total": 320.5}';
      const res = gradeStructuredExtraction(output, target);
      assert.equal(res.passed, false);
      // 2 out of 3 matched: Precision = 2/3, Recall = 2/3, F1 = 2/3 = 0.6667
      assert.ok(res.score > 0.6 && res.score < 0.7);
    });
  });

  describe('grade universal dispatcher', () => {
    it('dispatches to json_extraction', () => {
      const res = grade(
        {
          id: 'test_1',
          bucket: 'json_extraction',
          prompt: 'test',
          referenceAnswer: '{"x": 1}',
          schema: { type: 'object', required: ['x'] },
        },
        '{"x": 1}',
      );
      assert.equal(res.passed, true);
    });

    it('dispatches to math', () => {
      const res = grade(
        {
          id: 'test_2',
          bucket: 'math',
          prompt: '2+2',
          referenceAnswer: '4',
          expected: 4,
        },
        '4',
      );
      assert.equal(res.passed, true);
    });
  });
});

describe('eval harness: run.ts', () => {
  it('loads exactly 100 prompts (25 per bucket)', () => {
    const prompts = loadPrompts();
    assert.equal(prompts.length, 100);

    const counts: Record<string, number> = {};
    for (const p of prompts) {
      counts[p.bucket] = (counts[p.bucket] ?? 0) + 1;
    }

    for (const b of BUCKET_NAMES) {
      assert.equal(counts[b], 25, `Expected 25 prompts in bucket "${b}"`);
    }
  });

  it('runs hermetic eval with MockProviderAdapter (n=3) and produces markdown with n=3 stated', async () => {
    const report = await runEval({ runsPerPrompt: 3 });

    assert.equal(report.runsPerPrompt, 3);
    assert.equal(report.overall.totalPrompts, 100);
    assert.equal(report.overall.totalRuns, 300);
    assert.equal(report.overall.totalPassed, 300);
    assert.equal(report.overall.passAt1, 1.0);

    // Assert markdown explicitly states n=3 per cell
    assert.match(report.markdown, /n=3 per cell/);
    assert.match(report.markdown, /100\.0% \(n=3\)/);
    assert.match(report.markdown, /json_extraction/);
    assert.match(report.markdown, /math/);
    assert.match(report.markdown, /code_generation/);
    assert.match(report.markdown, /structured_extraction/);
  });

  it('formatMarkdownReport outputs expected table headers and cell formatting', () => {
    const report = formatMarkdownReport({
      model: 'test-model',
      runsPerPrompt: 3,
      buckets: {
        json_extraction: {
          bucket: 'json_extraction',
          promptsCount: 25,
          runsPerPrompt: 3,
          totalRuns: 75,
          passedRuns: 75,
          passAt1: 1.0,
          avgScore: 1.0,
        },
        math: {
          bucket: 'math',
          promptsCount: 25,
          runsPerPrompt: 3,
          totalRuns: 75,
          passedRuns: 75,
          passAt1: 1.0,
          avgScore: 1.0,
        },
        code_generation: {
          bucket: 'code_generation',
          promptsCount: 25,
          runsPerPrompt: 3,
          totalRuns: 75,
          passedRuns: 75,
          passAt1: 1.0,
          avgScore: 1.0,
        },
        structured_extraction: {
          bucket: 'structured_extraction',
          promptsCount: 25,
          runsPerPrompt: 3,
          totalRuns: 75,
          passedRuns: 75,
          passAt1: 1.0,
          avgScore: 1.0,
        },
      },
      overall: {
        totalPrompts: 100,
        totalRuns: 300,
        totalPassed: 300,
        passAt1: 1.0,
        avgScore: 1.0,
      },
    });

    assert.ok(report.includes('| `json_extraction` | 25 | 75 | 75 | 100.0% (n=3) | 1.000 |'));
    assert.ok(
      report.includes(
        '| `test-model` | 100.0% (n=3) | 100.0% (n=3) | 100.0% (n=3) | 100.0% (n=3) | 100.0% (n=3) |',
      ),
    );
  });

  it('parses CLI arguments correctly', () => {
    const parsed = parseArgs(['--runs', '5', '--model', 'my-model', '--quiet']);
    assert.equal(parsed.runs, 5);
    assert.equal(parsed.model, 'my-model');
    assert.equal(parsed.quiet, true);
  });
});

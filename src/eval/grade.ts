import * as vm from 'node:vm';

export type BucketName = 'json_extraction' | 'math' | 'code_generation' | 'structured_extraction';

export interface BasePrompt {
  id: string;
  bucket: BucketName;
  prompt: string;
  referenceAnswer: string;
}

export interface JsonExtractionPrompt extends BasePrompt {
  bucket: 'json_extraction';
  schema: Record<string, unknown>;
}

export interface MathPrompt extends BasePrompt {
  bucket: 'math';
  expected: number | string;
}

export interface CodeGenerationPrompt extends BasePrompt {
  bucket: 'code_generation';
  entrypoint: string;
  testCases: Array<{
    input: unknown[];
    expected: unknown;
  }>;
}

export interface StructuredExtractionPrompt extends BasePrompt {
  bucket: 'structured_extraction';
  target: Record<string, unknown>;
}

export type EvalPrompt =
  JsonExtractionPrompt | MathPrompt | CodeGenerationPrompt | StructuredExtractionPrompt;

export interface GradeResult {
  passed: boolean;
  score: number;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * Deep equality check for primitives, arrays, and plain objects.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!deepEqual(objA[key], objB[key])) return false;
  }

  return true;
}

/**
 * Attempt to extract and parse JSON from an LLM response string.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Try parsing the whole string first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to fence/heuristic extraction
  }

  // Look for markdown code fence ```json ... ``` or ``` ... ```
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // Continue
    }
  }

  // Look for outer JSON object {...} or array [...]
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // Continue
    }
  }

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
    } catch {
      // Continue
    }
  }

  throw new Error('No valid JSON could be extracted from the output');
}

/**
 * Lightweight deterministic JSON Schema validator.
 */
export function validateJsonSchema(
  schema: Record<string, unknown>,
  data: unknown,
): { valid: boolean; error?: string } {
  const expectedType = schema['type'] as string | undefined;

  if (expectedType !== undefined) {
    if (expectedType === 'object') {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return { valid: false, error: `Expected object, got ${typeof data}` };
      }

      const required = schema['required'] as string[] | undefined;
      if (Array.isArray(required)) {
        for (const reqKey of required) {
          if (!Object.prototype.hasOwnProperty.call(data, reqKey)) {
            return { valid: false, error: `Missing required property: ${reqKey}` };
          }
          if ((data as Record<string, unknown>)[reqKey] === undefined) {
            return { valid: false, error: `Required property is undefined: ${reqKey}` };
          }
        }
      }

      const properties = schema['properties'] as
        Record<string, Record<string, unknown>> | undefined;
      if (properties !== undefined && typeof properties === 'object') {
        const obj = data as Record<string, unknown>;
        for (const [key, propSchema] of Object.entries(properties)) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const subResult = validateJsonSchema(propSchema, obj[key]);
            if (!subResult.valid) {
              return { valid: false, error: `Property "${key}": ${subResult.error}` };
            }
          }
        }
      }
    } else if (expectedType === 'array') {
      if (!Array.isArray(data)) {
        return { valid: false, error: `Expected array, got ${typeof data}` };
      }

      const itemsSchema = schema['items'] as Record<string, unknown> | undefined;
      if (itemsSchema !== undefined && typeof itemsSchema === 'object') {
        for (let i = 0; i < data.length; i++) {
          const subResult = validateJsonSchema(itemsSchema, data[i]);
          if (!subResult.valid) {
            return { valid: false, error: `Array item at index ${i}: ${subResult.error}` };
          }
        }
      }
    } else if (expectedType === 'string') {
      if (typeof data !== 'string') {
        return { valid: false, error: `Expected string, got ${typeof data}` };
      }
      const minLength = schema['minLength'] as number | undefined;
      if (minLength !== undefined && data.length < minLength) {
        return { valid: false, error: `String length ${data.length} < minLength ${minLength}` };
      }
      const maxLength = schema['maxLength'] as number | undefined;
      if (maxLength !== undefined && data.length > maxLength) {
        return { valid: false, error: `String length ${data.length} > maxLength ${maxLength}` };
      }
    } else if (expectedType === 'number') {
      if (typeof data !== 'number' || Number.isNaN(data)) {
        return { valid: false, error: `Expected number, got ${typeof data}` };
      }
      const minimum = schema['minimum'] as number | undefined;
      if (minimum !== undefined && data < minimum) {
        return { valid: false, error: `Number ${data} < minimum ${minimum}` };
      }
      const maximum = schema['maximum'] as number | undefined;
      if (maximum !== undefined && data > maximum) {
        return { valid: false, error: `Number ${data} > maximum ${maximum}` };
      }
    } else if (expectedType === 'integer') {
      if (typeof data !== 'number' || !Number.isInteger(data)) {
        return { valid: false, error: `Expected integer, got ${data}` };
      }
      const minimum = schema['minimum'] as number | undefined;
      if (minimum !== undefined && data < minimum) {
        return { valid: false, error: `Integer ${data} < minimum ${minimum}` };
      }
      const maximum = schema['maximum'] as number | undefined;
      if (maximum !== undefined && data > maximum) {
        return { valid: false, error: `Integer ${data} > maximum ${maximum}` };
      }
    } else if (expectedType === 'boolean') {
      if (typeof data !== 'boolean') {
        return { valid: false, error: `Expected boolean, got ${typeof data}` };
      }
    } else if (expectedType === 'null') {
      if (data !== null) {
        return { valid: false, error: `Expected null, got ${typeof data}` };
      }
    }
  }

  const enumValues = schema['enum'] as unknown[] | undefined;
  if (Array.isArray(enumValues)) {
    const matched = enumValues.some((v) => deepEqual(v, data));
    if (!matched) {
      return { valid: false, error: `Value ${JSON.stringify(data)} not in enum list` };
    }
  }

  return { valid: true };
}

/**
 * Grade json_extraction bucket.
 */
export function gradeJsonExtraction(output: string, schema: Record<string, unknown>): GradeResult {
  let parsed: unknown;
  try {
    parsed = extractJson(output);
  } catch (err) {
    return {
      passed: false,
      score: 0.0,
      error: `JSON parse error: ${(err as Error).message}`,
    };
  }

  const validation = validateJsonSchema(schema, parsed);
  if (!validation.valid) {
    return {
      passed: false,
      score: 0.0,
      error: validation.error,
      details: { parsed },
    };
  }

  return {
    passed: true,
    score: 1.0,
    details: { parsed },
  };
}

/**
 * Normalize and extract candidate answer for math.
 */
export function extractMathValue(text: string): { raw: string; num: number | null } {
  let cleaned = text.trim();

  // Check for LaTeX \boxed{...}
  const boxedMatch = /\\boxed\{([^}]+)\}/.exec(cleaned);
  if (boxedMatch?.[1]) {
    cleaned = boxedMatch[1].trim();
  }

  // Remove trailing period or semicolon
  cleaned = cleaned.replace(/[.;]+$/, '').trim();

  // If answer format contains "answer is X" or "result is X" or "X"
  const answerMatch = /(?:the\s+)?(?:answer|result|value)\s*(?:is|=|:)\s*([^\n]+)/i.exec(cleaned);
  if (answerMatch?.[1]) {
    cleaned = answerMatch[1].trim().replace(/[.;]+$/, '');
  }

  // Remove commas in numbers like 1,000 -> 1000
  const normalizedStr = cleaned.replace(/,/g, '');

  // Try extracting number
  const numMatch = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(normalizedStr);
  const num = numMatch ? Number(numMatch[0]) : null;

  return { raw: cleaned, num };
}

/**
 * Grade math bucket: exact match (numeric / normalized string).
 */
export function gradeMath(output: string, expected: number | string): GradeResult {
  const extracted = extractMathValue(output);

  if (typeof expected === 'number') {
    if (extracted.num !== null && !Number.isNaN(extracted.num)) {
      const epsilon = 1e-4;
      const diff = Math.abs(extracted.num - expected);
      if (diff <= epsilon || (expected !== 0 && diff / Math.abs(expected) <= epsilon)) {
        return {
          passed: true,
          score: 1.0,
          details: { actual: extracted.num, expected },
        };
      }
    }

    return {
      passed: false,
      score: 0.0,
      error: `Expected numeric match ${expected}, got ${extracted.num ?? extracted.raw}`,
      details: { actual: extracted.num ?? extracted.raw, expected },
    };
  }

  // String expected
  const normalizedExpected = String(expected).trim().toLowerCase();
  const normalizedActual = extracted.raw.trim().toLowerCase();

  if (normalizedActual === normalizedExpected) {
    return {
      passed: true,
      score: 1.0,
      details: { actual: extracted.raw, expected },
    };
  }

  return {
    passed: false,
    score: 0.0,
    error: `Expected string match "${expected}", got "${extracted.raw}"`,
    details: { actual: extracted.raw, expected },
  };
}

/**
 * Extract code from markdown fences or raw string.
 */
export function extractCode(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /```(?:javascript|js|typescript|ts)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/**
 * Grade code_generation bucket: hidden unit tests, pass@1.
 */
export function gradeCodeGeneration(
  output: string,
  entrypoint: string,
  testCases: Array<{ input: unknown[]; expected: unknown }>,
): GradeResult {
  const code = extractCode(output);

  // Setup sandboxed VM context
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
  };

  const context = vm.createContext(sandbox);

  try {
    const script = new vm.Script(code);
    script.runInContext(context, { timeout: 1000 });
  } catch (err) {
    return {
      passed: false,
      score: 0.0,
      error: `Code execution / compilation error: ${(err as Error).message}`,
    };
  }

  const fn = (context as Record<string, unknown>)[entrypoint];
  if (typeof fn !== 'function') {
    return {
      passed: false,
      score: 0.0,
      error: `Entrypoint "${entrypoint}" is not a function or was not defined`,
    };
  }

  // Run test cases
  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    if (!tc) continue;

    try {
      // Deep clone inputs to prevent test mutation
      const clonedInputs = JSON.parse(JSON.stringify(tc.input));
      const actual = (fn as (...args: unknown[]) => unknown)(...clonedInputs);

      if (!deepEqual(actual, tc.expected)) {
        return {
          passed: false,
          score: 0.0,
          error: `Test case ${i + 1} failed: input ${JSON.stringify(tc.input)}, expected ${JSON.stringify(tc.expected)}, got ${JSON.stringify(actual)}`,
          details: { testCaseIndex: i, input: tc.input, expected: tc.expected, actual },
        };
      }
    } catch (err) {
      return {
        passed: false,
        score: 0.0,
        error: `Test case ${i + 1} threw an exception: ${(err as Error).message}`,
        details: { testCaseIndex: i, input: tc.input, expected: tc.expected },
      };
    }
  }

  return {
    passed: true,
    score: 1.0,
    details: { testCasesPassed: testCases.length },
  };
}

/**
 * Grade structured_extraction bucket: field-level exact match / F1.
 */
export function gradeStructuredExtraction(
  output: string,
  target: Record<string, unknown>,
): GradeResult {
  let extracted: Record<string, unknown> = {};

  try {
    const jsonParsed = extractJson(output);
    if (typeof jsonParsed === 'object' && jsonParsed !== null && !Array.isArray(jsonParsed)) {
      extracted = jsonParsed as Record<string, unknown>;
    }
  } catch {
    // If not JSON, try key-value lines
    const lines = output.split('\n');
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line
          .slice(0, colonIdx)
          .trim()
          .replace(/^[-*]\s*/, '')
          .replace(/["']/g, '');
        const val = line
          .slice(colonIdx + 1)
          .trim()
          .replace(/["']/g, '');
        if (key && val) {
          extracted[key] = val;
        }
      }
    }
  }

  const targetKeys = Object.keys(target);
  const extractedKeys = Object.keys(extracted);

  if (targetKeys.length === 0) {
    return { passed: true, score: 1.0 };
  }

  let truePositives = 0;

  for (const key of targetKeys) {
    if (Object.prototype.hasOwnProperty.call(extracted, key)) {
      const expVal = target[key];
      const actVal = extracted[key];

      // Compare normalized values
      if (deepEqual(expVal, actVal)) {
        truePositives++;
      } else if (
        typeof expVal === 'string' &&
        typeof actVal === 'string' &&
        expVal.trim().toLowerCase() === actVal.trim().toLowerCase()
      ) {
        truePositives++;
      } else if (
        typeof expVal === 'number' &&
        (typeof actVal === 'number' || typeof actVal === 'string') &&
        Number(actVal) === expVal
      ) {
        truePositives++;
      }
    }
  }

  const precision = extractedKeys.length > 0 ? truePositives / extractedKeys.length : 0;
  const recall = truePositives / targetKeys.length;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const exactMatch =
    truePositives === targetKeys.length && extractedKeys.length === targetKeys.length;

  const passed = exactMatch || f1 >= 0.999;
  const score = Number(f1.toFixed(4));

  return {
    passed,
    score,
    details: {
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1: score,
      exactMatch,
      matchedFields: truePositives,
      targetFields: targetKeys.length,
      extractedFields: extractedKeys.length,
    },
  };
}

/**
 * Universal deterministic grade dispatcher.
 */
export function grade(prompt: EvalPrompt, output: string): GradeResult {
  switch (prompt.bucket) {
    case 'json_extraction':
      return gradeJsonExtraction(output, prompt.schema);
    case 'math':
      return gradeMath(output, prompt.expected);
    case 'code_generation':
      return gradeCodeGeneration(output, prompt.entrypoint, prompt.testCases);
    case 'structured_extraction':
      return gradeStructuredExtraction(output, prompt.target);
    default:
      return {
        passed: false,
        score: 0.0,
        error: `Unknown bucket: ${(prompt as BasePrompt).bucket}`,
      };
  }
}

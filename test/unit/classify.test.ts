import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../src/core/errors';
import {
  ERROR_PROFILES,
  classifyStatus,
  isRateLimitBody,
  parseErrorBody,
  parseRetryAfterMs,
  rateLimitVerdict,
  type ParsedError,
} from '../../src/resilience/classify';

const NOW = 1_731_250_000_000;

function parseJson(status: number, body: unknown): ParsedError {
  return parseErrorBody(status, JSON.stringify(body));
}

function classify(
  status: number,
  body: unknown,
  options: { provider?: string; now?: number; headers?: Headers | Record<string, string> } = {},
): ProviderError {
  return classifyStatus(status, parseJson(status, body), options.headers, {
    provider: options.provider,
    now: options.now ?? NOW,
  });
}

test('classify: NVIDIA plain-text 404 parses without throwing and maps to model_gone', () => {
  const parsed = parseErrorBody(404, '404 page not found');
  assert.equal(parsed.json, false);
  assert.equal(parsed.message, undefined);
  assert.equal(parsed.text, '404 page not found');

  const err = classifyStatus(404, parsed, undefined, {
    provider: 'nvidia',
    profile: ERROR_PROFILES['nvidia'],
  });
  assert.ok(err instanceof ProviderError);
  assert.equal(err.kind, 'model_gone');
  assert.equal(err.status, 404);
  assert.equal(err.provider, 'nvidia');
  assert.equal(err.message, 'HTTP 404');
});

test('classify: an empty body falls back to the HTTP status line', () => {
  const parsed = parseErrorBody(404, '   ');
  assert.equal(parsed.json, false);
  assert.equal(parsed.text, '');

  const err = classifyStatus(404, parsed, undefined, { provider: 'generic' });
  assert.equal(err.kind, 'model_gone');
  assert.equal(err.message, 'HTTP 404');
});

test('classify: an HTML body never leaks markup into the message', () => {
  const parsed = parseErrorBody(500, '<html><body>Internal Server Error</body></html>');
  assert.equal(parsed.json, false);
  assert.equal(parsed.message, undefined);

  const err = classifyStatus(500, parsed, undefined, { provider: 'generic' });
  assert.equal(err.kind, 'upstream');
  assert.equal(err.message, 'HTTP 500');
  assert.ok(!err.message.includes('<'));
});

test('classify: non-JSON text is truncated to 500 characters', () => {
  const parsed = parseErrorBody(502, 'x'.repeat(700));
  assert.equal(parsed.json, false);
  assert.equal(parsed.text.length, 500);
  assert.equal(parsed.message, undefined);
});

test('classify: a flat NVIDIA envelope takes detail as the message', () => {
  const parsed = parseJson(401, {
    status: 401,
    title: 'Unauthorized',
    detail: 'Invalid JWT serialization: Missing dot delimiter(s)',
  });
  assert.equal(parsed.json, true);
  assert.equal(parsed.message, 'Invalid JWT serialization: Missing dot delimiter(s)');
  assert.equal(parsed.type, undefined);
  assert.equal(parsed.code, undefined);
});

test('classify: a nested OpenAI envelope preserves string code and type', () => {
  const parsed = parseJson(401, {
    error: {
      message: 'No valid API key found.',
      type: 'invalid_api_key',
      param: null,
      code: 'invalid_api_key',
    },
  });
  assert.equal(parsed.message, 'No valid API key found.');
  assert.equal(parsed.type, 'invalid_api_key');
  assert.equal(parsed.code, 'invalid_api_key');
});

test('classify: JSON that is not an object carries no message', () => {
  const scalar = parseErrorBody(400, '"boom"');
  assert.equal(scalar.json, true);
  assert.equal(scalar.message, undefined);

  const array = parseErrorBody(400, '[]');
  assert.equal(array.json, true);
  assert.equal(array.message, undefined);
});

test('classify: Token Harbor free-allowance 429 is exhausted, not rate_limited, and drops Retry-After', () => {
  const err = classify(
    429,
    { error: { type: 'free_tier_limit_reached' } },
    { provider: 'tokenharbor', headers: { 'Retry-After': '3600' } },
  );
  assert.ok(err instanceof ProviderError);
  assert.equal(err.kind, 'exhausted');
  assert.equal(err.retryAfterMs, undefined);
  assert.equal(err.provider, 'tokenharbor');
});

test('classify: an ordinary 429 carries the Retry-After delay in milliseconds', () => {
  const err = classify(
    429,
    { error: { message: 'Rate limit exceeded', type: 'rate_limit_exceeded' } },
    { provider: 'tokenharbor', headers: { 'Retry-After': '30' } },
  );
  assert.equal(err.kind, 'rate_limited');
  assert.equal(err.retryAfterMs, 30_000);
});

test('classify: a Retry-After HTTP-date is measured against the injected clock', () => {
  const now = Date.parse('2015-10-21T07:27:30Z');
  const err = classify(
    429,
    { error: { message: 'Slow down', type: 'rate_limit_error' } },
    { now, headers: { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' } },
  );
  assert.equal(err.kind, 'rate_limited');
  assert.equal(err.retryAfterMs, 30_000);
});

test('classify: OpenRouter "is not a valid model ID" 400 is model_gone', () => {
  const err = classify(
    400,
    { error: { message: 'nope/not-a-model is not a valid model ID', code: 400 } },
    { provider: 'openrouter' },
  );
  assert.equal(err.kind, 'model_gone');
});

test('classify: an OpenRouter malformed-body 400 stays client', () => {
  const err = classify(
    400,
    {
      error: {
        message: 'request body is not valid JSON',
        type: 'invalid_request_error',
        code: 'invalid_json',
      },
    },
    { provider: 'openrouter' },
  );
  assert.equal(err.kind, 'client');
});

test('classify: OpenRouter structural guards reject a versioned or string-coded model-id error', () => {
  const typed = classify(
    400,
    {
      error: {
        message: 'nope/not-a-model is not a valid model ID',
        type: 'invalid_request_error',
        code: 400,
      },
    },
    { provider: 'openrouter' },
  );
  assert.equal(typed.kind, 'client');

  const stringCode = classify(
    400,
    { error: { message: 'nope/not-a-model is not a valid model ID', code: 'invalid_model' } },
    { provider: 'openrouter' },
  );
  assert.equal(stringCode.kind, 'client');
});

test('classify: OpenRouter numeric error.code 429 and 503 classify by status', () => {
  const throttled = classify(
    429,
    { error: { message: 'Rate limit exceeded', code: 429 } },
    { provider: 'openrouter', headers: { 'Retry-After': '30' } },
  );
  assert.equal(throttled.kind, 'rate_limited');
  assert.equal(throttled.retryAfterMs, 30_000);

  const overloaded = classify(
    503,
    { error: { message: 'Overloaded', code: 503 } },
    { provider: 'openrouter' },
  );
  assert.equal(overloaded.kind, 'upstream');
});

test('classify: status families map to upstream, timeout and auth', () => {
  for (const status of [500, 503, 529]) {
    assert.equal(classify(status, { error: { message: 'boom' } }).kind, 'upstream');
  }
  for (const status of [408, 504]) {
    assert.equal(classify(status, { error: { message: 'slow' } }).kind, 'timeout');
  }
  for (const status of [401, 403]) {
    assert.equal(classify(status, { error: { message: 'nope' } }).kind, 'auth');
  }
});

test('classify: context-length and content-policy body signals beat the status', () => {
  assert.equal(
    classify(400, { error: { code: 'context_length_exceeded', message: 'too big' } }).kind,
    'too_long',
  );
  assert.equal(
    classify(500, { error: { message: "This model's maximum context length is 8192 tokens" } })
      .kind,
    'too_long',
  );
  assert.equal(
    classify(200, { error: { type: 'content_filter', message: 'blocked' } }).kind,
    'blocked',
  );
  assert.equal(
    classify(400, { error: { message: 'this violates the content policy' } }).kind,
    'blocked',
  );
});

test('classify: 422 is client unless the profile recognises an unknown model', () => {
  assert.equal(
    classify(422, { error: { message: 'unprocessable' } }, { provider: 'openrouter' }).kind,
    'client',
  );
  assert.equal(
    classify(
      422,
      { error: { message: 'nope/not-a-model is not a valid model ID', code: 422 } },
      { provider: 'openrouter' },
    ).kind,
    'model_gone',
  );
});

test('classify: isRateLimitBody recognises throttling and allowance, not client errors', () => {
  const throttle = parseJson(429, {
    error: { message: 'Rate limit exceeded', type: 'rate_limit_exceeded' },
  });
  const allowance = parseJson(429, { error: { type: 'free_tier_limit_reached' } });
  const tooMany = parseJson(400, { error: { message: 'Too many requests' } });
  const client = parseJson(400, {
    error: { type: 'invalid_request_error', code: 'invalid_request_error' },
  });

  assert.equal(isRateLimitBody(throttle), true);
  assert.equal(isRateLimitBody(allowance), true);
  assert.equal(isRateLimitBody(tooMany), true);
  assert.equal(isRateLimitBody(client), false);
});

test('classify: rateLimitVerdict returns allowance with parkUntil null when no reset exists', () => {
  const verdict = rateLimitVerdict(
    429,
    parseJson(429, { error: { type: 'free_tier_limit_reached' } }),
    { 'Retry-After': '3600' },
    NOW,
  );
  assert.deepEqual(verdict, { limit: 'allowance', parkUntil: null });
});

test('classify: an allowance verdict reads an ISO-8601 resets_at from the body', () => {
  const resetsAt = '2030-01-01T00:00:00Z';
  const verdict = rateLimitVerdict(
    429,
    parseJson(429, { error: { type: 'free_tier_limit_reached', resets_at: resetsAt } }),
    undefined,
    NOW,
  );
  assert.deepEqual(verdict, { limit: 'allowance', parkUntil: Date.parse(resetsAt) });
});

test('classify: a throttle verdict attributes Retry-After to the header or none', () => {
  const parsed = parseJson(429, {
    error: { message: 'Rate limit exceeded', type: 'rate_limit_exceeded' },
  });

  assert.deepEqual(rateLimitVerdict(429, parsed, { 'Retry-After': '30' }, NOW), {
    limit: 'throttle',
    retryAfterMs: 30_000,
    source: 'header',
  });
  assert.deepEqual(rateLimitVerdict(429, parsed, {}, NOW), {
    limit: 'throttle',
    retryAfterMs: undefined,
    source: 'none',
  });
  assert.equal(rateLimitVerdict(400, parsed, undefined, NOW), null);
});

test('classify: parseRetryAfterMs handles seconds, fractions, negatives and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('30', NOW), 30_000);
  assert.equal(parseRetryAfterMs('0', NOW), 0);
  assert.equal(parseRetryAfterMs('-5', NOW), 0);
  assert.equal(parseRetryAfterMs('30.5', NOW), undefined);
  assert.equal(parseRetryAfterMs('not a date', NOW), undefined);
  assert.equal(parseRetryAfterMs('', NOW), undefined);
  assert.equal(parseRetryAfterMs(null, NOW), undefined);
  assert.equal(parseRetryAfterMs(undefined, NOW), undefined);

  const now = Date.parse('2015-10-21T07:27:30Z');
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', now), 30_000);
  assert.equal(
    parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-22T00:00:00Z')),
    0,
  );
});

test('classify: ERROR_PROFILES covers the four adapter ids', () => {
  for (const id of ['nvidia', 'openrouter', 'tokenharbor', 'generic']) {
    assert.ok(ERROR_PROFILES[id] !== undefined);
  }
});

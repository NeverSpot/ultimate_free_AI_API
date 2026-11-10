export interface Config {
  port: number;
  adminToken: string;
  maxBodyBytes: number;
  attemptTimeoutMs: number;
  requestDeadlineMs: number;
  logLevel: string;
  nodeEnv: string;
}

const DEFAULT_PORT = 8080;
const DEFAULT_MAX_BODY_BYTES = 2_097_152;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_DEADLINE_MS = 30_000;
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_NODE_ENV = 'development';

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/**
 * Read and validate configuration from an injected environment.
 *
 * Never reads `process.env` itself: `index.ts` passes it in, tests pass a literal.
 * Throws one error listing every problem so a bad deploy is diagnosable in one run.
 */
export function loadConfig(raw: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];

  const adminToken = raw.ADMIN_TOKEN?.trim() ?? '';
  if (adminToken.length === 0) {
    problems.push('ADMIN_TOKEN is required');
  }

  const port = readPositiveInt(raw, 'PORT', DEFAULT_PORT, problems);
  if (port > 65_535) {
    problems.push('PORT must be between 1 and 65535');
  }

  const maxBodyBytes = readPositiveInt(raw, 'MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, problems);
  const attemptTimeoutMs = readPositiveInt(
    raw,
    'ATTEMPT_TIMEOUT_MS',
    DEFAULT_ATTEMPT_TIMEOUT_MS,
    problems,
  );
  const requestDeadlineMs = readPositiveInt(
    raw,
    'REQUEST_DEADLINE_MS',
    DEFAULT_REQUEST_DEADLINE_MS,
    problems,
  );

  const logLevel = raw.LOG_LEVEL?.trim() || DEFAULT_LOG_LEVEL;
  if (!LOG_LEVELS.has(logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${[...LOG_LEVELS].join(', ')} (got "${logLevel}")`);
  }

  const nodeEnv = raw.NODE_ENV?.trim() || DEFAULT_NODE_ENV;

  if (problems.length > 0) {
    throw new Error(
      `Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }

  return {
    port,
    adminToken,
    maxBodyBytes,
    attemptTimeoutMs,
    requestDeadlineMs,
    logLevel,
    nodeEnv,
  };
}

function readPositiveInt(
  raw: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  problems: string[],
): number {
  const value = raw[key];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    problems.push(`${key} must be a positive integer (got "${value}")`);
    return fallback;
  }

  return parsed;
}

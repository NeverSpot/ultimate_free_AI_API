export interface Config {
  port: number;
  adminToken: string;
  encryptionKey: string;
  maxBodyBytes: number;
  attemptTimeoutMs: number;
  requestDeadlineMs: number;
  logLevel: string;
  nodeEnv: string;
  sseHeadersEnabled?: boolean;
  corsOrigin?: string;
  /** HS256 secret for the httpOnly session cookie. Optional outside production. */
  jwtSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  oauthCallbackBase?: string;
  /** Where the browser is sent after OAuth and what the API trusts for redirects. */
  frontendUrl?: string;
  /** 'console' logs the OTP locally; production requires 'smtp' or 'resend'. */
  mailTransport?: MailTransport;
  mailFrom?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  resendApiKey?: string;
  otpTtlSeconds?: number;
  otpMaxAttempts?: number;
  otpResendCooldownSeconds?: number;
  /** Development-only: echo the code in the API response so the flow can be tested without mail. */
  otpDevReturnCode?: boolean;
  /** HMAC pepper for stored OTP codes; defaults to MASTER_ENCRYPTION_KEY. */
  otpPepper?: string;
  appName?: string;
}

const DEFAULT_FRONTEND_URL = 'http://localhost:3000';
const DEFAULT_MAIL_FROM = 'Ultimate Free AI <no-reply@localhost>';
const DEFAULT_OTP_TTL_SECONDS = 600;
const DEFAULT_OTP_MAX_ATTEMPTS = 5;
const DEFAULT_OTP_RESEND_COOLDOWN_SECONDS = 60;
const DEFAULT_SMTP_PORT = 587;
const APP_NAME = 'Ultimate Free AI';

export type MailTransport = 'console' | 'smtp' | 'resend';

const DEFAULT_PORT = 8080;
export const DEFAULT_CORS_ORIGIN = 'http://localhost:3000';
export const DEFAULT_OAUTH_CALLBACK_BASE = 'http://localhost:8080';
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

  const encryptionKey = raw.MASTER_ENCRYPTION_KEY?.trim() ?? '';
  if (encryptionKey.length === 0) {
    problems.push('MASTER_ENCRYPTION_KEY is required');
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
  const sseHeadersEnabled =
    raw.SSE_HEADERS_ENABLED !== undefined
      ? raw.SSE_HEADERS_ENABLED.trim().toLowerCase() === 'true'
      : true;

  const corsOrigin = raw.CORS_ORIGIN?.trim() || DEFAULT_CORS_ORIGIN;

  const jwtSecret = raw.JWT_SECRET?.trim() || undefined;
  if (jwtSecret === undefined && nodeEnv === 'production') {
    problems.push('JWT_SECRET is required in production');
  } else if (jwtSecret !== undefined && nodeEnv === 'production' && jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters in production');
  }

  const googleClientId = raw.GOOGLE_CLIENT_ID?.trim() ?? '';
  const googleClientSecret = raw.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  const githubClientId = raw.GITHUB_CLIENT_ID?.trim() ?? '';
  const githubClientSecret = raw.GITHUB_CLIENT_SECRET?.trim() ?? '';
  const oauthCallbackBase = raw.OAUTH_CALLBACK_BASE?.trim() || DEFAULT_OAUTH_CALLBACK_BASE;
  const frontendUrl = raw.FRONTEND_URL?.trim() || DEFAULT_FRONTEND_URL;
  if (!/^https?:\/\/[^\s/]+/.test(frontendUrl)) {
    problems.push(`FRONTEND_URL must be an absolute http(s) URL (got "${frontendUrl}")`);
  }
  if (!/^https?:\/\/[^\s/]+/.test(oauthCallbackBase)) {
    problems.push(
      `OAUTH_CALLBACK_BASE must be an absolute http(s) URL (got "${oauthCallbackBase}")`,
    );
  }

  const mailTransportRaw = (raw.MAIL_TRANSPORT?.trim() || 'console').toLowerCase();
  if (
    mailTransportRaw !== 'console' &&
    mailTransportRaw !== 'smtp' &&
    mailTransportRaw !== 'resend'
  ) {
    problems.push(`MAIL_TRANSPORT must be console, smtp or resend (got "${mailTransportRaw}")`);
  }
  const mailTransport = mailTransportRaw as MailTransport;
  const mailFrom = raw.MAIL_FROM?.trim() || DEFAULT_MAIL_FROM;
  const smtpHost = raw.SMTP_HOST?.trim() || undefined;
  const smtpPort = readPositiveInt(raw, 'SMTP_PORT', DEFAULT_SMTP_PORT, problems);
  const smtpSecure =
    raw.SMTP_SECURE !== undefined
      ? raw.SMTP_SECURE.trim().toLowerCase() === 'true'
      : smtpPort === 465;
  const smtpUser = raw.SMTP_USER?.trim() || undefined;
  const smtpPass = raw.SMTP_PASS?.trim() || undefined;
  const resendApiKey = raw.RESEND_API_KEY?.trim() || undefined;

  const otpTtlSeconds = readPositiveInt(raw, 'OTP_TTL_SECONDS', DEFAULT_OTP_TTL_SECONDS, problems);
  const otpMaxAttempts = readPositiveInt(
    raw,
    'OTP_MAX_ATTEMPTS',
    DEFAULT_OTP_MAX_ATTEMPTS,
    problems,
  );
  const otpResendCooldownSeconds = readPositiveInt(
    raw,
    'OTP_RESEND_COOLDOWN_SECONDS',
    DEFAULT_OTP_RESEND_COOLDOWN_SECONDS,
    problems,
  );
  // Never honoured in production: echoing a live code over HTTP defeats the point.
  const otpDevReturnCode =
    raw.OTP_DEV_RETURN_CODE?.trim().toLowerCase() === 'true' && nodeEnv !== 'production';
  const otpPepper = raw.OTP_PEPPER?.trim() || encryptionKey;

  if (googleClientId.length > 0 !== googleClientSecret.length > 0) {
    problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together');
  }
  if (githubClientId.length > 0 !== githubClientSecret.length > 0) {
    problems.push('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together');
  }

  if (nodeEnv === 'production') {
    if (mailTransport === 'console') {
      problems.push('MAIL_TRANSPORT must be smtp or resend in production');
    }
    if (mailTransport === 'smtp' && smtpHost === undefined) {
      problems.push('SMTP_HOST is required when MAIL_TRANSPORT=smtp');
    }
    if (mailTransport === 'smtp' && (smtpUser === undefined) !== (smtpPass === undefined)) {
      problems.push('SMTP_USER and SMTP_PASS must be set together');
    }
    if (mailTransport === 'resend' && resendApiKey === undefined) {
      problems.push('RESEND_API_KEY is required when MAIL_TRANSPORT=resend');
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }

  return {
    port,
    adminToken,
    encryptionKey,
    maxBodyBytes,
    attemptTimeoutMs,
    requestDeadlineMs,
    logLevel,
    nodeEnv,
    sseHeadersEnabled,
    corsOrigin,
    jwtSecret,
    googleClientId,
    googleClientSecret,
    githubClientId,
    githubClientSecret,
    oauthCallbackBase,
    frontendUrl,
    mailTransport,
    mailFrom,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPass,
    resendApiKey,
    otpTtlSeconds,
    otpMaxAttempts,
    otpResendCooldownSeconds,
    otpDevReturnCode,
    otpPepper,
    appName: APP_NAME,
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

import { ProviderError, type ErrorKind } from '../core/errors';
import { parseRetryAfterMs } from './retry-after';

export { parseRetryAfterMs };

/** A provider error body reduced to the pieces classification actually uses. */
export interface ParsedError {
  json: boolean;
  message?: string;
  type?: string;
  code?: string | number;
  text: string;
}

type HeaderBag = Headers | Record<string, string> | undefined;

/** Non-JSON bodies are truncated before they are ever retained. */
const MAX_TEXT_LENGTH = 500;

const ALLOWANCE_SIGNAL = 'free_tier_limit_reached';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asCode(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/**
 * Parse an arbitrary upstream error body without ever throwing.
 *
 * Non-JSON bodies contribute no message on purpose: an HTML error page must never reach
 * a client. `classifyStatus` falls back to `HTTP <status>` in that case.
 */
export function parseErrorBody(_status: number, bodyText: string): ParsedError {
  if (bodyText.trim() === '') {
    return { json: false, text: '' };
  }

  let value: unknown;
  try {
    value = JSON.parse(bodyText);
  } catch {
    return { json: false, text: bodyText.slice(0, MAX_TEXT_LENGTH) };
  }

  const root = asRecord(value);
  if (root === undefined) {
    return { json: true, text: bodyText };
  }

  const nested = asRecord(root.error);
  const message =
    asString(nested?.message) ??
    asString(root.message) ??
    asString(root.detail) ??
    asString(root.title);
  const type = asString(nested?.type) ?? asString(root.type);
  const code = asCode(nested?.code) ?? asCode(root.code);

  const parsed: ParsedError = { json: true, text: bodyText };
  if (message !== undefined) {
    parsed.message = message;
  }
  if (type !== undefined) {
    parsed.type = type;
  }
  if (code !== undefined) {
    parsed.code = code;
  }

  return parsed;
}

/** Substrings that name throttling or a spent allowance. Compared case-insensitively. */
const RATE_LIMIT_SIGNALS = [
  'rate_limit',
  'rate limit',
  'rate-limit',
  'ratelimit',
  'throttl',
  'too many requests',
  'insufficient_quota',
  'insufficient quota',
  'free_tier_limit_reached',
  'free tier limit',
  'allowance',
  'quota',
] as const;

const TOO_LONG_SIGNALS = [
  'context_length_exceeded',
  'maximum context length',
  'context length exceeded',
] as const;

const BLOCKED_SIGNALS = ['content_filter', 'content policy', 'content_policy'] as const;

function namesSignal(parsed: ParsedError, signals: readonly string[]): boolean {
  return [parsed.type, parsed.code, parsed.message].some((value) => {
    if (value === undefined) {
      return false;
    }
    const text = String(value).toLowerCase();
    return signals.some((signal) => text.includes(signal));
  });
}

/** True when the body names a throttle or a spent allowance. */
export function isRateLimitBody(parsed: ParsedError): boolean {
  return namesSignal(parsed, RATE_LIMIT_SIGNALS);
}

function namesAllowance(parsed: ParsedError): boolean {
  return (
    parsed.type === ALLOWANCE_SIGNAL ||
    parsed.code === ALLOWANCE_SIGNAL ||
    (parsed.message?.toLowerCase().includes('free tier limit') ?? false)
  );
}

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function epochToMs(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  // Epoch seconds are ~1e9 today; epoch milliseconds are ~1e12.
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function resetValueToMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return epochToMs(value);
  }
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return epochToMs(Number(trimmed));
  }

  const timestamp = Date.parse(trimmed);
  return Number.isNaN(timestamp) ? null : timestamp;
}

/**
 * Read the explicit reset field from the original body.
 *
 * `ParsedError` intentionally carries only the classification fields, so the reset time
 * is recovered from `text` rather than widening that interface.
 */
function bodyResetTime(parsed: ParsedError): number | null {
  if (!parsed.json) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(parsed.text);
  } catch {
    return null;
  }

  const root = asRecord(value);
  if (root === undefined) {
    return null;
  }
  const nested = asRecord(root.error);
  const raw =
    nested?.resets_at ??
    nested?.reset_at ??
    nested?.retry_after ??
    root.resets_at ??
    root.reset_at ??
    root.retry_after;

  return resetValueToMs(raw);
}

export type RateLimitVerdict =
  | { limit: 'throttle'; retryAfterMs: number | undefined; source: 'header' | 'none' }
  | { limit: 'allowance'; parkUntil: number | null };

/**
 * Disambiguate a 429 into ordinary throttling or a spent free allowance.
 *
 * Returns `null` for every status except 429.
 */
export function rateLimitVerdict(
  status: number,
  parsed: ParsedError,
  headers: HeaderBag,
  now: number,
): RateLimitVerdict | null {
  if (status !== 429) {
    return null;
  }

  if (namesAllowance(parsed)) {
    // Token Harbor sends `Retry-After: 3600` on a 7-day allowance. The header lies by
    // orders of magnitude, so only the body's explicit reset field is trusted.
    return { limit: 'allowance', parkUntil: bodyResetTime(parsed) };
  }

  const retryAfterMs = parseRetryAfterMs(readHeader(headers, 'retry-after'), now);
  return {
    limit: 'throttle',
    retryAfterMs,
    source: retryAfterMs === undefined ? 'none' : 'header',
  };
}

export interface ErrorProfile {
  authStatuses: readonly number[];
  modelGoneStatuses: readonly number[];
  /** A non-auth status that really means "this credential is bad" (Google's 400). */
  isAuth?: (parsed: ParsedError) => boolean;
  /** 400 that really means "unknown model", decided structurally, never by substring. */
  isInvalidModel?: (parsed: ParsedError) => boolean;
  /** 429 that really means "free allowance spent", not ordinary throttling. */
  isAllowance?: (parsed: ParsedError) => boolean;
}

/**
 * OpenRouter reports an unknown model as a 400 whose message is `<id> is not a valid
 * model ID`. The whole message must match, so a malformed-body error cannot slip in.
 */
const OPENROUTER_INVALID_MODEL_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]* is not a valid model ID\.?$/;

function isOpenRouterInvalidModel(parsed: ParsedError): boolean {
  const message = parsed.message?.trim();
  if (message === undefined || !OPENROUTER_INVALID_MODEL_PATTERN.test(message)) {
    return false;
  }
  if (parsed.type === 'invalid_request_error') {
    return false;
  }
  return parsed.code === undefined || typeof parsed.code === 'number';
}

function isTokenHarborAllowance(parsed: ParsedError): boolean {
  return parsed.type === ALLOWANCE_SIGNAL || parsed.code === ALLOWANCE_SIGNAL;
}

const GENERIC_PROFILE: ErrorProfile = {
  authStatuses: [401, 403],
  modelGoneStatuses: [404],
};

/**
 * A provider whose "free" is a recurring allowance. 401/403 mean the key is bad;
 * 404 means the model left the catalog.
 */
const FREE_TIER_PROFILE: ErrorProfile = {
  authStatuses: [401, 403],
  modelGoneStatuses: [404],
};

/**
 * A provider whose "free" is a finite signup balance. 402 is added because the balance
 * is per credential: retrying the same key can never succeed, so it must fail over
 * instead of backing off.
 */
const CREDIT_PROFILE: ErrorProfile = {
  authStatuses: [401, 402, 403],
  modelGoneStatuses: [404],
};

/**
 * Google answers a bad key with 400 `API key not valid. Please pass a valid API key.`
 * rather than 401, so the status alone would classify a dead credential as the caller's
 * fault and park the whole provider behind one typo.
 */
function isGoogleInvalidKey(parsed: ParsedError): boolean {
  const message = parsed.message?.trim().toLowerCase() ?? '';
  return message.startsWith('api key not valid') || message.startsWith('api key expired');
}

const FREE_TIER_IDS = [
  'groq',
  'cerebras',
  'sambanova',
  'zai',
  'mistral',
  'cloudflare',
  'cohere',
  'aimlapi',
] as const;

const CREDIT_IDS = [
  'together',
  'fireworks',
  'deepinfra',
  'novita',
  'hyperbolic',
  'huggingface',
  'replicate',
] as const;

/** Per-adapter quirks. `generic` is the fallback for an unknown provider id. */
export const ERROR_PROFILES: Record<string, ErrorProfile> = {
  nvidia: {
    authStatuses: [401, 403],
    // The body is plain text on NVIDIA, so 404 is enough on its own.
    modelGoneStatuses: [404],
  },
  openrouter: {
    // 402 is per-credential funding state: retrying the same key never succeeds.
    authStatuses: [401, 402],
    modelGoneStatuses: [404],
    isInvalidModel: isOpenRouterInvalidModel,
  },
  tokenharbor: {
    authStatuses: [401, 403],
    modelGoneStatuses: [404],
    isAllowance: isTokenHarborAllowance,
  },
  google: { ...FREE_TIER_PROFILE, isAuth: isGoogleInvalidKey },
  ...Object.fromEntries(FREE_TIER_IDS.map((id) => [id, FREE_TIER_PROFILE])),
  ...Object.fromEntries(CREDIT_IDS.map((id) => [id, CREDIT_PROFILE])),
  generic: GENERIC_PROFILE,
};

interface Classification {
  kind: ErrorKind;
  retryAfterMs?: number;
}

function bodySignal(parsed: ParsedError): 'too_long' | 'blocked' | undefined {
  if (namesSignal(parsed, TOO_LONG_SIGNALS)) {
    return 'too_long';
  }
  if (namesSignal(parsed, BLOCKED_SIGNALS)) {
    return 'blocked';
  }
  return undefined;
}

function classifyKind(
  status: number,
  parsed: ParsedError,
  headers: HeaderBag,
  profile: ErrorProfile,
  now: number,
): Classification {
  // 1. A body that names the failure beats the status code, whatever it is.
  const signal = bodySignal(parsed);
  if (signal !== undefined) {
    return { kind: signal };
  }

  // 2. Free-allowance exhaustion is not ordinary throttling. The header is a lie here.
  if (status === 429 && profile.isAllowance?.(parsed) === true) {
    return { kind: 'exhausted' };
  }

  // 3. Transport-ish families.
  if (status === 408 || status === 504) {
    return { kind: 'timeout' };
  }
  if (status >= 500) {
    return { kind: 'upstream' };
  }

  // 4-5. Credential and model state, per adapter profile.
  if (profile.authStatuses.includes(status) || profile.isAuth?.(parsed) === true) {
    return { kind: 'auth' };
  }
  if (profile.modelGoneStatuses.includes(status)) {
    return { kind: 'model_gone' };
  }

  // 6. A 400/422 is usually the caller's fault; OpenRouter's unknown-model 400 is the
  // one structural exception.
  if (status === 400 || status === 422) {
    return { kind: profile.isInvalidModel?.(parsed) === true ? 'model_gone' : 'client' };
  }

  // 7. Ordinary throttling carries the header's delay; backoff fallback is parkDecision's.
  if (status === 429) {
    const verdict = rateLimitVerdict(status, parsed, headers, now);
    return {
      kind: 'rate_limited',
      retryAfterMs: verdict?.limit === 'throttle' ? verdict.retryAfterMs : undefined,
    };
  }

  // 8. Any other 4xx is the caller's; everything else is the upstream's.
  if (status >= 400 && status < 500) {
    return { kind: 'client' };
  }
  return { kind: 'upstream' };
}

/**
 * Map an upstream status plus parsed body into the gateway's error taxonomy.
 *
 * Pure apart from the injectable clock default: no I/O, no fetch, no provider details
 * leak past `ProviderError.message`.
 */
export function classifyStatus(
  status: number,
  parsed: ParsedError,
  headers: HeaderBag,
  opts: { provider?: string; profile?: ErrorProfile; now?: number } = {},
): ProviderError {
  const provider = opts.provider;
  const profile =
    opts.profile ??
    (provider === undefined ? GENERIC_PROFILE : (ERROR_PROFILES[provider] ?? GENERIC_PROFILE));
  const now = opts.now ?? Date.now();
  const message = parsed.message ?? `HTTP ${status}`;
  const classification = classifyKind(status, parsed, headers, profile, now);

  return new ProviderError(classification.kind, message, {
    status,
    retryAfterMs: classification.retryAfterMs,
    provider,
  });
}

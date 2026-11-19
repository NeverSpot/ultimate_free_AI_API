/**
 * Where the API lives, including the `/v1` prefix.
 *
 * Defaults to same-origin `/v1`: in the Vercel deployment `vercel.json` routes
 * `/v1/*` to the gateway service, and `next.config.ts` proxies `/v1/*` to the
 * gateway during `next dev`. Browser and API therefore share one origin in both
 * environments, so the session cookie stays first-party. Set NEXT_PUBLIC_API_URL
 * only when the gateway is on a different origin in production. Trailing slashes
 * are stripped so paths never double up.
 */
const BASE_URL = (process.env.NEXT_PUBLIC_API_URL || '/v1').replace(/\/+$/, '');

/**
 * Every request sends the httpOnly session cookie. `no-store` keeps the
 * `/v1/user/me` probe honest after logout.
 */
const REQUEST_INIT: Pick<RequestInit, 'credentials' | 'cache'> = {
  credentials: 'include',
  cache: 'no-store',
};

/** Keep a wedged gateway from leaving a page spinning forever. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One error shape for every failed call. `status` is the HTTP status, or 0 when
 * the request never reached the gateway; `code` mirrors the OpenAI error code
 * when the server sent one.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** A 401 is "signed out", not a transport failure; callers branch on this. */
export function isUnauthorized(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401;
}

export interface SessionUser {
  id: string;
  username: string;
  email: string;
}

export interface KeySummary {
  id: string;
  provider: string;
  label: string;
  fingerprint: string;
  created_at: string;
  updated_at: string;
  /** True while the gateway has this key parked after a provider throttle. */
  parked: boolean;
  /** Milliseconds until the park lifts; 0 when the key is available. */
  retry_after_ms: number;
}

export interface ListKeysResponse {
  keys: KeySummary[];
}

export interface RegisterResponse {
  user: {
    id: string;
    username: string;
    email: string;
  };
  gateway_api_key: string;
}

/**
 * Step 1 of signup: the server has mailed a code and created nothing yet. The
 * account (and the gateway key) arrive from `/auth/register/verify`.
 */
export interface RegisterStartedResponse {
  otp_required: true;
  email: string;
  expires_in_seconds: number;
  /** Only present in development when OTP_DEV_RETURN_CODE is enabled. */
  dev_code?: string;
}

export interface OAuthProvidersResponse {
  providers: Array<'google' | 'github'>;
}

export interface LoginResponse {
  userId: string;
  username: string;
  /** The user's gateway API key, re-issued by the server on every login. */
  gateway_api_key?: string;
}

export interface GatewayKeyResponse {
  /** The current key, or null for a legacy account with no recoverable copy. */
  gateway_api_key: string | null;
}

export interface ProviderInfo {
  id: string;
  name: string;
  tier: 'free' | 'credit';
  key_env_var: string;
  free_note: string;
  signup_url: string;
  docs_url: string;
  aliases: string[];
  requires_env: string | null;
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
}

export interface RegenerateKeyResponse {
  gateway_api_key: string;
}

export interface UsageSummary {
  /** Rolling window the server used; 30 unless configured otherwise. */
  window_days: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  /** Requests that needed more than one provider attempt. */
  failovers: number;
  last_request_at: string | null;
}

export interface UsageResponse {
  usage: UsageSummary;
}

export type ProviderHealth = 'healthy' | 'degraded' | 'unhealthy';

export interface ProvidersHealthResponse {
  status?: string;
  /** Only providers the router has actually exercised appear here. */
  providers: Record<string, ProviderHealth>;
}

export interface KeyTestResult {
  ok: boolean;
  provider: string;
  model: string | null;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  reply: string | null;
  error: string | null;
  error_kind: string | null;
  http_status: number | null;
}

/** API origin without the `/v1` suffix, for browser navigations the server must see. */
export function apiOrigin(): string {
  return BASE_URL.replace(/\/v1\/?$/, '');
}

/** OAuth is a full-page redirect, not a fetch: the state cookie must ride it. */
export function oauthStartUrl(provider: 'google' | 'github'): string {
  return `${apiOrigin()}/v1/auth/oauth/${provider}/start`;
}

/**
 * Trust the server's list verbatim, but make the two optional row flags safe to
 * render: an older gateway may omit them, and `undefined` must not read as parked.
 */
export function normalizeKeyList(response: ListKeysResponse | null | undefined): KeySummary[] {
  if (!Array.isArray(response?.keys)) return [];
  return response.keys
    .filter((key) => typeof key?.id === 'string' && typeof key.provider === 'string')
    .map((key) => ({
      ...key,
      parked: key.parked === true,
      retry_after_ms: Number.isFinite(key.retry_after_ms) ? key.retry_after_ms : 0,
    }));
}

function getHeaders(withBody: boolean): HeadersInit {
  // Fastify rejects a JSON content-type with an empty body (400), so only
  // declare it when a body is actually sent. The session cookie is the only
  // credential this client sends; the gateway key is never persisted here.
  return withBody ? { 'Content-Type': 'application/json' } : {};
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let message = `HTTP ${response.status}`;
  let code: string | null = null;

  try {
    const body: unknown = await response.json();
    const envelope = body as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
    };
    if (typeof envelope.error?.message === 'string' && envelope.error.message.length > 0) {
      message = envelope.error.message;
    } else if (typeof envelope.message === 'string' && envelope.message.length > 0) {
      message = envelope.message;
    }
    const rawCode = envelope.error?.code;
    if (typeof rawCode === 'string' && rawCode.length > 0) {
      code = rawCode;
    } else if (typeof rawCode === 'number') {
      code = String(rawCode);
    }
  } catch {
    // A non-JSON error body still carries the status; the generic message stands.
  }

  return new ApiError(message, response.status, code);
}

function buildUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_URL}${cleanPath}`;
}

/**
 * The one fetch wrapper: timeout, typed errors, JSON handling. It deliberately
 * has no redirect side effect — the session provider owns "signed out", so a
 * failed call never reloads the page and hides the message the caller wants.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(buildUrl(path), {
      ...REQUEST_INIT,
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new ApiError('The gateway did not answer in time. Try again.', 0, 'timeout');
    }
    throw new ApiError(
      error instanceof Error ? error.message : 'Could not reach the gateway',
      0,
      'network',
    );
  }

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  const text = await response.text();
  if (text.length === 0) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(
      'The gateway returned an invalid response.',
      response.status,
      'invalid_response',
    );
  }
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'GET', headers: getHeaders(false) });
  },

  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      headers: getHeaders(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  },

  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: 'PUT',
      headers: getHeaders(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  },

  delete<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: 'DELETE',
      headers: getHeaders(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  },
};

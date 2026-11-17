const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/v1';

/**
 * Every request sends the httpOnly session cookie. `no-store` keeps the
 * `/v1/user/me` probe honest after logout.
 */
const REQUEST_INIT: Pick<RequestInit, 'credentials' | 'cache'> = {
  credentials: 'include',
  cache: 'no-store',
};

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

export interface RegenerateKeyResponse {
  gateway_api_key: string;
}

function getGatewayKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('gateway_api_key') || localStorage.getItem('gateway_key');
    if (raw) return raw;
    const user = localStorage.getItem('user');
    if (user) {
      const parsed = JSON.parse(user);
      if (parsed && (parsed.gateway_api_key || parsed.gateway_key)) {
        return parsed.gateway_api_key || parsed.gateway_key;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function getHeaders(withBody = false): HeadersInit {
  const headers: Record<string, string> = {};
  // Fastify rejects a JSON content-type with an empty body (400), so only
  // declare it when a body is actually sent.
  if (withBody) {
    headers['Content-Type'] = 'application/json';
  }
  const key = getGatewayKey();
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    // A 401 from /v1/auth/* means "wrong credentials", not "expired session".
    // A 401 from /v1/user/me is the session probe itself: the caller (useSession)
    // branches on it. Redirecting from either would reload the page and hide the error.
    const isAuthRequest = response.url.includes('/v1/auth/');
    const isSessionProbe = response.url.includes('/v1/user/me');
    if (
      response.status === 401 &&
      !isAuthRequest &&
      !isSessionProbe &&
      typeof window !== 'undefined'
    ) {
      localStorage.removeItem('gateway_key');
      localStorage.removeItem('gateway_api_key');
      localStorage.removeItem('user');
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = '/login';
    }

    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error?.message) {
        message = body.error.message;
      } else if (body?.message) {
        message = body.message;
      }
    } catch {
      // best effort
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function buildUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_URL}${cleanPath}`;
}

export const api = {
  async get<T>(path: string): Promise<T> {
    const response = await fetch(buildUrl(path), {
      method: 'GET',
      headers: getHeaders(),
      ...REQUEST_INIT,
    });
    return handleResponse<T>(response);
  },

  async post<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(buildUrl(path), {
      method: 'POST',
      headers: getHeaders(body !== undefined),
      ...REQUEST_INIT,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return handleResponse<T>(response);
  },

  async put<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(buildUrl(path), {
      method: 'PUT',
      headers: getHeaders(body !== undefined),
      ...REQUEST_INIT,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return handleResponse<T>(response);
  },

  async delete<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(buildUrl(path), {
      method: 'DELETE',
      headers: getHeaders(body !== undefined),
      ...REQUEST_INIT,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return handleResponse<T>(response);
  },
};

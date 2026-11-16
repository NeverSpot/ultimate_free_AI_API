const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/v1';

export interface KeySummary {
  provider: string;
  fingerprint: string;
  created_at: string;
  updated_at: string;
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
    // Redirecting here would reload the login page and hide the error message.
    const isAuthRequest = response.url.includes('/v1/auth/');
    if (response.status === 401 && !isAuthRequest && typeof window !== 'undefined') {
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
    throw new Error(message);
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
    });
    return handleResponse<T>(response);
  },

  async post<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(buildUrl(path), {
      method: 'POST',
      headers: getHeaders(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return handleResponse<T>(response);
  },

  async put<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(buildUrl(path), {
      method: 'PUT',
      headers: getHeaders(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return handleResponse<T>(response);
  },

  async delete<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(buildUrl(path), {
      method: 'DELETE',
      headers: getHeaders(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return handleResponse<T>(response);
  },
};

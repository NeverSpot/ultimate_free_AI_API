import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  isUnauthorized,
  normalizeKeyList,
  type KeySummary,
  type ListKeysResponse,
} from '../src/lib/api';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api error handling', () => {
  it('turns a 401 into a typed, retryable ApiError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: 'Missing session', code: 'unauthorized' } }, 401),
    );

    const error = await api.get('/user/me').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(isUnauthorized(error)).toBe(true);
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'Missing session',
      status: 401,
      code: 'unauthorized',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/user/me',
      expect.objectContaining({
        credentials: 'include',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reports a timeout with status 0 instead of hanging', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

    const error = await api.get('/user/keys').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 0,
      code: 'timeout',
      message: 'The gateway did not answer in time. Try again.',
    });
  });

  it('keeps the HTTP status when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('upstream exploded', { status: 502 }));

    const error = await api.get('/user/keys').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: null, message: 'HTTP 502' });
  });

  it('unwraps a plain message envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Database unavailable' }, 503));

    const error = await api.get('/user/keys').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, message: 'Database unavailable' });
  });

  it('rejects an invalid JSON success body with a typed error', async () => {
    fetchMock.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));

    await expect(api.get('/providers')).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    });
  });

  it('sends a JSON content type only when a body is present', async () => {
    // A fresh Response per call: a Response body can only be read once.
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }));

    await api.post('/auth/logout');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/v1/auth/logout',
      expect.objectContaining({ method: 'POST', headers: {} }),
    );

    await api.post('/auth/login', { username: 'ada' });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ada' }),
      }),
    );
  });
});

describe('normalizeKeyList', () => {
  const row: KeySummary = {
    id: 'key-1',
    provider: 'groq',
    label: 'primary',
    fingerprint: 'abc123',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    parked: false,
    retry_after_ms: 0,
  };

  it('fills the optional row flags an older gateway may omit', () => {
    const legacy = {
      id: 'key-2',
      provider: 'cerebras',
      label: 'backup',
      fingerprint: 'def456',
      created_at: '',
      updated_at: '',
    } as KeySummary;

    expect(normalizeKeyList({ keys: [row, legacy] })).toEqual([
      row,
      { ...legacy, parked: false, retry_after_ms: 0 },
    ]);
  });

  it('keeps a parked key parked', () => {
    const parked = { ...row, parked: true, retry_after_ms: 90_000 };
    expect(normalizeKeyList({ keys: [parked] })[0]).toMatchObject({
      parked: true,
      retry_after_ms: 90_000,
    });
  });

  it('drops malformed rows and handles missing lists', () => {
    const malformed = { id: 3, provider: 'x' } as unknown as KeySummary;

    expect(normalizeKeyList({ keys: [malformed, row] })).toEqual([row]);
    expect(normalizeKeyList(null)).toEqual([]);
    expect(normalizeKeyList(undefined)).toEqual([]);
    expect(normalizeKeyList({} as ListKeysResponse)).toEqual([]);
  });
});

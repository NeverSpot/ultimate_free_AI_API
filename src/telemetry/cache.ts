import { createHash } from 'node:crypto';

/**
 * The subset of the Redis client the semantic cache depends on.
 *
 * Library code never imports ioredis or reads `process.env`; the server wires a
 * real client via `setCacheClient` (tests inject a fake). Cache is best-effort:
 * with no backend wired, every lookup is a miss and every store is a no-op.
 */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del?(key: string): Promise<number>;
  disconnect?(): void;
}

/** Default TTL for cached chat completions: 1 hour. */
export const DEFAULT_TTL_SECONDS = 60 * 60;

let client: CacheClient | undefined;

/** Inject a cache backend (real ioredis in production, fake in tests). */
export function setCacheClient(value: CacheClient): void {
  client = value;
}

/** Current cache backend, or `undefined` when none has been wired. */
export function getCacheClient(): CacheClient | undefined {
  return client;
}

/**
 * Look up a cached payload by key. `null` on a miss, or when no backend is wired.
 */
export async function getCached(key: string): Promise<string | null> {
  return (await client?.get(key)) ?? null;
}

/**
 * Store `value` under `key` with `ttlSeconds`. Resolves even when no backend
 * is wired.
 */
export async function setCached(
  key: string,
  value: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  await client?.setex(key, ttlSeconds, value);
}

/** Hash request material into a fixed-length cache key segment. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Build a cache key for a chat completion request: provider, model and a hash of
 * the request body. Same inputs produce the same key, so a cache hit returns the
 * stored response without calling upstream.
 */
export function cacheKey(params: { provider: string; model: string; bodyHash: string }): string {
  return `cache:chat:${params.provider}:${params.model}:${params.bodyHash}`;
}

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors';

export interface StoredResponse {
  statusCode: number;
  headers: Record<string, string>;
  isStream: boolean;
  body?: unknown;
  chunks?: string[];
}

export type LockAcquireResult =
  | { state: 'acquired'; token: string }
  | { state: 'locked' }
  | { state: 'cached'; response: StoredResponse };

export type LockCheckResult =
  { state: 'locked' } | { state: 'released' } | { state: 'cached'; response: StoredResponse };

export interface IdempotencyCommand {
  (...args: Array<string | number>): Promise<unknown>;
}

export interface IdempotencyCommandDefinition {
  lua: string;
  numberOfKeys?: number;
}

export interface IdempotencyClient {
  defineCommand(name: string, definition: IdempotencyCommandDefinition): IdempotencyCommand;
  disconnect?(): void;
}

export interface IdempotencyStorage {
  acquire(key: string, token: string, lockTtlMs: number): Promise<LockAcquireResult>;
  complete(key: string, token: string, response: StoredResponse, resTtlSec: number): Promise<void>;
  release(key: string, token: string): Promise<void>;
  check(key: string): Promise<LockCheckResult>;
}

export function idempotencyLockKey(key: string): string {
  return `idem:lock:{${key}}`;
}

export function idempotencyResultKey(key: string): string {
  return `idem:res:{${key}}`;
}

const ACQUIRE_LUA = `
local lockKey = KEYS[1]
local resKey = KEYS[2]
local lockToken = ARGV[1]
local lockTtlMs = tonumber(ARGV[2])

local cached = redis.call('GET', resKey)
if cached then
  return { 'cached', cached }
end

local acquired = redis.call('SET', lockKey, lockToken, 'NX', 'PX', lockTtlMs)
if acquired then
  return { 'acquired' }
else
  return { 'locked' }
end
`;

const COMPLETE_LUA = `
local lockKey = KEYS[1]
local resKey = KEYS[2]
local lockToken = ARGV[1]
local resPayload = ARGV[2]
local resTtlSec = tonumber(ARGV[3])

local currentLock = redis.call('GET', lockKey)
if currentLock == lockToken then
  redis.call('DEL', lockKey)
end

redis.call('SET', resKey, resPayload, 'EX', resTtlSec)
return 1
`;

const RELEASE_LUA = `
local lockKey = KEYS[1]
local lockToken = ARGV[1]

local currentLock = redis.call('GET', lockKey)
if currentLock == lockToken then
  return redis.call('DEL', lockKey)
end
return 0
`;

const CHECK_LUA = `
local lockKey = KEYS[1]
local resKey = KEYS[2]

local cached = redis.call('GET', resKey)
if cached then
  return { 'cached', cached }
end

local locked = redis.call('EXISTS', lockKey)
if locked == 1 then
  return { 'locked' }
else
  return { 'released' }
end
`;

const ACQUIRE_COMMAND = 'gatewayIdempotencyAcquire';
const COMPLETE_COMMAND = 'gatewayIdempotencyComplete';
const RELEASE_COMMAND = 'gatewayIdempotencyRelease';
const CHECK_COMMAND = 'gatewayIdempotencyCheck';

export class RedisIdempotencyStorage implements IdempotencyStorage {
  private acquireScript?: IdempotencyCommand;
  private completeScript?: IdempotencyCommand;
  private releaseScript?: IdempotencyCommand;
  private checkScript?: IdempotencyCommand;

  constructor(private readonly client: IdempotencyClient) {}

  private acquireCmd(): IdempotencyCommand {
    this.acquireScript ??= this.client.defineCommand(ACQUIRE_COMMAND, { lua: ACQUIRE_LUA });
    return this.acquireScript;
  }

  private completeCmd(): IdempotencyCommand {
    this.completeScript ??= this.client.defineCommand(COMPLETE_COMMAND, { lua: COMPLETE_LUA });
    return this.completeScript;
  }

  private releaseCmd(): IdempotencyCommand {
    this.releaseScript ??= this.client.defineCommand(RELEASE_COMMAND, { lua: RELEASE_LUA });
    return this.releaseScript;
  }

  private checkCmd(): IdempotencyCommand {
    this.checkScript ??= this.client.defineCommand(CHECK_COMMAND, { lua: CHECK_LUA });
    return this.checkScript;
  }

  async acquire(key: string, token: string, lockTtlMs: number): Promise<LockAcquireResult> {
    const raw = (await this.acquireCmd()(
      2,
      idempotencyLockKey(key),
      idempotencyResultKey(key),
      token,
      lockTtlMs,
    )) as unknown[];

    const status = String(raw?.[0]);
    if (status === 'cached' && typeof raw?.[1] === 'string') {
      const response = JSON.parse(raw[1]) as StoredResponse;
      return { state: 'cached', response };
    }
    if (status === 'acquired') {
      return { state: 'acquired', token };
    }
    return { state: 'locked' };
  }

  async complete(
    key: string,
    token: string,
    response: StoredResponse,
    resTtlSec: number,
  ): Promise<void> {
    await this.completeCmd()(
      2,
      idempotencyLockKey(key),
      idempotencyResultKey(key),
      token,
      JSON.stringify(response),
      resTtlSec,
    );
  }

  async release(key: string, token: string): Promise<void> {
    await this.releaseCmd()(1, idempotencyLockKey(key), token);
  }

  async check(key: string): Promise<LockCheckResult> {
    const raw = (await this.checkCmd()(
      2,
      idempotencyLockKey(key),
      idempotencyResultKey(key),
    )) as unknown[];

    const status = String(raw?.[0]);
    if (status === 'cached' && typeof raw?.[1] === 'string') {
      const response = JSON.parse(raw[1]) as StoredResponse;
      return { state: 'cached', response };
    }
    if (status === 'locked') {
      return { state: 'locked' };
    }
    return { state: 'released' };
  }
}

export class MemoryIdempotencyStorage implements IdempotencyStorage {
  private readonly locks = new Map<string, { token: string; expiresAt: number }>();
  private readonly results = new Map<string, { response: StoredResponse; expiresAt: number }>();
  private readonly emitter = new EventEmitter();

  constructor(private readonly clock: () => number = Date.now) {
    this.emitter.setMaxListeners(0);
  }

  async acquire(key: string, token: string, lockTtlMs: number): Promise<LockAcquireResult> {
    const now = this.clock();
    const cached = this.results.get(key);
    if (cached && cached.expiresAt > now) {
      return { state: 'cached', response: cached.response };
    }
    const currentLock = this.locks.get(key);
    if (currentLock && currentLock.expiresAt > now) {
      return { state: 'locked' };
    }
    this.locks.set(key, { token, expiresAt: now + lockTtlMs });
    return { state: 'acquired', token };
  }

  async complete(
    key: string,
    token: string,
    response: StoredResponse,
    resTtlSec: number,
  ): Promise<void> {
    const now = this.clock();
    const currentLock = this.locks.get(key);
    if (currentLock && currentLock.token === token) {
      this.locks.delete(key);
    }
    this.results.set(key, { response, expiresAt: now + resTtlSec * 1000 });
    this.emitter.emit(`done:${key}`, { state: 'cached', response });
  }

  async release(key: string, token: string): Promise<void> {
    const currentLock = this.locks.get(key);
    if (currentLock && currentLock.token === token) {
      this.locks.delete(key);
    }
    this.emitter.emit(`done:${key}`, { state: 'released' });
  }

  async check(key: string): Promise<LockCheckResult> {
    const now = this.clock();
    const cached = this.results.get(key);
    if (cached && cached.expiresAt > now) {
      return { state: 'cached', response: cached.response };
    }
    const currentLock = this.locks.get(key);
    if (currentLock && currentLock.expiresAt > now) {
      return { state: 'locked' };
    }
    return { state: 'released' };
  }

  waitForEvent(key: string, timeoutMs: number): Promise<LockCheckResult | null> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const eventName = `done:${key}`;
      const onDone = (result: LockCheckResult) => {
        if (timer) clearTimeout(timer);
        this.emitter.off(eventName, onDone);
        resolve(result);
      };
      this.emitter.once(eventName, onDone);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.emitter.off(eventName, onDone);
          resolve(null);
        }, timeoutMs);
      }
    });
  }
}

export interface IdempotencyServiceOptions {
  storage: IdempotencyStorage;
  lockTtlMs?: number;
  resTtlSec?: number;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
}

export type IdempotencyDecision =
  { type: 'replay'; response: StoredResponse } | { type: 'leader'; lockToken: string };

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const err = new Error('Client aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('Client aborted');
      err.name = 'AbortError';
      reject(err);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export class IdempotencyService {
  readonly storage: IdempotencyStorage;
  readonly lockTtlMs: number;
  readonly resTtlSec: number;
  readonly pollIntervalMs: number;
  readonly waitTimeoutMs: number;

  constructor(options: IdempotencyServiceOptions) {
    this.storage = options.storage;
    this.lockTtlMs = options.lockTtlMs ?? 30_000;
    this.resTtlSec = options.resTtlSec ?? 86_400;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000;
  }

  async process(key: string, options?: { signal?: AbortSignal }): Promise<IdempotencyDecision> {
    const lockToken = randomUUID();
    const startTime = Date.now();

    while (true) {
      if (options?.signal?.aborted) {
        const err = new Error('Client aborted');
        err.name = 'AbortError';
        throw err;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= this.waitTimeoutMs) {
        throw new ApiError('timeout', 'timed out waiting for concurrent idempotency flight');
      }

      const acquireResult = await this.storage.acquire(key, lockToken, this.lockTtlMs);

      if (acquireResult.state === 'cached') {
        return { type: 'replay', response: acquireResult.response };
      }

      if (acquireResult.state === 'acquired') {
        return { type: 'leader', lockToken };
      }

      const remainingMs = Math.max(0, this.waitTimeoutMs - (Date.now() - startTime));
      if (remainingMs === 0) {
        throw new ApiError('timeout', 'timed out waiting for concurrent idempotency flight');
      }

      const memStorage = this.storage as unknown as {
        waitForEvent?: (k: string, ms: number) => Promise<LockCheckResult | null>;
      };
      if (typeof memStorage.waitForEvent === 'function') {
        const eventRes = await memStorage.waitForEvent(
          key,
          Math.min(this.pollIntervalMs * 4, remainingMs),
        );
        if (eventRes !== null) {
          if (eventRes.state === 'cached') {
            return { type: 'replay', response: eventRes.response };
          }
          continue;
        }
      }

      const checkResult = await this.storage.check(key);
      if (checkResult.state === 'cached') {
        return { type: 'replay', response: checkResult.response };
      }

      if (checkResult.state === 'released') {
        continue;
      }

      await sleepWithSignal(Math.min(this.pollIntervalMs, remainingMs), options?.signal);
    }
  }

  async complete(key: string, token: string, response: StoredResponse): Promise<void> {
    await this.storage.complete(key, token, response, this.resTtlSec);
  }

  async release(key: string, token: string): Promise<void> {
    await this.storage.release(key, token);
  }
}

export function createMemoryIdempotencyService(
  options: {
    clock?: () => number;
    lockTtlMs?: number;
    resTtlSec?: number;
    pollIntervalMs?: number;
    waitTimeoutMs?: number;
  } = {},
): IdempotencyService {
  return new IdempotencyService({
    storage: new MemoryIdempotencyStorage(options.clock),
    ...options,
  });
}

export function createRedisIdempotencyService(
  client: IdempotencyClient,
  options: {
    lockTtlMs?: number;
    resTtlSec?: number;
    pollIntervalMs?: number;
    waitTimeoutMs?: number;
  } = {},
): IdempotencyService {
  return new IdempotencyService({
    storage: new RedisIdempotencyStorage(client),
    ...options,
  });
}

export function extractIdempotencyKey(
  headers: Record<string, unknown> | undefined,
): string | undefined {
  if (!headers) return undefined;
  const value = headers['idempotency-key'] ?? headers['x-idempotency-key'];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    const trimmed = value[0].trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export function replayResponse(reply: FastifyReply, stored: StoredResponse): FastifyReply | void {
  if (stored.isStream) {
    reply.hijack();
    const replayHeaders: Record<string, string> = {
      ...stored.headers,
      'idempotency-replay': 'true',
      'x-idempotency-replay': 'true',
    };
    reply.raw.writeHead(stored.statusCode, replayHeaders);
    if (typeof reply.raw.flushHeaders === 'function') {
      reply.raw.flushHeaders();
    }
    if (stored.chunks && stored.chunks.length > 0) {
      for (const chunk of stored.chunks) {
        reply.raw.write(chunk);
      }
    }
    reply.raw.end();
    return;
  }
  for (const [name, value] of Object.entries(stored.headers)) {
    reply.header(name, value);
  }
  reply.header('idempotency-replay', 'true');
  reply.header('x-idempotency-replay', 'true');
  return reply.status(stored.statusCode).send(stored.body);
}

export function createIdempotencyPreHandler(service: IdempotencyService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = extractIdempotencyKey(req.headers);
    if (!key) return;
    const decision = await service.process(key, { signal: req.raw.signal ?? req.signal });
    if (decision.type === 'replay') {
      return replayResponse(reply, decision.response);
    }
    (
      req as unknown as { idempotencyContext?: { key: string; token: string; completed: boolean } }
    ).idempotencyContext = {
      key,
      token: decision.lockToken,
      completed: false,
    };
  };
}

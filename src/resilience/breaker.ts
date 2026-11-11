import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The only three states the breaker may occupy. */
export type BreakerState = 'closed' | 'open' | 'half_open';

/** A breaker is keyed per (provider, model), never per credential. */
export interface BreakerTarget {
  provider: string;
  model: string;
}

/** Reaction costs, not provider ceilings: no RPM / RPD / TPM number appears here. */
export interface BreakerPolicy {
  windowMs: number;
  threshold: number;
  cooldownMs: number;
  probeLimit: number;
}

/** Defaults; `createBreaker` options are the only override path. */
export const BREAKER_DEFAULTS: Readonly<BreakerPolicy> = Object.freeze({
  windowMs: 60_000,
  threshold: 5,
  cooldownMs: 30_000,
  probeLimit: 1,
});

/** State read out of Redis, or supplied to the pure rules. */
export interface BreakerSnapshot {
  state: BreakerState;
  openedAtMs: number;
  probesUsed: number;
  /** When the current probe slot was claimed; lets a leaked probe be reclaimed. */
  probeStartedAtMs: number;
}

/**
 * Pure result of `decideAllow`.
 *
 * The public `allow()` strips a successful decision to `{ allowed: true }`; tests of the
 * state table use this richer shape to see the claimed probe slot.
 */
export type AllowDecision =
  | { allowed: true; state: 'closed' | 'half_open'; probesUsed: number }
  | { allowed: false; state: BreakerState; retryAfterMs: number };

/** What the caller sees. A denial always names the wait and the current state. */
export type AllowResult =
  { allowed: true } | { allowed: false; retryAfterMs: number; state: BreakerState };

export interface Breaker {
  allow(target: BreakerTarget): Promise<AllowResult>;
  recordSuccess(target: BreakerTarget): Promise<void>;
  recordFailure(target: BreakerTarget): Promise<void>;
}

/** A Lua script registered on the client; args are forwarded verbatim to EVALSHA. */
export interface BreakerCommand {
  (...args: Array<string | number>): Promise<unknown>;
}

export interface BreakerCommandDefinition {
  lua: string;
  numberOfKeys?: number;
}

/**
 * The subset of the Redis client the breaker depends on.
 *
 * The seam is deliberately identical to `LedgerClient`: an existing ledger client is
 * structurally assignable, and library code never imports ioredis or reads `process.env`.
 */
export interface BreakerClient {
  defineCommand(name: string, definition: BreakerCommandDefinition): BreakerCommand;
  disconnect(): void;
}

/** One Redis key per (provider, model). */
export function breakerKey(target: BreakerTarget): string {
  return `br:${target.provider}:${target.model}`;
}

/** The sliding failure window for that target. */
export function breakerFailureKey(target: BreakerTarget): string {
  return `${breakerKey(target)}:f`;
}

/**
 * Decide whether the gate lets this call through.
 *
 * Pure: `nowMs` is passed in, never read from a clock. The Redis `allow` script mirrors
 * this function, reading its `nowMs` from Redis TIME so replicas agree.
 */
export function decideAllow(
  snapshot: BreakerSnapshot,
  nowMs: number,
  policy: BreakerPolicy,
): AllowDecision {
  switch (snapshot.state) {
    case 'closed':
      return { allowed: true, state: 'closed', probesUsed: snapshot.probesUsed };

    case 'open': {
      const elapsedMs = nowMs - snapshot.openedAtMs;
      if (elapsedMs >= policy.cooldownMs) {
        // Cooldown elapsed: transition and claim the first probe slot atomically.
        return { allowed: true, state: 'half_open', probesUsed: 1 };
      }
      return {
        allowed: false,
        state: 'open',
        retryAfterMs: Math.max(1, policy.cooldownMs - elapsedMs),
      };
    }

    case 'half_open': {
      // The probe slot is claimed. If it has been held for a whole cooldown, the probe
      // never reported back (a restart or a crash mid-probe): reclaim it instead of
      // denying this target forever.
      if (nowMs - snapshot.probeStartedAtMs >= policy.cooldownMs) {
        return { allowed: true, state: 'half_open', probesUsed: 1 };
      }

      if (snapshot.probesUsed < policy.probeLimit) {
        return { allowed: true, state: 'half_open', probesUsed: snapshot.probesUsed + 1 };
      }

      // A caller that honoured a zero hint would spin without pause. Cooldown is the
      // earliest moment the slot can be reclaimed.
      return { allowed: false, state: 'half_open', retryAfterMs: policy.cooldownMs };
    }
  }
}

/**
 * Apply one failure.
 *
 * `failureCountInWindow` is the ZSET count *including* this failure. The pure rule does
 * not own the window; the Redis script prunes by score and then passes the count in.
 */
export function afterFailure(
  snapshot: BreakerSnapshot,
  failureCountInWindow: number,
  nowMs: number,
  policy: BreakerPolicy,
): BreakerSnapshot {
  switch (snapshot.state) {
    case 'open':
      // A request that started before the trip failed after it: no-op.
      return snapshot;

    case 'half_open':
      // The probe failed: reopen with a fresh cooldown anchored at now.
      return { state: 'open', openedAtMs: nowMs, probesUsed: 0, probeStartedAtMs: 0 };

    case 'closed':
      if (failureCountInWindow >= policy.threshold) {
        return { state: 'open', openedAtMs: nowMs, probesUsed: 0, probeStartedAtMs: 0 };
      }
      return snapshot;
  }
}

/**
 * Apply one success.
 *
 * Only a half-open probe success closes the breaker. A success while OPEN is the
 * in-flight request that started before the trip landing late: it must not reopen the
 * gate. A success while CLOSED is a no-op; the failure window is sliding, so a success
 * never erases failures counted on another replica.
 */
export function afterSuccess(
  snapshot: BreakerSnapshot,
  _nowMs: number,
  _policy: BreakerPolicy,
): BreakerSnapshot {
  if (snapshot.state !== 'half_open') {
    return snapshot;
  }
  return { state: 'closed', openedAtMs: 0, probesUsed: 0, probeStartedAtMs: 0 };
}

type BreakerScriptName = 'allow' | 'recordFailure' | 'recordSuccess';

const SCRIPT_NAMES: readonly BreakerScriptName[] = ['allow', 'recordFailure', 'recordSuccess'];

/** Keeps all three Lua bodies in one asset; breaker.ts registers them separately. */
const SCRIPT_TAG = /^--@@script[ \t]+/m;

function isBreakerScriptName(value: string): value is BreakerScriptName {
  return (SCRIPT_NAMES as readonly string[]).includes(value);
}

/**
 * Split breaker.lua into exactly the three transition scripts.
 *
 * A missing, duplicated, or unknown marker is a build error, not a runtime surprise.
 */
function readScripts(): Record<BreakerScriptName, string> {
  const source = readFileSync(join(__dirname, 'breaker.lua'), 'utf8');
  const scripts: Partial<Record<BreakerScriptName, string>> = {};
  const chunks = source.split(SCRIPT_TAG);

  for (const chunk of chunks.slice(1)) {
    const newline = chunk.indexOf('\n');
    if (newline === -1) {
      throw new Error('breaker: a breaker.lua script marker has no body');
    }
    const name = chunk.slice(0, newline).replace(/\r$/, '').trim();
    if (!isBreakerScriptName(name)) {
      throw new Error(`breaker: unknown script "${name}" in breaker.lua`);
    }
    if (scripts[name] !== undefined) {
      throw new Error(`breaker: duplicate script "${name}" in breaker.lua`);
    }
    scripts[name] = chunk.slice(newline + 1).trim();
  }

  for (const name of SCRIPT_NAMES) {
    if (scripts[name] === undefined) {
      throw new Error(`breaker: breaker.lua is missing the "${name}" script`);
    }
  }

  return scripts as Record<BreakerScriptName, string>;
}

const SCRIPTS = readScripts();

const ALLOW_COMMAND = 'gatewayBreakerAllow';
const RECORD_FAILURE_COMMAND = 'gatewayBreakerRecordFailure';
const RECORD_SUCCESS_COMMAND = 'gatewayBreakerRecordSuccess';

/**
 * Build a Redis-backed breaker over an injected client.
 *
 * All state lives in Redis: this module keeps only the registered command handles. The
 * process is stateless, so any replica may serve any request.
 */
export function createBreaker(
  client: BreakerClient,
  options: Partial<BreakerPolicy> = {},
): Breaker {
  const policy: BreakerPolicy = {
    windowMs: options.windowMs ?? BREAKER_DEFAULTS.windowMs,
    threshold: options.threshold ?? BREAKER_DEFAULTS.threshold,
    cooldownMs: options.cooldownMs ?? BREAKER_DEFAULTS.cooldownMs,
    probeLimit: options.probeLimit ?? BREAKER_DEFAULTS.probeLimit,
  };
  assertPolicy(policy);

  let allowScript: BreakerCommand | undefined;
  let recordFailureScript: BreakerCommand | undefined;
  let recordSuccessScript: BreakerCommand | undefined;

  const allow = (): BreakerCommand => {
    allowScript ??= client.defineCommand(ALLOW_COMMAND, { lua: SCRIPTS.allow });
    return allowScript;
  };

  const recordFailure = (): BreakerCommand => {
    recordFailureScript ??= client.defineCommand(RECORD_FAILURE_COMMAND, {
      lua: SCRIPTS.recordFailure,
    });
    return recordFailureScript;
  };

  const recordSuccess = (): BreakerCommand => {
    recordSuccessScript ??= client.defineCommand(RECORD_SUCCESS_COMMAND, {
      lua: SCRIPTS.recordSuccess,
    });
    return recordSuccessScript;
  };

  return {
    async allow(target): Promise<AllowResult> {
      const key = breakerKey(assertTarget(target));
      const failureKey = breakerFailureKey(target);
      const reply = await allow()(
        2,
        key,
        failureKey,
        policy.windowMs,
        policy.cooldownMs,
        policy.probeLimit,
      );
      return parseAllowReply(reply);
    },

    async recordFailure(target): Promise<void> {
      const key = breakerKey(assertTarget(target));
      const failureKey = breakerFailureKey(target);
      await recordFailure()(
        2,
        key,
        failureKey,
        policy.windowMs,
        policy.threshold,
        policy.cooldownMs,
        randomUUID(),
      );
    },

    async recordSuccess(target): Promise<void> {
      const key = breakerKey(assertTarget(target));
      const failureKey = breakerFailureKey(target);
      await recordSuccess()(2, key, failureKey, policy.windowMs, policy.cooldownMs);
    },
  };
}

function assertTarget(target: BreakerTarget): BreakerTarget {
  if (target.provider.trim().length === 0) {
    throw new Error('breaker: target.provider must not be empty');
  }
  if (target.model.trim().length === 0) {
    throw new Error('breaker: target.model must not be empty');
  }
  return target;
}

function assertPolicy(policy: BreakerPolicy): void {
  assertPositiveInteger(policy.windowMs, 'windowMs');
  assertPositiveInteger(policy.threshold, 'threshold');
  assertNonNegativeInteger(policy.cooldownMs, 'cooldownMs');
  assertPositiveInteger(policy.probeLimit, 'probeLimit');
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`breaker: ${name} must be a positive integer (got ${value})`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`breaker: ${name} must be a non-negative integer (got ${value})`);
  }
}

function stateFromCode(code: number): BreakerState {
  switch (code) {
    case 0:
      return 'closed';
    case 1:
      return 'open';
    case 2:
      return 'half_open';
    default:
      throw new Error(`breaker: allow script returned unknown state code ${code}`);
  }
}

function parseAllowReply(reply: unknown): AllowResult {
  if (!Array.isArray(reply)) {
    throw new Error('breaker: allow script returned a non-array reply');
  }

  const values = reply as unknown[];
  const allowed = values[0];
  const stateCode = values[1];
  const retryAfterMs = values[2];

  if (
    typeof allowed !== 'number' ||
    typeof stateCode !== 'number' ||
    typeof retryAfterMs !== 'number' ||
    !Number.isFinite(retryAfterMs)
  ) {
    throw new Error('breaker: allow script returned a malformed reply');
  }

  if (allowed === 1) {
    return { allowed: true };
  }

  return {
    allowed: false,
    retryAfterMs: Math.max(0, Math.trunc(retryAfterMs)),
    state: stateFromCode(stateCode),
  };
}

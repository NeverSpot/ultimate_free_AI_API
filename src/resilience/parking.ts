import { LEDGER_WINDOW_MS } from '../limits/policy';
import type { ParkDecision } from './park-decision';

/** A parked credential id. The key namespace is deliberately distinct from `br:`. */
export function parkingKey(credentialId: string): string {
  return `cd:${credentialId}`;
}

export interface ParkingStatus {
  parked: boolean;
  /** Remaining park time in ms, taken from PTTL; zero when not parked. */
  retryAfterMs: number;
}

/** A Lua script registered on the client; args are forwarded verbatim to EVALSHA. */
export interface ParkingCommand {
  (...args: Array<string | number>): Promise<unknown>;
}

export interface ParkingCommandDefinition {
  lua: string;
  numberOfKeys?: number;
}

/**
 * The subset of the Redis client parking depends on.
 *
 * Same structural seam as the ledger and breaker: an existing `LedgerClient` is
 * assignable, and library code imports neither ioredis nor `process.env`.
 */
export interface ParkingClient {
  defineCommand(name: string, definition: ParkingCommandDefinition): ParkingCommand;
  disconnect(): void;
}

/** The four parking operations over one injected client. */
export interface Parking {
  park(credentialId: string, untilMs: number): Promise<void>;
  isParked(credentialId: string): Promise<ParkingStatus>;
  unpark(credentialId: string): Promise<void>;
  applyDecision(credentialId: string, decision: ParkDecision, now: number): Promise<void>;
}

/**
 * Store the absolute park expiry and derive the TTL from Redis TIME.
 *
 * `PTTL` is the source of truth for callers, so the TTL and the stored value are written
 * in one atomic step. A non-future expiry removes any existing park instead of creating
 * a key that is already dead.
 */
const PARK_LUA = `
local untilMs = tonumber(ARGV[1])
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ttl = untilMs - nowMs
if ttl < 1 then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('SET', KEYS[1], untilMs, 'PX', ttl)
return ttl
`;

/** PTTL is truth: a missing key (-2) or a key without expiry (-1) is not parked. */
const TTL_LUA = `
return redis.call('PTTL', KEYS[1])
`;

const UNPARK_LUA = `
return redis.call('DEL', KEYS[1])
`;

const PARK_COMMAND = 'gatewayParkingPark';
const TTL_COMMAND = 'gatewayParkingTtl';
const UNPARK_COMMAND = 'gatewayParkingUnpark';

/**
 * Build the parking operations over an injected client.
 *
 * Scripts are registered lazily, matching the ledger: no Redis round-trip happens until
 * the first park, read, or unpark.
 */
export function createParking(client: ParkingClient): Parking {
  let parkScript: ParkingCommand | undefined;
  let ttlScript: ParkingCommand | undefined;
  let unparkScript: ParkingCommand | undefined;

  const parkCommand = (): ParkingCommand => {
    parkScript ??= client.defineCommand(PARK_COMMAND, { lua: PARK_LUA });
    return parkScript;
  };

  const ttlCommand = (): ParkingCommand => {
    ttlScript ??= client.defineCommand(TTL_COMMAND, { lua: TTL_LUA });
    return ttlScript;
  };

  const unparkCommand = (): ParkingCommand => {
    unparkScript ??= client.defineCommand(UNPARK_COMMAND, { lua: UNPARK_LUA });
    return unparkScript;
  };

  const parkCredential = async (credentialId: string, untilMs: number): Promise<void> => {
    assertCredentialId(credentialId);
    if (!Number.isFinite(untilMs)) {
      throw new Error(`parking: untilMs must be finite (got ${untilMs})`);
    }
    await parkCommand()(1, parkingKey(credentialId), untilMs);
  };

  const readParked = async (credentialId: string): Promise<ParkingStatus> => {
    assertCredentialId(credentialId);
    const reply = await ttlCommand()(1, parkingKey(credentialId));
    const ttl = typeof reply === 'number' && Number.isFinite(reply) ? reply : -2;
    if (ttl > 0) {
      return { parked: true, retryAfterMs: ttl };
    }
    return { parked: false, retryAfterMs: 0 };
  };

  const unparkCredential = async (credentialId: string): Promise<void> => {
    assertCredentialId(credentialId);
    await unparkCommand()(1, parkingKey(credentialId));
  };

  const apply = async (
    credentialId: string,
    decision: ParkDecision,
    now: number,
  ): Promise<void> => {
    assertCredentialId(credentialId);
    if (!Number.isFinite(now)) {
      throw new Error(`parking: now must be finite (got ${now})`);
    }
    if (decision.action === 'retry') {
      return;
    }

    const waitMs = Number.isFinite(decision.waitMs) ? decision.waitMs : LEDGER_WINDOW_MS.rpw;
    // `upstream` / `timeout` decisions carry waitMs 0: the breaker owns that cooldown,
    // not parking. Writing a park for 0 would race Redis TIME against the host clock and
    // park a healthy credential for the size of the skew. Only a positive wait parks.
    if (waitMs <= 0) {
      return;
    }
    await parkCredential(credentialId, now + waitMs);
  };

  return {
    park: parkCredential,
    isParked: readParked,
    unpark: unparkCredential,
    applyDecision: apply,
  };
}

let defaultParking: Parking | undefined;

/**
 * Bind the module-level helpers to one client.
 *
 * `createParking` is the explicit seam; this exists because the plan's parking API takes
 * only a credential id. Call it once at composition time.
 */
export function configureParking(client: ParkingClient): void {
  defaultParking = createParking(client);
}

/** Park one credential until an absolute time. No `br:` key is ever touched. */
export async function park(credentialId: string, untilMs: number): Promise<void> {
  await requireParking().park(credentialId, untilMs);
}

/** Report whether a credential is parked and, if so, how long PTTL says is left. */
export async function isParked(credentialId: string): Promise<ParkingStatus> {
  return requireParking().isParked(credentialId);
}

/** Remove a park immediately. */
export async function unpark(credentialId: string): Promise<void> {
  await requireParking().unpark(credentialId);
}

/**
 * Consume the pure `ParkDecision` from `park-decision.ts`.
 *
 * `retry` writes nothing. `park` sets `now + waitMs` only when the wait is strictly
 * positive: `upstream` / `timeout` decisions carry zero because the breaker owns that
 * cooldown, and a zero-wait park would park a healthy credential for the host/Redis clock
 * skew. A non-finite waitMs (`Infinity` means "never this run", e.g. auth or model_gone)
 * is capped at the longest horizon the gateway knows, the weekly ledger window, so a
 * rotated key recovers itself.
 */
export async function applyDecision(
  credentialId: string,
  decision: ParkDecision,
  now: number,
): Promise<void> {
  await requireParking().applyDecision(credentialId, decision, now);
}

function requireParking(): Parking {
  if (defaultParking === undefined) {
    throw new Error('parking: call configureParking(client) before using the module helpers');
  }
  return defaultParking;
}

function assertCredentialId(credentialId: string): void {
  if (credentialId.trim().length === 0) {
    throw new Error('parking: credentialId must not be empty');
  }
}

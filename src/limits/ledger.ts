import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LimitPolicy, Window } from './policy';
import { LEDGER_WINDOW_MS, enforcedWindows } from './policy';
import type { LedgerClient, LedgerCommand } from './redis';

const RESERVE_LUA = readFileSync(join(__dirname, 'ledger.lua'), 'utf8');

/**
 * Shared adjustment script for `release` and `commit`.
 *
 * ARGV holds one signed delta per key. A positive delta increases usage, a negative one
 * decreases it, and the result is clamped at zero. Missing keys are never created and
 * `KEEPTTL` preserves whatever expiry the key already has.
 */
const ADJUST_LUA = `
for i = 1, #KEYS do
  local delta = tonumber(ARGV[i])
  if delta ~= nil and redis.call('EXISTS', KEYS[i]) == 1 then
    local current = tonumber(redis.call('GET', KEYS[i])) or 0
    local nextValue = current + delta
    if nextValue < 0 then
      nextValue = 0
    end
    redis.call('SET', KEYS[i], nextValue, 'KEEPTTL')
  end
end
return 1
`;

const RESERVE_COMMAND = 'gatewayLedgerReserve';
const ADJUST_COMMAND = 'gatewayLedgerAdjust';

/** One Redis key per (credential, model, window). */
export function reservationKey(credentialId: string, modelId: string, window: Window): string {
  return `rl:${credentialId}:${modelId}:${window}`;
}

export interface Reservation {
  credentialId: string;
  modelId: string;
  cost: number;
  reserved: Array<{ window: Window; key: string; amount: number }>;
}

export type ReserveResult =
  { ok: true; reservation: Reservation } | { ok: false; retryAfterMs: number; window: Window };

export interface Ledger {
  reserve(input: {
    credentialId: string;
    modelId: string;
    policy: LimitPolicy;
    cost?: number;
  }): Promise<ReserveResult>;
  release(reservation: Reservation): Promise<void>;
  commit(reservation: Reservation, actualCost: number): Promise<void>;
}

/**
 * Build the ledger over an injected client.
 *
 * Scripts are registered lazily: a policy with no enforced windows must not touch Redis
 * at all, not even to define a command.
 */
export function createLedger(
  client: LedgerClient,
  options: { windowMs?: Partial<Record<Window, number>> } = {},
): Ledger {
  const windowMs: Record<Window, number> = {
    rpm: options.windowMs?.rpm ?? LEDGER_WINDOW_MS.rpm,
    rpd: options.windowMs?.rpd ?? LEDGER_WINDOW_MS.rpd,
    rpw: options.windowMs?.rpw ?? LEDGER_WINDOW_MS.rpw,
  };

  let reserveScript: LedgerCommand | undefined;
  let adjustScript: LedgerCommand | undefined;

  const reserve = (): LedgerCommand => {
    reserveScript ??= client.defineCommand(RESERVE_COMMAND, { lua: RESERVE_LUA });
    return reserveScript;
  };

  const adjust = (): LedgerCommand => {
    adjustScript ??= client.defineCommand(ADJUST_COMMAND, { lua: ADJUST_LUA });
    return adjustScript;
  };

  return {
    async reserve({ credentialId, modelId, policy, cost = 1 }): Promise<ReserveResult> {
      const amount = assertPositiveInteger(cost, 'cost');
      const windows = enforcedWindows(policy);

      if (windows.length === 0) {
        return {
          ok: true,
          reservation: { credentialId, modelId, cost: amount, reserved: [] },
        };
      }

      const limits = windows.map((window) => positiveCeiling(policy, window));
      const reserved = windows.map((window) => ({
        window,
        key: reservationKey(credentialId, modelId, window),
        amount,
      }));
      const keys = reserved.map((entry) => entry.key);
      const ttls = windows.map((window) => windowMs[window]);

      const reply = parseReserveReply(
        await reserve()(keys.length, ...keys, amount, ...limits, ...ttls),
      );

      if (reply.ok === 1) {
        return { ok: true, reservation: { credentialId, modelId, cost: amount, reserved } };
      }

      const blockingWindow = windows[reply.index - 1];
      if (blockingWindow === undefined) {
        throw new Error(
          `ledger: reserve script returned window index ${reply.index} of ${windows.length}`,
        );
      }

      return { ok: false, retryAfterMs: reply.waitMs, window: blockingWindow };
    },

    async release(reservation): Promise<void> {
      if (reservation.reserved.length === 0) {
        return;
      }

      const keys = reservation.reserved.map((entry) => entry.key);
      const deltas = reservation.reserved.map((entry) => -entry.amount);
      await adjust()(keys.length, ...keys, ...deltas);
    },

    async commit(reservation, actualCost): Promise<void> {
      const actual = assertNonNegativeInteger(actualCost, 'actualCost');
      if (reservation.reserved.length === 0) {
        return;
      }

      const delta = actual - reservation.cost;
      if (delta === 0) {
        return;
      }

      const keys = reservation.reserved.map((entry) => entry.key);
      const deltas = reservation.reserved.map(() => delta);
      await adjust()(keys.length, ...keys, ...deltas);
    },
  };
}

function positiveCeiling(policy: LimitPolicy, window: Window): number {
  const ceiling = policy[window];
  if (typeof ceiling !== 'number' || ceiling <= 0) {
    throw new Error(`ledger: enforced window "${window}" has no positive ceiling`);
  }
  return ceiling;
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ledger: ${name} must be a positive integer (got ${value})`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ledger: ${name} must be a non-negative integer (got ${value})`);
  }
  return value;
}

function parseReserveReply(reply: unknown): { ok: number; index: number; waitMs: number } {
  if (!Array.isArray(reply)) {
    throw new Error('ledger: reserve script returned a non-array reply');
  }

  const values = reply as unknown[];
  const ok = values[0];
  const index = values[1];
  const waitMs = values[2];

  if (typeof ok !== 'number' || typeof index !== 'number' || typeof waitMs !== 'number') {
    throw new Error('ledger: reserve script returned a malformed reply');
  }

  return { ok, index, waitMs };
}

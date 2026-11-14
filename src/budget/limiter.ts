import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbExecutor } from '../db/client';

const RESERVE_LUA = readFileSync(join(__dirname, 'reserve.lua'), 'utf8');
const BUDGET_COMMAND = 'gatewayBudgetScript';

export interface BudgetSnapshot {
  userId: string;
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
}

export type BudgetReserveResult =
  | {
      ok: true;
      reservationId: string;
      reservedUsd: number;
      remainingUsd: number;
      capUsd: number;
    }
  | {
      ok: false;
      remainingUsd: number;
      capUsd: number;
      reason: string;
    };

export interface BudgetReconcileResult {
  ok: boolean;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
}

export interface BudgetReleaseResult {
  ok: boolean;
  releasedUsd: number;
  reservedUsd: number;
  remainingUsd: number;
}

export interface SetBudgetInput {
  capUsd: number;
  period?: string;
  spentUsd?: number;
  reservedUsd?: number;
  resetAt?: Date | null;
}

export interface BudgetLimiter {
  reserve(userId: string, worstCaseUsd: number): Promise<BudgetReserveResult>;
  reconcile(
    userId: string,
    reservationId: string,
    actualUsd: number,
  ): Promise<BudgetReconcileResult>;
  release(userId: string, reservationId: string): Promise<BudgetReleaseResult>;
  getBudget(userId: string): Promise<BudgetSnapshot | null>;
  setBudget(userId: string, budget: SetBudgetInput): Promise<void>;
  resetBudget(userId: string): Promise<void>;
}

export interface BudgetRedisCommand {
  (...args: Array<string | number>): Promise<unknown>;
}

export interface BudgetRedisClient {
  defineCommand(
    name: string,
    definition: { lua: string; numberOfKeys?: number },
  ): BudgetRedisCommand;
  disconnect?(): void;
}

export interface BudgetLimiterOptions {
  dbClient?: DbExecutor;
  defaultCapUsd?: number;
  reservationTtlSec?: number;
}

export function roundUsd(val: number): number {
  return Math.round(val * 1e6) / 1e6;
}

export function budgetUserKey(userId: string): string {
  return `budget:user:${userId}`;
}

export function budgetReservationKey(userId: string, reservationId: string): string {
  return `budget:res:${userId}:${reservationId}`;
}

/**
 * Block 35: hard ceiling on a reservation against an org's monthly spend cap.
 * Fail-open: a missing or unreadable `org_spend_caps` table never blocks dispatch.
 */
export async function checkOrgCap(
  dbClient: DbExecutor,
  orgId: string,
  worstCaseUsd: number,
): Promise<{ allowed: boolean; capUsd?: number; reason?: string }> {
  try {
    const { rows } = await dbClient.query<{ cap_usd: string | number }>(
      'select cap_usd from org_spend_caps where org_id = $1 and period = $2 limit 1',
      [orgId, 'monthly'],
    );
    const row = rows[0];
    if (!row) {
      return { allowed: true };
    }
    const cap = Number(row.cap_usd);
    if (Number.isFinite(cap) && worstCaseUsd > cap) {
      return { allowed: false, capUsd: cap, reason: 'org_cap_exceeded' };
    }
    return { allowed: true, capUsd: cap };
  } catch {
    return { allowed: true };
  }
}

/**
 * Real Redis-backed budget limiter using atomic Lua scripts.
 */
export function createBudgetLimiter(
  client: BudgetRedisClient,
  options: BudgetLimiterOptions = {},
): BudgetLimiter {
  const { dbClient, defaultCapUsd = -1, reservationTtlSec = 300 } = options;

  let script: BudgetRedisCommand | undefined;
  const getScript = (): BudgetRedisCommand => {
    script ??= client.defineCommand(BUDGET_COMMAND, { lua: RESERVE_LUA });
    return script;
  };

  const limiter: BudgetLimiter = {
    async reserve(userId: string, worstCaseUsd: number): Promise<BudgetReserveResult> {
      if (worstCaseUsd < 0) {
        throw new Error('worstCaseUsd must be non-negative');
      }

      const reservationId = `res_${randomUUID()}`;
      const uKey = budgetUserKey(userId);
      const rKey = budgetReservationKey(userId, reservationId);

      const runReserve = async (): Promise<BudgetReserveResult> => {
        const raw = (await getScript()(
          2,
          uKey,
          rKey,
          'reserve',
          worstCaseUsd,
          reservationId,
          reservationTtlSec,
          defaultCapUsd,
        )) as [number, string, string, string, string];

        const [ok, remainingStr, capStr, _reservedStr, detail] = raw;

        if (ok === 1) {
          // Block 35: team-level spend cap — hard ceiling checked before the
          // reservation is confirmed. Fail-open: if org-membership infra is
          // absent (Block 34 not merged yet) or the DB is unreachable, the
          // user-budget reservation stands.
          if (dbClient) {
            let orgId: string | null = null;
            try {
              const orgRow = await dbClient.query<{ org_id: string }>(
                'select org_id from org_members where user_id = $1 limit 1',
                [userId],
              );
              orgId = orgRow.rows[0]?.org_id ?? null;
            } catch {
              // org_members table not present yet; no org cap to enforce.
            }
            if (orgId !== null) {
              const capCheck = await checkOrgCap(dbClient, orgId, worstCaseUsd);
              if (!capCheck.allowed) {
                return {
                  ok: false,
                  remainingUsd: 0,
                  capUsd: capCheck.capUsd ?? 0,
                  reason: capCheck.reason ?? 'org_cap_exceeded',
                };
              }
            }
          }

          return {
            ok: true,
            reservationId,
            reservedUsd: worstCaseUsd,
            remainingUsd: parseFloat(remainingStr),
            capUsd: parseFloat(capStr),
          };
        }

        if (detail === 'no_budget' && dbClient) {
          // Check Postgres spend_budgets table
          const dbRow = await dbClient.query<{
            cap_usd: string | number;
            spent_usd: string | number;
            reserved_usd: string | number;
          }>(
            'select cap_usd, spent_usd, reserved_usd from spend_budgets where user_id = $1 limit 1',
            [userId],
          );

          if (dbRow.rows.length > 0) {
            const row = dbRow.rows[0]!;
            const cap = Number(row.cap_usd);
            const spent = Number(row.spent_usd);
            const reserved = Number(row.reserved_usd);

            // Hydrate Redis
            await limiter.setBudget(userId, {
              capUsd: cap,
              spentUsd: spent,
              reservedUsd: reserved,
            });

            // Retry reservation once
            const retryRaw = (await getScript()(
              2,
              uKey,
              rKey,
              'reserve',
              worstCaseUsd,
              reservationId,
              reservationTtlSec,
              defaultCapUsd,
            )) as [number, string, string, string, string];

            if (retryRaw[0] === 1) {
              return {
                ok: true,
                reservationId,
                reservedUsd: worstCaseUsd,
                remainingUsd: parseFloat(retryRaw[1]),
                capUsd: parseFloat(retryRaw[2]),
              };
            }

            return {
              ok: false,
              remainingUsd: parseFloat(retryRaw[1]),
              capUsd: parseFloat(retryRaw[2]),
              reason: retryRaw[4] === 'budget_exceeded' ? 'Spend budget cap exceeded' : retryRaw[4],
            };
          }
        }

        return {
          ok: false,
          remainingUsd: parseFloat(remainingStr || '0'),
          capUsd: parseFloat(capStr || '0'),
          reason: detail === 'budget_exceeded' ? 'Spend budget cap exceeded' : detail,
        };
      };

      return runReserve();
    },

    async reconcile(
      userId: string,
      reservationId: string,
      actualUsd: number,
    ): Promise<BudgetReconcileResult> {
      const uKey = budgetUserKey(userId);
      const rKey = budgetReservationKey(userId, reservationId);

      const raw = (await getScript()(2, uKey, rKey, 'reconcile', reservationId, actualUsd)) as [
        number,
        string,
        string,
        string,
        string,
      ];

      const [, remainingStr, spentStr, reservedStr, releasedReservedStr] = raw;
      const releasedAmount = parseFloat(releasedReservedStr || '0');

      if (dbClient) {
        try {
          await dbClient.query(
            'update spend_budgets set spent_usd = spent_usd + $1, reserved_usd = greatest(0, reserved_usd - $2) where user_id = $3',
            [actualUsd, releasedAmount, userId],
          );
        } catch {
          // Telemetry/db failure should not fail budget reconciliation
        }
      }

      return {
        ok: true,
        remainingUsd: parseFloat(remainingStr),
        spentUsd: parseFloat(spentStr),
        reservedUsd: parseFloat(reservedStr),
      };
    },

    async release(userId: string, reservationId: string): Promise<BudgetReleaseResult> {
      const uKey = budgetUserKey(userId);
      const rKey = budgetReservationKey(userId, reservationId);

      const raw = (await getScript()(2, uKey, rKey, 'release', reservationId)) as [
        number,
        string,
        string,
        string,
        string,
      ];

      const [, remainingStr, , reservedStr, releasedReservedStr] = raw;
      const releasedAmount = parseFloat(releasedReservedStr || '0');

      if (dbClient) {
        try {
          await dbClient.query(
            'update spend_budgets set reserved_usd = greatest(0, reserved_usd - $1) where user_id = $2',
            [releasedAmount, userId],
          );
        } catch {
          // Ignore db errors on release
        }
      }

      return {
        ok: true,
        releasedUsd: releasedAmount,
        remainingUsd: parseFloat(remainingStr),
        reservedUsd: parseFloat(reservedStr),
      };
    },

    async getBudget(userId: string): Promise<BudgetSnapshot | null> {
      const uKey = budgetUserKey(userId);
      const raw = (await getScript()(1, uKey, 'get')) as [number, string, string, string, string];

      if (raw[0] === 1) {
        return {
          userId,
          remainingUsd: parseFloat(raw[1]),
          capUsd: parseFloat(raw[2]),
          spentUsd: parseFloat(raw[3]),
          reservedUsd: parseFloat(raw[4]),
        };
      }

      if (dbClient) {
        const dbRow = await dbClient.query<{
          cap_usd: string | number;
          spent_usd: string | number;
          reserved_usd: string | number;
        }>(
          'select cap_usd, spent_usd, reserved_usd from spend_budgets where user_id = $1 limit 1',
          [userId],
        );

        if (dbRow.rows.length > 0) {
          const row = dbRow.rows[0]!;
          const cap = Number(row.cap_usd);
          const spent = Number(row.spent_usd);
          const reserved = Number(row.reserved_usd);

          await limiter.setBudget(userId, { capUsd: cap, spentUsd: spent, reservedUsd: reserved });

          return {
            userId,
            capUsd: cap,
            spentUsd: spent,
            reservedUsd: reserved,
            remainingUsd: cap - (spent + reserved),
          };
        }
      }

      return null;
    },

    async setBudget(userId: string, budget: SetBudgetInput): Promise<void> {
      const uKey = budgetUserKey(userId);
      await getScript()(
        1,
        uKey,
        'set',
        budget.capUsd,
        budget.spentUsd ?? 0,
        budget.reservedUsd ?? 0,
      );

      if (dbClient) {
        await dbClient.query(
          `insert into spend_budgets (user_id, cap_usd, period, reserved_usd, spent_usd, reset_at)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (user_id) do update set
             cap_usd = excluded.cap_usd,
             period = excluded.period,
             reserved_usd = excluded.reserved_usd,
             spent_usd = excluded.spent_usd,
             reset_at = excluded.reset_at`,
          [
            userId,
            budget.capUsd,
            budget.period ?? 'monthly',
            budget.reservedUsd ?? 0,
            budget.spentUsd ?? 0,
            budget.resetAt ?? null,
          ],
        );
      }
    },

    async resetBudget(userId: string): Promise<void> {
      const uKey = budgetUserKey(userId);
      await getScript()(1, uKey, 'reset');

      if (dbClient) {
        await dbClient.query(
          'update spend_budgets set spent_usd = 0, reserved_usd = 0 where user_id = $1',
          [userId],
        );
      }
    },
  };

  return limiter;
}

/**
 * Pure in-memory budget limiter for fast, hermetic unit tests.
 */
export function createMemoryBudgetLimiter(
  options: {
    defaultCapUsd?: number;
    initialBudgets?: Map<string, SetBudgetInput>;
  } = {},
): BudgetLimiter {
  const budgets = new Map<
    string,
    {
      capUsd: number;
      period: string;
      spentUsd: number;
      reservedUsd: number;
      resetAt?: Date | null;
    }
  >();

  const reservations = new Map<
    string,
    {
      userId: string;
      amount: number;
    }
  >();

  if (options.initialBudgets) {
    for (const [userId, input] of options.initialBudgets.entries()) {
      budgets.set(userId, {
        capUsd: input.capUsd,
        period: input.period ?? 'monthly',
        spentUsd: input.spentUsd ?? 0,
        reservedUsd: input.reservedUsd ?? 0,
        resetAt: input.resetAt ?? null,
      });
    }
  }

  const limiter: BudgetLimiter = {
    async reserve(userId: string, worstCaseUsd: number): Promise<BudgetReserveResult> {
      let b = budgets.get(userId);
      if (!b) {
        if (options.defaultCapUsd !== undefined && options.defaultCapUsd >= 0) {
          b = {
            capUsd: options.defaultCapUsd,
            period: 'monthly',
            spentUsd: 0,
            reservedUsd: 0,
          };
          budgets.set(userId, b);
        } else {
          return {
            ok: false,
            remainingUsd: 0,
            capUsd: 0,
            reason: 'no_budget',
          };
        }
      }

      const remaining = roundUsd(b.capUsd - (b.spentUsd + b.reservedUsd));
      if (b.spentUsd + b.reservedUsd + worstCaseUsd - b.capUsd > 1e-9) {
        return {
          ok: false,
          remainingUsd: Math.max(0, remaining),
          capUsd: b.capUsd,
          reason: 'Spend budget cap exceeded',
        };
      }

      b.reservedUsd = roundUsd(b.reservedUsd + worstCaseUsd);
      const reservationId = `res_${randomUUID()}`;
      reservations.set(reservationId, { userId, amount: worstCaseUsd });

      return {
        ok: true,
        reservationId,
        reservedUsd: worstCaseUsd,
        remainingUsd: roundUsd(b.capUsd - (b.spentUsd + b.reservedUsd)),
        capUsd: b.capUsd,
      };
    },

    async reconcile(
      userId: string,
      reservationId: string,
      actualUsd: number,
    ): Promise<BudgetReconcileResult> {
      const b = budgets.get(userId);
      const res = reservations.get(reservationId);
      const reservedAmount = res ? res.amount : 0;
      reservations.delete(reservationId);

      if (!b) {
        return { ok: true, spentUsd: 0, reservedUsd: 0, remainingUsd: 0 };
      }

      b.spentUsd = roundUsd(b.spentUsd + actualUsd);
      b.reservedUsd = roundUsd(Math.max(0, b.reservedUsd - reservedAmount));

      return {
        ok: true,
        spentUsd: b.spentUsd,
        reservedUsd: b.reservedUsd,
        remainingUsd: roundUsd(b.capUsd - (b.spentUsd + b.reservedUsd)),
      };
    },

    async release(userId: string, reservationId: string): Promise<BudgetReleaseResult> {
      const b = budgets.get(userId);
      const res = reservations.get(reservationId);
      const reservedAmount = res ? res.amount : 0;
      reservations.delete(reservationId);

      if (!b) {
        return { ok: true, releasedUsd: 0, reservedUsd: 0, remainingUsd: 0 };
      }

      b.reservedUsd = roundUsd(Math.max(0, b.reservedUsd - reservedAmount));

      return {
        ok: true,
        releasedUsd: reservedAmount,
        reservedUsd: b.reservedUsd,
        remainingUsd: roundUsd(b.capUsd - (b.spentUsd + b.reservedUsd)),
      };
    },

    async getBudget(userId: string): Promise<BudgetSnapshot | null> {
      const b = budgets.get(userId);
      if (!b) {
        return null;
      }
      return {
        userId,
        capUsd: b.capUsd,
        spentUsd: b.spentUsd,
        reservedUsd: b.reservedUsd,
        remainingUsd: roundUsd(b.capUsd - (b.spentUsd + b.reservedUsd)),
      };
    },

    async setBudget(userId: string, budget: SetBudgetInput): Promise<void> {
      budgets.set(userId, {
        capUsd: budget.capUsd,
        period: budget.period ?? 'monthly',
        spentUsd: budget.spentUsd ?? 0,
        reservedUsd: budget.reservedUsd ?? 0,
        resetAt: budget.resetAt ?? null,
      });
    },

    async resetBudget(userId: string): Promise<void> {
      const b = budgets.get(userId);
      if (b) {
        b.spentUsd = 0;
        b.reservedUsd = 0;
      }
    },
  };

  return limiter;
}

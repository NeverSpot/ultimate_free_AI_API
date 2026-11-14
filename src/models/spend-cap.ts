import { createDbClient, type DbClient } from '../db/client';

export type SpendCapPeriod = 'daily' | 'monthly';

export interface SpendCap {
  orgId: string;
  capUsd: number;
  period: SpendCapPeriod;
  createdAt: Date;
}

interface SpendCapRow {
  org_id: string;
  cap_usd: string; // pg `numeric` arrives as a string
  period: string;
  created_at: Date;
}

/**
 * Build a pooled client from the explicit connection string at the edge.
 *
 * Reads `DATABASE_URL` only inside this function (never at module top level)
 * so importing this module stays hermetic when the env var is absent.
 */
function spendCapDb(): DbClient {
  const connectionString = process.env.DATABASE_URL?.trim() ?? '';
  if (connectionString.length === 0) {
    throw new Error('spend-cap: DATABASE_URL is required');
  }
  return createDbClient(connectionString);
}

export async function getSpendCap(
  orgId: string,
  period: SpendCapPeriod = 'monthly',
): Promise<SpendCap | null> {
  const db = spendCapDb();
  try {
    const { rows } = await db.query<SpendCapRow>(
      `select org_id, cap_usd, period, created_at
       from org_spend_caps
       where org_id = $1 and period = $2
       limit 1`,
      [orgId, period],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      orgId: row.org_id,
      capUsd: Number(row.cap_usd),
      period: row.period as SpendCapPeriod,
      createdAt: row.created_at,
    };
  } finally {
    await db.close();
  }
}

export async function setSpendCap(
  orgId: string,
  capUsd: number,
  period: SpendCapPeriod,
): Promise<SpendCap> {
  const db = spendCapDb();
  try {
    const { rows } = await db.query<SpendCapRow>(
      `insert into org_spend_caps (org_id, cap_usd, period)
       values ($1, $2, $3)
       on conflict (org_id, period) do update set cap_usd = excluded.cap_usd
       returning org_id, cap_usd, period, created_at`,
      [orgId, capUsd, period],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('setSpendCap: no row returned');
    }
    return {
      orgId: row.org_id,
      capUsd: Number(row.cap_usd),
      period: row.period as SpendCapPeriod,
      createdAt: row.created_at,
    };
  } finally {
    await db.close();
  }
}

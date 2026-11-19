import type { DbExecutor } from '../db/client';

/**
 * Usage attributed to one user over a rolling window.
 *
 * Attribution is by `requests.credential_id`: a gateway-key request may use only
 * the caller's own provider keys, and those rows carry the user id. Requests made
 * with host-level environment credentials have no credential row and are
 * deliberately excluded.
 */
export interface UsageSummary {
  window_days: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  /** Terminal requests that needed more than one provider attempt. */
  failovers: number;
  last_request_at: string | null;
}

export interface UsageModel {
  getUsage(userId: string, windowDays?: number): Promise<UsageSummary>;
}

interface UsageRow {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | string;
  failovers: number;
  last_request_at: Date | string | null;
}

const DEFAULT_WINDOW_DAYS = 30;

/** Counts and token sums for the signed-in user. Read-only: no state to reconcile. */
export function createUsageModel(db: DbExecutor): UsageModel {
  async function getUsage(userId: string, windowDays = DEFAULT_WINDOW_DAYS): Promise<UsageSummary> {
    const days = Math.max(1, Math.min(365, Math.trunc(windowDays)));
    const result = await db.query<UsageRow>(
      `select
         count(*)::int as requests,
         coalesce(sum(r.prompt_tokens), 0)::int as prompt_tokens,
         coalesce(sum(r.completion_tokens), 0)::int as completion_tokens,
         coalesce(sum(r.cost_usd), 0)::float8 as cost_usd,
         count(*) filter (where r.attempt_count > 1)::int as failovers,
         max(r.created_at) as last_request_at
       from requests r
       join user_provider_keys k on k.id = r.credential_id
       where k.user_id = $1
         and r.created_at >= now() - make_interval(days => $2::int)`,
      [userId, days],
    );

    const row = result.rows[0];
    const promptTokens = row?.prompt_tokens ?? 0;
    const completionTokens = row?.completion_tokens ?? 0;

    return {
      window_days: days,
      requests: row?.requests ?? 0,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      cost_usd: Number(row?.cost_usd ?? 0),
      failovers: row?.failovers ?? 0,
      last_request_at: toIso(row?.last_request_at ?? null),
    };
  }

  return { getUsage };
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

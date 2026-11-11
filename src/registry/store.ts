import type { DbClient, DbExecutor } from '../db/client';
import type { ModelInfo, ProviderId } from '../providers/types';

/**
 * A discovered model as it is written to Postgres.
 *
 * `is_free` stays nullable because `null` means "unknown" (NVIDIA NIM never reports
 * it), which is a different fact from "not free". Coercing it to false here would
 * make the database lie, and every consumer downstream would inherit the lie.
 */
export interface ModelWriteRow {
  provider: ProviderId;
  model_id: string;
  context_window: number | null;
  is_free: boolean | null;
  owned_by: string | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
  rpd_limit: number | null;
  healthy: boolean;
  checked_at: Date;
}

/** One stored model, camelCased so callers never see column names. */
export interface ModelRecord {
  provider: ProviderId;
  modelId: string;
  contextWindow: number | null;
  isFree: boolean | null;
  ownedBy: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  rpdLimit: number | null;
  healthy: boolean;
  checkedAt: Date;
}

/** Per-provider rollup straight from the table. */
export interface ProviderSummary {
  provider: ProviderId;
  models: number;
  free: number;
  unknown: number;
  healthy: number;
  checkedAt: Date | null;
}

interface ModelDbRow {
  provider: ProviderId;
  model_id: string;
  context_window: number | null;
  is_free: boolean | null;
  owned_by: string | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
  rpd_limit: number | null;
  healthy: boolean;
  checked_at: Date;
}

interface SummaryDbRow {
  provider: ProviderId;
  models: number;
  free: number;
  unknown_count: number;
  healthy: number;
  checked_at: Date | null;
}

const SELECT_COLUMNS = `
  provider,
  model_id,
  context_window,
  is_free,
  owned_by,
  rpm_limit,
  tpm_limit,
  rpd_limit,
  healthy,
  checked_at
`;

/**
 * One statement for the whole batch: the payload is a single JSON parameter, so there
 * is no 65535-parameter ceiling and no dynamic SQL assembly.
 *
 * Discovery owns the catalog columns, so those are updated on conflict. `healthy`,
 * `rpm_limit`, `tpm_limit` and `rpd_limit` are deliberately *not* touched: they are
 * runtime facts (chat outcomes, Block 6 ledger), and a refresh must not reset them to
 * their insert-time defaults.
 */
const UPSERT_SQL = `
  insert into models (${SELECT_COLUMNS})
  select ${SELECT_COLUMNS}
  from jsonb_to_recordset($1::jsonb) as x(
    provider text,
    model_id text,
    context_window int,
    is_free boolean,
    owned_by text,
    rpm_limit int,
    tpm_limit int,
    rpd_limit int,
    healthy boolean,
    checked_at timestamptz
  )
  on conflict (provider, model_id) do update set
    context_window = excluded.context_window,
    is_free = excluded.is_free,
    owned_by = excluded.owned_by,
    checked_at = excluded.checked_at
`;

/**
 * Normalise discovered models into table rows. Pure: no clock, no I/O.
 *
 * A late duplicate for the same `(provider, model_id)` replaces the earlier one
 * rather than aborting the batch — Postgres rejects an `ON CONFLICT` statement that
 * would touch the same row twice, and one adapter emitting the same id twice must
 * not take the whole sync down.
 */
export function toModelRows(models: readonly ModelInfo[], checkedAt: Date): ModelWriteRow[] {
  const byKey = new Map<string, ModelWriteRow>();

  for (const model of models) {
    if (model.provider === undefined || model.provider.length === 0) {
      throw new Error(`toModelRows: model "${model.id}" has no provider`);
    }

    byKey.set(`${model.provider}\u0000${model.id}`, {
      provider: model.provider,
      model_id: model.id,
      context_window: model.context_window ?? null,
      // Written explicitly rather than with `??`: `null` (unknown) and `false` (paid)
      // are different facts and only `undefined` may collapse into unknown.
      is_free: model.is_free === undefined ? null : model.is_free,
      owned_by: model.owned_by ?? null,
      rpm_limit: null,
      tpm_limit: null,
      rpd_limit: null,
      healthy: true,
      checked_at: checkedAt,
    });
  }

  return [...byKey.values()];
}

/**
 * Upsert a discovery batch in one transaction.
 *
 * Every row carries the same `checked_at`, the timestamp of the refresh that produced
 * it. Rows belonging to providers absent from `models` are not mentioned at all, which
 * is what makes last-known-good work: a failed provider keeps every old row and its
 * stale `checked_at` instead of losing its catalog.
 */
export async function upsertModels(
  client: DbClient,
  models: readonly ModelInfo[],
  checkedAt: Date,
): Promise<number> {
  const rows = toModelRows(models, checkedAt);
  if (rows.length === 0) {
    return 0;
  }

  const payload = JSON.stringify(
    rows.map((row) => ({ ...row, checked_at: row.checked_at.toISOString() })),
  );

  return client.transaction(async (tx) => {
    await tx.query(UPSERT_SQL, [payload]);
    return rows.length;
  });
}

/** Read the whole catalog in deterministic order. */
export async function listModels(client: DbExecutor): Promise<ModelRecord[]> {
  const result = await client.query<ModelDbRow>(
    `select ${SELECT_COLUMNS} from models order by provider, model_id`,
  );

  return result.rows.map((row) => ({
    provider: row.provider,
    modelId: row.model_id,
    contextWindow: row.context_window,
    isFree: row.is_free,
    ownedBy: row.owned_by,
    rpmLimit: row.rpm_limit,
    tpmLimit: row.tpm_limit,
    rpdLimit: row.rpd_limit,
    healthy: row.healthy,
    checkedAt: row.checked_at,
  }));
}

/**
 * Per-provider counts, ordered by provider.
 *
 * `unknown` counts `is_free is null` explicitly: a summary that folded unknown into
 * paid (or free) would hide exactly the providers that need a better discovery source.
 */
export async function providersSummary(client: DbExecutor): Promise<ProviderSummary[]> {
  const result = await client.query<SummaryDbRow>(`
    select
      provider,
      count(*)::int as models,
      count(*) filter (where is_free is true)::int as free,
      count(*) filter (where is_free is null)::int as unknown_count,
      count(*) filter (where healthy)::int as healthy,
      max(checked_at) as checked_at
    from models
    group by provider
    order by provider
  `);

  return result.rows.map((row) => ({
    provider: row.provider,
    models: row.models,
    free: row.free,
    unknown: row.unknown_count,
    healthy: row.healthy,
    checkedAt: row.checked_at,
  }));
}

/**
 * Remove rows for `provider` that the latest successful refresh did not list.
 *
 * Run this only for a provider that answered — a provider that threw must keep its
 * last-known-good rows, which is why `syncOnce` reconciles `refreshed`, never `failed`.
 *
 * **Guarded against an empty catalog.** A provider returning `{"data": []}` — a
 * glitch, a maintenance window, a proxy returning HTML — would otherwise wipe that
 * provider's entire registry in one tick. An empty keep-list removes nothing; the
 * rows simply go stale until a refresh that actually names models.
 */
export async function deleteMissingModels(
  client: DbClient,
  provider: ProviderId,
  keepIds: readonly string[],
): Promise<number> {
  if (keepIds.length === 0) {
    return 0;
  }

  return client.transaction(async (tx) => {
    const result = await tx.query(
      'delete from models where provider = $1 and not (model_id = any($2::text[]))',
      [provider, [...keepIds]],
    );
    return result.rowCount ?? 0;
  });
}

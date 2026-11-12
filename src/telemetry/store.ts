import type { DbClient } from '../db/client';

/** Accounting record written for every terminal path. */
export interface AccountingRecord {
  /** Gateway request id (x-request-id header). */
  requestId: string;
  /** Optional gateway key id — bare uuid (no gateway_keys table yet). */
  gatewayKeyId?: string;
  /** Provider id (openrouter, nvidia, tokenharbor, etc.). */
  provider: string;
  /** Model id used for this attempt. */
  model: string;
  /** Credential id that was used. */
  credentialId?: string;
  /** Task bucket for eval routing. */
  taskBucket?: string;
  /** Terminal status: success | failed | timeout | aborted */
  status: 'success' | 'failed' | 'timeout' | 'aborted';
  /** Upstream HTTP status (null if no call made). */
  httpStatus?: number | null;
  /** Prompt tokens from usage. */
  promptTokens?: number;
  /** Completion tokens from usage. */
  completionTokens?: number;
  /** Whether tokens are estimated. */
  tokensEstimated?: boolean;
  /** Cost in USD — NUMERIC precision, not FLOAT. */
  costUsd: number;
  /** Total request latency in ms. */
  latencyMs: number;
  /** Time to first token in ms (streaming). */
  ttftMs?: number;
  /** Number of candidates attempted. */
  attemptCount: number;
  /** Why this candidate was selected. */
  routeReason?: string;
  /** ProviderError.kind if failed. */
  errorKind?: string | null;
}

/** Store options. */
export interface AccountingStoreOptions {
  /** Batch size — flush when this many records are queued. */
  batchSize?: number;
  /** Flush interval in ms — flush at least this often. */
  flushIntervalMs?: number;
  /** Called on flush errors; default logs to console.error. */
  onError?: (err: Error, records: AccountingRecord[]) => void;
}

/**
 * Batched accounting store.
 *
 * Records are queued and flushed in batches. The flush is triggered by:
 * - batchSize reached
 * - flushIntervalMs elapsed
 * - explicit flush() call
 * - process exit (SIGINT/SIGTERM)
 *
 * The caller MUST call flush() or ensure process handlers are set up
 * to avoid losing in-flight records on abrupt shutdown.
 */
export class AccountingStore {
  private readonly client: DbClient;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly onError: (err: Error, records: AccountingRecord[]) => void;
  private readonly queue: AccountingRecord[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing = false;
  private closed = false;

  constructor(client: DbClient, options: AccountingStoreOptions = {}) {
    this.client = client;
    this.batchSize = options.batchSize ?? 100;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.onError = options.onError ?? ((err) => console.error('[accounting] flush error:', err));
  }

  /** Queue a record for batched insert. Non-blocking. */
  record(record: AccountingRecord): void {
    if (this.closed) return;
    this.queue.push(record);
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    } else if (this.flushTimer === undefined) {
      this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
      this.flushTimer.unref();
    }
  }

  /** Flush all queued records in a single transaction. */
  async flush(): Promise<number> {
    if (this.flushing || this.queue.length === 0) return 0;

    this.flushing = true;
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    const records = this.queue.splice(0, this.queue.length);
    if (records.length === 0) {
      this.flushing = false;
      return 0;
    }

    let flushedCount = 0;
    try {
      await this.client.transaction(async (tx) => {
        // Use a single multi-row insert for efficiency (18 columns per row)
        const placeholders = records
          .map((_, i) => {
            const base = i * 18;
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17}, $${base + 18})`;
          })
          .join(', ');

        const values: unknown[] = [];
        for (const r of records) {
          values.push(
            r.requestId,
            r.gatewayKeyId ?? null,
            r.provider,
            r.model,
            r.credentialId ?? null,
            r.taskBucket ?? null,
            r.status,
            r.httpStatus ?? null,
            r.promptTokens ?? null,
            r.completionTokens ?? null,
            r.tokensEstimated ?? false,
            r.costUsd,
            r.latencyMs,
            r.ttftMs ?? null,
            r.attemptCount,
            r.routeReason ?? null,
            r.errorKind ?? null,
            new Date(), // created_at
          );
        }

        await tx.query(
          `insert into requests (
            request_id, gateway_key_id, provider, model, credential_id, task_bucket,
            status, http_status, prompt_tokens, completion_tokens, tokens_estimated,
            cost_usd, latency_ms, ttft_ms, attempt_count, route_reason, error_kind, created_at
          ) values ${placeholders}
          on conflict (request_id) do nothing`,
          values,
        );
      });
      flushedCount = records.length;
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)), records);
      // Re-queue on failure so we don't lose data
      this.queue.unshift(...records);
    } finally {
      this.flushing = false;
    }

    return flushedCount;
  }

  /** Close the store, flushing any remaining records. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }
}

/**
 * Create an AccountingStore and attach process handlers for graceful shutdown.
 *
 * Returns the store and a cleanup function. The cleanup function MUST be called
 * on app shutdown to ensure in-flight records are persisted.
 */
export function createAccountingStore(
  client: DbClient,
  options: AccountingStoreOptions = {},
): { store: AccountingStore; cleanup: () => Promise<void> } {
  const store = new AccountingStore(client, options);

  const cleanup = async () => {
    await store.close();
  };

  // Attach handlers once per process
  if (!createAccountingStore.handlersAttached) {
    process.on('SIGINT', async () => {
      await cleanup();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await cleanup();
      process.exit(0);
    });
    createAccountingStore.handlersAttached = true;
  }

  return { store, cleanup };
}

createAccountingStore.handlersAttached = false;

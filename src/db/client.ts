import { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';

/**
 * The subset of `pg` this codebase depends on.
 *
 * Library modules take a `DbExecutor` (query only) or `DbClient` (query plus a
 * transaction), never a concrete `pg.Pool`. That keeps `store.ts` and `migrate.ts`
 * testable with a plain fake and keeps every connection string at an edge.
 */
export interface DbResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface DbExecutor {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbResult<Row>>;
}

export interface DbClient extends DbExecutor {
  /** Run `work` inside BEGIN/COMMIT, rolling back on any throw. */
  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Build a pooled client from an explicit connection string.
 *
 * Deliberately does not read `process.env`: `scripts/registry-sync.ts` and the
 * `db:migrate` entry point pass `DATABASE_URL` in from the edge.
 */
export function createDbClient(connectionString: string): DbClient {
  const url = connectionString.trim();
  if (url.length === 0) {
    throw new Error('createDbClient: a non-empty connection string is required');
  }

  const pool = new Pool({ connectionString: url });

  return {
    query: queryWith((sql, params) => pool.query(sql, params)),
    async transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await work(executorFor(client));
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

function executorFor(client: PoolClient): DbExecutor {
  return { query: queryWith((sql, params) => client.query(sql, params)) };
}

function queryWith(
  run: (sql: string, params: unknown[] | undefined) => Promise<QueryResult>,
): DbExecutor['query'] {
  return async <Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbResult<Row>> => {
    const result = await run(sql, params === undefined ? undefined : [...params]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The connection may already be broken; releasing it is the only recovery left.
    // Swallow this so the original error is what the caller sees.
  }
}

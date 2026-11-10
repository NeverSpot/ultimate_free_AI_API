import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDbClient } from './client';
import type { DbClient, DbExecutor } from './client';

/** The bookkeeping table. Created before any migration runs. */
export const MIGRATIONS_TABLE = 'schema_migrations';

/** `migrations/` beside the repo root, reachable from both `src/db` and `dist/db`. */
export const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '../../migrations');

export interface Migration {
  /** The file name, used verbatim as the schema_migrations version. */
  version: string;
  path: string;
  sql: string;
}

export interface MigrationResult {
  /** Applied in this run, in lexical order. */
  applied: string[];
  /** Already recorded; their SQL was not executed again. */
  skipped: string[];
}

/**
 * Run every `migrations/*.sql` file that has not been recorded yet.
 *
 * - The ledger table is created idempotently first.
 * - Files run in lexical order (zero-padded names make that numeric order).
 * - Each file and its ledger row commit together, so a failure leaves neither
 *   a half-applied migration nor a version that claims it ran.
 * - A second run is a no-op: every version is already present.
 */
export async function runMigrations(
  client: DbClient,
  options: { dir?: string } = {},
): Promise<MigrationResult> {
  const migrations = await loadMigrations(options.dir ?? DEFAULT_MIGRATIONS_DIR);
  await ensureMigrationsTable(client);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    if (await hasMigration(client, migration.version)) {
      skipped.push(migration.version);
      continue;
    }

    await applyMigration(client, migration);
    applied.push(migration.version);
  }

  return { applied, skipped };
}

/** Read `*.sql` files from `dir` in deterministic lexical order. */
export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const files = entries.filter((name) => name.endsWith('.sql')).sort(lexical);

  return Promise.all(
    files.map(async (version) => ({
      version,
      path: join(dir, version),
      sql: await readFile(join(dir, version), 'utf8'),
    })),
  );
}

/** Code-point order, not locale order: two machines must agree on migration order. */
function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function ensureMigrationsTable(client: DbExecutor): Promise<void> {
  await client.query(`
    create table if not exists ${MIGRATIONS_TABLE} (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function hasMigration(client: DbExecutor, version: string): Promise<boolean> {
  const result = await client.query(
    `select 1 from ${MIGRATIONS_TABLE} where version = $1 limit 1`,
    [version],
  );
  return result.rows.length > 0;
}

async function applyMigration(client: DbClient, migration: Migration): Promise<void> {
  await client.transaction(async (tx) => {
    // `pg` uses the simple query protocol when there are no parameters, so a
    // multi-statement file is valid here. The ledger write shares the transaction.
    await tx.query(migration.sql);
    await tx.query(
      `insert into ${MIGRATIONS_TABLE} (version) values ($1) on conflict (version) do nothing`,
      [migration.version],
    );
  });
}

/**
 * CLI edge for `npm run db:migrate`.
 *
 * This is the only place in this module that reads `process.env`; the runner
 * above takes an explicit client so tests and future callers stay env-free.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    console.error('db:migrate: DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }

  const client = createDbClient(connectionString);
  try {
    const result = await runMigrations(client);
    for (const version of result.applied) {
      console.log(`applied ${version}`);
    }
    for (const version of result.skipped) {
      console.log(`skip ${version} (already applied)`);
    }
    console.log(`db:migrate: ${result.applied.length} applied, ${result.skipped.length} skipped`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(`db:migrate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

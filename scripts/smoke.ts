import { ProviderError } from '../src/core/errors';
import type { CanonicalRequest } from '../src/core/types';
import { defaultAdapterMap } from '../src/providers/defaults';
import { loadCredentialPool } from '../src/credentials/pool';
import type { CredentialPool } from '../src/credentials/pool';
import type { ModelInfo, ProviderAdapter, ProviderId } from '../src/providers/types';

/**
 * Providers this smoke run covers.
 *
 * Each id here MUST equal both the adapter's `id` and the credential pool's provider
 * key. That equality is the identity contract asserted by
 * `test/unit/provider-identity.test.ts` — never reintroduce a translation table.
 */
export const SMOKE_PROVIDERS: ReadonlyArray<ProviderId> = ['nvidia', 'openrouter', 'tokenharbor'];

/**
 * First candidate per provider, measured live: NVIDIA has retired most of its
 * catalog, OpenRouter rate-limits individual free models, and Token Harbor's
 * `:free` quota is spent. Every other candidate is appended from the live catalog.
 */
export const DEFAULT_MODEL: Readonly<Record<string, string>> = {
  nvidia: 'deepseek-ai/deepseek-v4.1-flash',
  openrouter: 'nvidia/nemotron-3.5-lightning:free',
  tokenharbor: 'deepseek-v4.1-flash',
};

/** NVIDIA's only answering model takes 23-37s per 16-token call, so 20s is too short. */
export const DEFAULT_TIMEOUT_MS = 60_000;

const PING_PROMPT = 'Reply with exactly: PONG';
const PING_MAX_TOKENS = 16;
const MAX_CANDIDATES = 4;
const MAX_FREE_CANDIDATES = 2;
const MAX_LISTED_CANDIDATES = 2;

/** Only these failures can be fixed by trying another model; the rest are terminal. */
const RETRYABLE_KINDS: ReadonlySet<string> = new Set(['model_gone', 'rate_limited', 'upstream']);

export interface SmokeRow {
  provider: ProviderId;
  creds: number;
  models: number | null;
  free: number | null;
  model: string;
  tokens: number | null;
  estimated: boolean | null;
  ms: number | null;
  status: string;
  /** Set when the probe failed; rendered as an `error[<kind>]` line after the row. */
  errorKind?: string;
  /** Chat candidates attempted before the failure; only rendered when > 1. */
  attempts?: number;
}

export interface RunSmokeOptions {
  pool: CredentialPool;
  adapters: Map<ProviderId, ProviderAdapter>;
  providers?: ProviderId[];
  model?: string;
  write: (line: string) => void;
  now?: () => number;
  timeoutMs?: number;
  /** Injected for hermetic tests; `main()` passes `process.env`. */
  env?: NodeJS.ProcessEnv;
}

type Alignment = 'left' | 'right';

interface Column {
  key: keyof SmokeRow;
  header: string;
  align: Alignment;
}

const COLUMNS: ReadonlyArray<Column> = [
  { key: 'provider', header: 'provider', align: 'left' },
  { key: 'creds', header: 'creds', align: 'right' },
  { key: 'models', header: 'models', align: 'right' },
  { key: 'free', header: 'free', align: 'right' },
  { key: 'model', header: 'model', align: 'left' },
  { key: 'tokens', header: 'tokens', align: 'right' },
  { key: 'estimated', header: 'est', align: 'left' },
  { key: 'ms', header: 'ms', align: 'right' },
  { key: 'status', header: 'status', align: 'left' },
];

function cellValue(row: SmokeRow, key: keyof SmokeRow): string {
  const value = row[key];
  if (value === null || value === undefined) {
    return '-';
  }
  return String(value);
}

function renderLine(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, index) => {
      const width = widths[index] ?? cell.length;
      return COLUMNS[index]?.align === 'right' ? cell.padStart(width) : cell.padEnd(width);
    })
    .join('  ')
    .trimEnd();
}

/**
 * Render the smoke table, one aligned line per provider, plus its summary.
 *
 * Widths come from the data and the header, so adding a provider needs no changes here.
 */
export function formatTable(rows: readonly SmokeRow[], elapsedMs = 0): string {
  const widths = COLUMNS.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => cellValue(row, column.key).length)),
  );

  const lines = [
    renderLine(
      COLUMNS.map((column) => column.header),
      widths,
    ),
  ];

  for (const row of rows) {
    lines.push(
      renderLine(
        COLUMNS.map((column) => cellValue(row, column.key)),
        widths,
      ),
    );
    if (row.errorKind !== undefined) {
      const suffix =
        row.attempts !== undefined && row.attempts > 1 ? ` after ${row.attempts} models` : '';
      lines.push(`error[${row.errorKind}] ${row.provider}${suffix}`);
    }
  }

  lines.push(formatSummary(rows, elapsedMs));
  return lines.join('\n');
}

export function formatSummary(rows: readonly SmokeRow[], elapsedMs: number): string {
  const ok = rows.filter((row) => row.status === 'ok').length;
  const failed = rows.length - ok;
  const noun = rows.length === 1 ? 'provider' : 'providers';
  return `${rows.length} ${noun}: ${ok} ok, ${failed} failed (${(elapsedMs / 1000).toFixed(1)}s)`;
}

/**
 * Race an adapter call against its abort signal so a hung provider is a timeout failure,
 * never a hung smoke run. The adapter still receives the signal and can cancel I/O itself.
 */
function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new ProviderError('timeout', 'Provider call timed out'));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    operation(signal).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Ordered candidates for one provider. `--model` wins alone; otherwise the env
 * override (or built-in default) leads, then up to two free models, then the first
 * two listed ids. Deduplicated in order and capped at four so a slow provider is
 * never multiplied by four attempts.
 */
export function modelChain(
  provider: ProviderId,
  models: readonly ModelInfo[],
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = {},
): string[] {
  if (explicit !== undefined) {
    return explicit.length > 0 ? [explicit] : [];
  }

  const chain: string[] = [];
  const push = (id: string | undefined): void => {
    if (id !== undefined && id.length > 0 && chain.length < MAX_CANDIDATES && !chain.includes(id)) {
      chain.push(id);
    }
  };

  const override = env[`SMOKE_MODEL_${provider.toUpperCase()}`]?.trim();
  push(override !== undefined && override.length > 0 ? override : DEFAULT_MODEL[provider]);
  let freeAdded = 0;
  for (const candidate of models) {
    if (freeAdded >= MAX_FREE_CANDIDATES || chain.length >= MAX_CANDIDATES) {
      break;
    }
    if (candidate.is_free !== true || chain.includes(candidate.id)) {
      continue;
    }
    push(candidate.id);
    freeAdded += 1;
  }
  for (const candidate of models.slice(0, MAX_LISTED_CANDIDATES)) {
    push(candidate.id);
  }

  return chain;
}

function failedRow(
  provider: ProviderId,
  creds: number,
  kind: string,
  known: Partial<Pick<SmokeRow, 'models' | 'free' | 'model'>> = {},
  attempts?: number,
): SmokeRow {
  return {
    provider,
    creds,
    models: known.models ?? null,
    free: known.free ?? null,
    model: known.model ?? '-',
    tokens: null,
    estimated: null,
    ms: null,
    status: `FAILED ${kind}`,
    errorKind: kind,
    attempts,
  };
}

async function probeProvider(
  provider: ProviderId,
  options: RunSmokeOptions,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<SmokeRow> {
  const now = options.now ?? Date.now;

  const credentials = options.pool.getCandidates(provider);
  if (credentials.length === 0) {
    return failedRow(provider, 0, 'no_credential');
  }

  const adapter = options.adapters.get(provider);
  if (adapter === undefined) {
    return failedRow(provider, credentials.length, 'unknown');
  }

  const credential = credentials[0];
  if (credential === undefined) {
    return failedRow(provider, 0, 'no_credential');
  }

  const known: Partial<Pick<SmokeRow, 'models' | 'free' | 'model'>> = {};

  let models: ModelInfo[];
  try {
    // listModels() has no signal parameter, so the race is what makes a hung call fail.
    models = await withTimeout(() => adapter.listModels(credential), timeoutMs);
  } catch (error) {
    const kind = error instanceof ProviderError ? error.kind : 'unknown';
    return failedRow(provider, credentials.length, kind, known);
  }

  if (models.length === 0) {
    return failedRow(provider, credentials.length, 'no_models', { models: 0, free: 0 });
  }

  const free = models.filter((model) => model.is_free === true).length;
  const chain = modelChain(provider, models, options.model, env);
  known.models = models.length;
  known.free = free;

  let lastKind = 'unknown';
  let lastModel: string | undefined;
  let attempts = 0;

  for (const candidate of chain) {
    attempts += 1;
    lastModel = candidate;
    const request: CanonicalRequest = {
      model: candidate,
      messages: [{ role: 'user', content: PING_PROMPT }],
      max_tokens: PING_MAX_TOKENS,
    };

    const startedAt = now();
    try {
      const response = await withTimeout(
        (signal) => adapter.chat(request, credential, signal),
        timeoutMs,
      );
      const elapsedMs = Math.max(0, now() - startedAt);

      return {
        provider,
        creds: credentials.length,
        models: models.length,
        free,
        model: candidate,
        tokens: response.usage.total_tokens,
        estimated: response.usage.estimated ?? false,
        ms: elapsedMs,
        status: 'ok',
      };
    } catch (error) {
      lastKind = error instanceof ProviderError ? error.kind : 'unknown';
      // A slow provider must not be multiplied by retries, and another model cannot
      // fix auth, a block, a bad request or an unsupported operation.
      if (!RETRYABLE_KINDS.has(lastKind)) {
        break;
      }
    }
  }

  known.model = lastModel;
  return failedRow(provider, credentials.length, lastKind, known, attempts);
}

/**
 * Testable smoke run: pure over the injected pool, adapters, clock, env and writer.
 * Returns an exit code; never calls `process.exit()`.
 */
export async function runSmoke(options: RunSmokeOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const env = options.env ?? {};
  const timeoutMs = resolveTimeout(options.timeoutMs, env);
  const selected = options.providers ?? SMOKE_PROVIDERS;
  const startedAt = now();
  const rows: SmokeRow[] = [];

  for (const provider of selected) {
    rows.push(await probeProvider(provider, options, timeoutMs, env));
  }

  const elapsedMs = Math.max(0, now() - startedAt);
  for (const line of formatTable(rows, elapsedMs).split('\n')) {
    options.write(line);
  }

  const allOk = rows.length > 0 && rows.every((row) => row.status === 'ok');
  return allOk ? 0 : 1;
}

/** A positive integer, or `undefined` when the raw value is not one. */
function positiveInteger(raw: string): number | undefined {
  if (!/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function resolveTimeout(timeoutMs: number | undefined, env: NodeJS.ProcessEnv): number {
  if (timeoutMs !== undefined) {
    return timeoutMs;
  }
  const raw = env.SMOKE_TIMEOUT_MS;
  if (raw !== undefined) {
    const parsed = positiveInteger(raw);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return DEFAULT_TIMEOUT_MS;
}

interface CliOptions {
  providers?: ProviderId[];
  model?: string;
  timeoutMs?: number;
  error?: string;
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let provider: string | undefined;
  let model: string | undefined;
  let timeoutMs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--provider' || arg === '--model' || arg === '--timeout') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: `${arg} requires a value` };
      }

      if (arg === '--provider') {
        provider = value;
      } else if (arg === '--model') {
        model = value;
      } else {
        const parsed = positiveInteger(value);
        if (parsed === undefined) {
          return { error: '--timeout requires a positive integer' };
        }
        timeoutMs = parsed;
      }
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      return { error: `unknown option ${arg}` };
    }
  }

  if (provider !== undefined && !SMOKE_PROVIDERS.includes(provider)) {
    return {
      error: `unknown provider "${provider}" (expected ${SMOKE_PROVIDERS.join(', ')})`,
    };
  }

  if (env.SMOKE_TIMEOUT_MS !== undefined && positiveInteger(env.SMOKE_TIMEOUT_MS) === undefined) {
    return { error: 'SMOKE_TIMEOUT_MS must be a positive integer' };
  }

  return {
    providers: provider === undefined ? undefined : [provider],
    model,
    timeoutMs,
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), process.env);
  if (parsed.error !== undefined) {
    console.error(`smoke: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  let pool: CredentialPool;
  try {
    pool = loadCredentialPool(process.env);
  } catch {
    console.error('smoke: failed to load the credential pool');
    process.exitCode = 1;
    return;
  }

  const adapters = defaultAdapterMap();

  const exitCode = await runSmoke({
    pool,
    adapters,
    providers: parsed.providers,
    model: parsed.model,
    timeoutMs: parsed.timeoutMs,
    env: process.env,
    write: (line) => console.log(line),
  });
  process.exitCode = exitCode;
}

if (require.main === module) {
  void main().catch(() => {
    console.error('smoke: unexpected failure');
    process.exitCode = 1;
  });
}

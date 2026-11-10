import { loadCredentialPool } from '../src/credentials/pool';
import type { CredentialPool } from '../src/credentials/pool';
import { defaultAdapters } from '../src/providers/defaults';
import { createProviderRegistry, discoverModels } from '../src/providers/registry';
import type { DiscoveryResult, ProviderRegistry } from '../src/providers/registry';
import type { ModelInfo, ProviderId } from '../src/providers/types';

const SAMPLE_LIMIT = 3;

/** Free means exactly `true`; `null` is unknown and never counted as free or paid. */
function isFree(model: ModelInfo): boolean {
  return model.is_free === true;
}

function isUnknown(model: ModelInfo): boolean {
  return model.is_free !== true && model.is_free !== false;
}

interface ProviderRow {
  provider: ProviderId;
  models: number;
  free: number;
  samples: string[];
}

function providerRows(result: DiscoveryResult, registry: ProviderRegistry): ProviderRow[] {
  return registry.ids().map((provider) => {
    const models = result.models.filter((model) => model.provider === provider);
    const free = models.filter((model) => isFree(model));

    return {
      provider,
      models: models.length,
      free: free.length,
      samples: free.slice(0, SAMPLE_LIMIT).map((model) => model.id),
    };
  });
}

/**
 * Render the per-provider table, the totals and any failures.
 *
 * Widths come from the data and the header, so adding a provider needs no change here.
 */
export function formatReport(result: DiscoveryResult, registry: ProviderRegistry): string[] {
  const rows = providerRows(result, registry);
  const header = ['provider', 'models', 'free', 'samples'];
  const cells = rows.map((row) => [
    row.provider,
    String(row.models),
    String(row.free),
    row.samples.length === 0 ? '-' : row.samples.join(','),
  ]);

  const widths = header.map((title, index) =>
    Math.max(title.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );
  const render = (row: readonly string[]): string =>
    row
      .map((cell, index) => (index < 3 ? cell.padEnd(widths[index] ?? cell.length) : cell))
      .join('  ')
      .trimEnd();

  const totalFree = result.models.filter((model) => isFree(model)).length;
  const totalUnknown = result.models.filter((model) => isUnknown(model)).length;

  const lines = [render(header), ...cells.map(render)];
  lines.push('');
  lines.push(`total: ${result.models.length} models, ${totalFree} free, ${totalUnknown} unknown`);

  if (result.failures.length > 0) {
    lines.push('');
    for (const failure of result.failures) {
      lines.push(`failure: ${failure.provider} [${failure.kind}] ${failure.message}`);
    }
  }

  return lines;
}

async function main(): Promise<void> {
  let pool: CredentialPool;
  try {
    pool = loadCredentialPool(process.env);
  } catch {
    console.error('registry-list: failed to load the credential pool');
    process.exitCode = 1;
    return;
  }

  const registry = createProviderRegistry(defaultAdapters());

  const result = await discoverModels(registry, pool);
  for (const line of formatReport(result, registry)) {
    console.log(line);
  }

  process.exitCode = result.failures.length > 0 ? 1 : 0;
}

if (require.main === module) {
  void main().catch(() => {
    console.error('registry-list: unexpected failure');
    process.exitCode = 1;
  });
}

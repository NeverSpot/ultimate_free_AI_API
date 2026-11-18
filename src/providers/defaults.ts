import { PROVIDER_SPECS, isProviderEnabled, type ProviderSpec } from './catalog';
import { NvidiaNimAdapter } from './nvidia-nim';
import { OpenAiCompatibleAdapter } from './openai-compatible';
import { OpenRouterAdapter } from './openrouter';
import { ReplicateAdapter } from './replicate';
import { TokenHarborAdapter } from './tokenharbor';
import type { ProviderAdapter, ProviderId } from './types';

/**
 * The ONE composition root for provider adapters.
 *
 * Rows come from `providers/catalog.ts`; this module only decides which class builds
 * each row. Adding a provider is: one catalog row, and — only if it does not speak the
 * OpenAI dialect — one adapter file plus a branch below. Every CLI and the HTTP server
 * read this, so a new provider reaches all of them without touching a script.
 *
 * Adapters are constructed for the whole enabled catalog, not only for the providers
 * that happen to have keys: a provider without a credential is never handed to the
 * router, while a provider with a key and no adapter would silently vanish from routing.
 */

const LEGACY_ADAPTERS: Readonly<Record<string, () => ProviderAdapter>> = {
  // These three predate the catalog and carry behaviour (free detection, error
  // profiles) that is not worth re-deriving through the generic adapter.
  nvidia: () => new NvidiaNimAdapter(),
  openrouter: () => new OpenRouterAdapter(),
  tokenharbor: () => new TokenHarborAdapter(),
};

interface ResolvedBaseUrl {
  baseUrl: string;
  /** The environment variable that had to be set and was not. */
  missing?: string;
}

/**
 * Fill `{PLACEHOLDER}` segments from the environment.
 *
 * A missing value becomes an explicit `unavailableReason` on the adapter rather than a
 * malformed URL: Cloudflare's endpoint embeds the account id in the path, and calling
 * `.../accounts//ai/v1` would surface as an opaque 404.
 */
function resolveBaseUrl(spec: ProviderSpec, env: NodeJS.ProcessEnv): ResolvedBaseUrl {
  let missing: string | undefined;
  const baseUrl = spec.baseUrl.replace(/\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value === '') {
      missing = name;
      return '';
    }
    return value;
  });

  if (spec.requiresEnv !== undefined && (env[spec.requiresEnv] ?? '') === '') {
    missing = spec.requiresEnv;
  }

  return missing === undefined ? { baseUrl } : { baseUrl, missing };
}

/** Build the adapter for one catalog row. */
export function createAdapter(
  spec: ProviderSpec,
  env: NodeJS.ProcessEnv = process.env,
): ProviderAdapter {
  const legacy = LEGACY_ADAPTERS[spec.id];
  if (legacy !== undefined) {
    return legacy();
  }

  const { baseUrl, missing } = resolveBaseUrl(spec, env);

  if (spec.wire === 'replicate') {
    return new ReplicateAdapter({ baseUrl });
  }

  return new OpenAiCompatibleAdapter({
    id: spec.id,
    baseUrl,
    freeRule: spec.freeRule,
    ...(missing === undefined
      ? {}
      : { unavailableReason: `${missing} is not set, so ${spec.name} cannot be used` }),
  });
}

/** Every enabled adapter, in catalog order (which is also discovery order). */
export function defaultAdapters(env: NodeJS.ProcessEnv = process.env): ProviderAdapter[] {
  return PROVIDER_SPECS.filter((spec) => isProviderEnabled(spec, env)).map((spec) =>
    createAdapter(spec, env),
  );
}

/** Convenience for callers that key adapters by id (smoke, and later the router). */
export function defaultAdapterMap(
  env: NodeJS.ProcessEnv = process.env,
): Map<ProviderId, ProviderAdapter> {
  return new Map(defaultAdapters(env).map((adapter) => [adapter.id, adapter]));
}

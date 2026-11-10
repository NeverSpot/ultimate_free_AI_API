import { NvidiaNimAdapter } from './nvidia-nim';
import { OpenRouterAdapter } from './openrouter';
import { TokenHarborAdapter } from './tokenharbor';
import type { ProviderAdapter, ProviderId } from './types';

/**
 * The ONE composition root for provider adapters.
 *
 * Adding a provider is: one adapter file, plus one line in the list below. Nothing else
 * changes — every CLI (`scripts/smoke.ts`, `scripts/registry-list.ts`) reads this, so a new
 * provider reaches all of them without touching a script.
 *
 * This module is the reason the "one file" invariant is honest: without it, each CLI kept
 * its own hardcoded adapter list and a fourth provider would have needed edits in every one.
 */
export function defaultAdapters(): ProviderAdapter[] {
  return [new NvidiaNimAdapter(), new OpenRouterAdapter(), new TokenHarborAdapter()];
}

/** Convenience for callers that key adapters by id (smoke, and later the router). */
export function defaultAdapterMap(): Map<ProviderId, ProviderAdapter> {
  return new Map(defaultAdapters().map((adapter) => [adapter.id, adapter]));
}

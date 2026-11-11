import type { ProviderId } from '../providers/types';

/** The three windows the ledger can track. */
export type Window = 'rpm' | 'rpd' | 'rpw';

/** Fixed window length per window. TTLs are written from first use, not calendar-aligned. */
export const LEDGER_WINDOW_MS: Record<Window, number> = {
  rpm: 60_000,
  rpd: 86_400_000,
  rpw: 604_800_000,
};

/**
 * Which windows apply to one provider model, and whether the provider can be asked.
 *
 * `null` means the window applies but its ceiling is not known yet. Structure is code;
 * ceilings are runtime data that arrive through `withCeilings`.
 */
export interface LimitPolicy {
  rpm?: number | null;
  rpd?: number | null;
  rpw?: number | null;
  observable: 'quota-endpoint' | 'inferred';
}

/**
 * Defaults per provider. Deliberately contains no numeric ceilings: a hardcoded RPM /
 * RPD / TPM number would violate AGENTS.md invariant 1.
 */
const DEFAULT_POLICIES: Readonly<Record<string, LimitPolicy>> = {
  nvidia: { observable: 'inferred' },
  openrouter: { rpd: null, observable: 'quota-endpoint' },
  tokenharbor: { rpw: null, observable: 'inferred' },
};

const WINDOW_ORDER: readonly Window[] = ['rpm', 'rpd', 'rpw'];

/**
 * Resolve the default policy for a provider model without any I/O.
 *
 * Token Harbor only has a weekly allowance on the `:free` models; its paid routes carry
 * no known window. Returns a fresh object so callers can never mutate the table.
 */
export function resolvePolicy(provider: ProviderId, modelId: string): LimitPolicy {
  if (provider === 'tokenharbor') {
    const weekly = DEFAULT_POLICIES.tokenharbor;
    if (weekly === undefined || !modelId.endsWith(':free')) {
      return { observable: 'inferred' };
    }
    return { ...weekly };
  }

  const defaults = DEFAULT_POLICIES[provider];
  return defaults === undefined ? { observable: 'inferred' } : { ...defaults };
}

/** Windows the policy names, including those whose ceiling is still `null`. */
export function applicableWindows(policy: LimitPolicy): Window[] {
  return WINDOW_ORDER.filter((window) => policy[window] !== undefined);
}

/** Windows that also carry a positive ceiling and can therefore refuse a request. */
export function enforcedWindows(policy: LimitPolicy): Window[] {
  return WINDOW_ORDER.filter((window) => {
    const ceiling = policy[window];
    return typeof ceiling === 'number' && ceiling > 0;
  });
}

/**
 * Return a new policy carrying the supplied runtime ceilings.
 *
 * The input policy is not modified, and windows without a supplied ceiling keep their
 * current value (including `null`).
 */
export function withCeilings(
  policy: LimitPolicy,
  ceilings: Partial<Record<Window, number>>,
): LimitPolicy {
  const next: LimitPolicy = { ...policy };
  for (const window of WINDOW_ORDER) {
    const ceiling = ceilings[window];
    if (ceiling !== undefined) {
      next[window] = ceiling;
    }
  }
  return next;
}

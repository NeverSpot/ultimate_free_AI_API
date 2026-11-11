import type { ErrorKind } from '../core/errors';
import type { Window } from '../limits/policy';
import { LEDGER_WINDOW_MS } from '../limits/policy';

export interface ParkOutcome {
  kind: ErrorKind;
  retryAfterMs?: number;
  parkUntil?: number | null;
  window?: Window;
  now?: number;
}

export interface ParkDecision {
  action: 'retry' | 'park';
  waitMs: number;
  window?: Window;
}

/**
 * Reaction thresholds, NOT provider ceilings.
 *
 * `RETRY_LIMIT_MS` says how long a plain 429 is worth retrying this run; `DEFAULT_RETRY_MS`
 * is the wait when a provider named no delay. Neither is an RPM/RPD/TPM number, so
 * AGENTS.md invariant 1 (limits are discovered, never hardcoded) still holds.
 */
const RETRY_LIMIT_MS = 60_000;
const DEFAULT_RETRY_MS = 1_000;

/** Failures no retry of this same request can fix: park means "never this run". */
const TERMINAL_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'client',
  'auth',
  'model_gone',
  'too_long',
  'blocked',
  'unsupported',
]);

/**
 * Decide whether the caller may retry now or must park the route.
 *
 * Pure: no I/O and no clock of its own. A `parkUntil` is only honoured when the caller
 * supplies `now`, because without a clock the function cannot prove it is in the future.
 */
export function parkDecision(o: ParkOutcome): ParkDecision {
  if (TERMINAL_KINDS.has(o.kind)) {
    return { action: 'park', waitMs: Number.POSITIVE_INFINITY };
  }

  if (o.kind === 'exhausted') {
    return { action: 'park', waitMs: exhaustedWaitMs(o), window: 'rpw' };
  }

  if (o.window === 'rpw' || o.window === 'rpd') {
    // A ledger refusal is authoritative: the window is still exhausted when the
    // provider's small Retry-After elapses, so the window length is the floor.
    return {
      action: 'park',
      waitMs: Math.max(o.retryAfterMs ?? 0, LEDGER_WINDOW_MS[o.window]),
      window: o.window,
    };
  }

  if (o.window === 'rpm') {
    return { action: 'retry', waitMs: o.retryAfterMs ?? 0, window: 'rpm' };
  }

  if (o.kind === 'rate_limited') {
    const waitMs = o.retryAfterMs ?? DEFAULT_RETRY_MS;
    const action =
      o.retryAfterMs === undefined || o.retryAfterMs <= RETRY_LIMIT_MS ? 'retry' : 'park';
    return { action, waitMs };
  }

  // `upstream` / `timeout`: hand the candidate back with no cooldown. The breaker owns
  // the cooldown in Block 8.
  return { action: 'park', waitMs: o.retryAfterMs ?? 0 };
}

function exhaustedWaitMs(o: ParkOutcome): number {
  const { parkUntil, now } = o;
  if (
    typeof parkUntil === 'number' &&
    Number.isFinite(parkUntil) &&
    now !== undefined &&
    parkUntil > now
  ) {
    return parkUntil - now;
  }

  return o.retryAfterMs ?? LEDGER_WINDOW_MS.rpw;
}

import { createHash } from 'node:crypto';
import type { Credential, ProviderId } from '../providers/types';

/**
 * The set of provider credentials loaded from the environment.
 *
 * Arrays handed out are copies: callers may sort or splice them without corrupting
 * the pool. Credential objects themselves are shared and immutable.
 */
export interface CredentialPool {
  /** Credentials for `provider`, or `[]` when the provider is unknown or empty. */
  getCandidates(provider: ProviderId): Credential[];
  /** Providers holding at least one credential, in configuration order. */
  providers(): ProviderId[];
  /** Alias of `getCandidates`, named for call sites that read better that way. */
  credentialsFor(provider: ProviderId): Credential[];
  /** Credential count for `provider`, or the total when no provider is given. */
  size(provider?: ProviderId): number;
}

/** Env var to provider. One line per provider; adding one is a one-line change. */
const ENV_PROVIDERS: ReadonlyArray<readonly [envVar: string, provider: ProviderId]> = [
  ['NVIDIA_NIM_KEYS', 'nvidia'],
  ['OPENROUTER_KEYS', 'openrouter'],
  ['TOKENHARBOR_KEYS', 'tokenharbor'],
];

const ID_HASH_LENGTH = 16;
const FULL_HASH_LENGTH = 64;

/**
 * Load the credential pool from an injected environment.
 *
 * Pure over `raw`: it never reads `process.env`, so tests pass a literal and production
 * passes `process.env` at the edge. Unset or blank variables yield an empty list; only
 * genuinely malformed input (a non-string value, or an entry containing a newline)
 * throws, and every problem is reported in one aggregated error.
 */
export function loadCredentialPool(raw: NodeJS.ProcessEnv): CredentialPool {
  const problems: string[] = [];
  const byProvider = new Map<ProviderId, Credential[]>();

  for (const [envVar, provider] of ENV_PROVIDERS) {
    const secrets = parseSecrets(raw, envVar, problems);
    if (secrets.length > 0) {
      byProvider.set(provider, buildCredentials(provider, secrets));
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid credential configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }

  return new InMemoryCredentialPool(byProvider);
}

/**
 * Split one env var into deduplicated secrets.
 *
 * Blanks drop before dedupe so `"k1,k1, ,k1"` yields one credential. Errors name the
 * entry index and its length, never the value.
 */
function parseSecrets(raw: NodeJS.ProcessEnv, envVar: string, problems: string[]): string[] {
  const value: unknown = raw[envVar];
  if (value === undefined) {
    return [];
  }

  if (typeof value !== 'string') {
    problems.push(`${envVar} must be a string (got ${value === null ? 'null' : typeof value})`);
    return [];
  }

  if (value.trim().length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const secrets: string[] = [];

  for (const [index, entry] of value.split(',').entries()) {
    if (entry.includes('\n') || entry.includes('\r')) {
      problems.push(
        `${envVar} entry ${index + 1} must not contain a newline (${entry.length} chars)`,
      );
      continue;
    }

    const secret = entry.trim();
    if (secret.length === 0 || seen.has(secret)) {
      continue;
    }

    seen.add(secret);
    secrets.push(secret);
  }

  return secrets;
}

function buildCredentials(provider: ProviderId, secrets: string[]): Credential[] {
  const ids = assignIds(provider, secrets);
  return secrets.map((secret, index) => {
    const id = ids[index] ?? `${provider}-${hashSecret(provider, secret).slice(0, ID_HASH_LENGTH)}`;
    return makeCredential(provider, id, `${provider}-${index + 1}`, secret);
  });
}

/**
 * `provider + "-" + sha256(provider + "\0" + secret)` truncated to 16 hex chars.
 *
 * Colliding 16-char prefixes are widened to 32 (then 64) chars instead of merged or
 * thrown, so ids stay unique and remain a pure function of (provider, secret).
 */
function assignIds(provider: ProviderId, secrets: string[]): string[] {
  const hashes = secrets.map((secret) => hashSecret(provider, secret));
  const widths = hashes.map(() => ID_HASH_LENGTH);

  for (;;) {
    const ids = hashes.map(
      (hash, index) => `${provider}-${hash.slice(0, widths[index] ?? ID_HASH_LENGTH)}`,
    );
    const counts = new Map<string, number>();
    for (const id of ids) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    let widened = false;
    for (const [index, id] of ids.entries()) {
      if ((counts.get(id) ?? 0) < 2) {
        continue;
      }

      const width = widths[index] ?? ID_HASH_LENGTH;
      if (width < FULL_HASH_LENGTH) {
        widths[index] = Math.min(width * 2, FULL_HASH_LENGTH);
        widened = true;
      }
    }

    if (!widened) {
      return ids;
    }
  }
}

function hashSecret(provider: ProviderId, secret: string): string {
  return createHash('sha256').update(`${provider}\0${secret}`, 'utf8').digest('hex');
}

/**
 * Build one credential with `secret` as a non-enumerable own property.
 *
 * `JSON.stringify`, `String` and `console.log` therefore never print the key, while
 * adapters can still read `cred.secret`.
 */
export function makeCredential(
  provider: ProviderId,
  id: string,
  label: string,
  secret: string,
): Credential {
  const credential: Credential = { id, provider, label, secret: '' };

  Object.defineProperty(credential, 'secret', {
    value: secret,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(credential, 'toJSON', {
    value: () => ({ id, provider, label }),
    enumerable: false,
  });
  Object.defineProperty(credential, 'toString', {
    value: () => `credential:${id}`,
    enumerable: false,
  });

  return credential;
}

class InMemoryCredentialPool implements CredentialPool {
  readonly #byProvider: ReadonlyMap<ProviderId, readonly Credential[]>;

  constructor(byProvider: Map<ProviderId, Credential[]>) {
    this.#byProvider = byProvider;
  }

  getCandidates(provider: ProviderId): Credential[] {
    return this.#copy(provider);
  }

  providers(): ProviderId[] {
    return [...this.#byProvider.keys()];
  }

  credentialsFor(provider: ProviderId): Credential[] {
    return this.#copy(provider);
  }

  size(provider?: ProviderId): number {
    if (provider === undefined) {
      let total = 0;
      for (const credentials of this.#byProvider.values()) {
        total += credentials.length;
      }
      return total;
    }

    return this.#byProvider.get(provider)?.length ?? 0;
  }

  #copy(provider: ProviderId): Credential[] {
    const credentials = this.#byProvider.get(provider);
    return credentials === undefined ? [] : [...credentials];
  }
}

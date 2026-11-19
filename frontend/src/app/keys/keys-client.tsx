'use client';

import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, Eye, EyeOff, Loader2, Play, RefreshCw, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/site/dialog';
import {
  api,
  ApiError,
  normalizeKeyList,
  type GatewayKeyResponse,
  type KeySummary,
  type KeyTestResult,
  type ListKeysResponse,
  type ProviderHealth,
  type ProvidersHealthResponse,
  type ProviderInfo,
  type RegenerateKeyResponse,
  type UsageResponse,
  type UsageSummary,
} from '@/lib/api';
import { useSession } from '@/components/session-provider';

/**
 * The keys screen has two jobs: hand the user their gateway key, and let them
 * manage the provider keys that key routes through. Everything below is built
 * around those two jobs — no stats theatre, no second navigation.
 */
interface ProviderDef {
  id: string;
  name: string;
  tier: 'free' | 'credit';
  freeNote: string;
  signupUrl: string;
  requiresEnv: string | null;
  aliases: string[];
}

const FALLBACK_PROVIDERS: ProviderDef[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    tier: 'free',
    freeNote: ':free models — 50 requests/day.',
    signupUrl: 'https://openrouter.ai',
    requiresEnv: null,
    aliases: [],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    tier: 'free',
    freeNote: 'Credit-based developer access.',
    signupUrl: 'https://build.nvidia.com',
    requiresEnv: null,
    aliases: ['nvidia-nim'],
  },
  {
    id: 'tokenharbor',
    name: 'Token Harbor',
    tier: 'free',
    freeNote: 'Four :free models on a weekly allowance.',
    signupUrl: 'https://tokenharbor.ai',
    requiresEnv: null,
    aliases: [],
  },
];

function toProviderDef(info: ProviderInfo): ProviderDef {
  return {
    id: info.id,
    name: info.name,
    tier: info.tier === 'credit' ? 'credit' : 'free',
    freeNote: info.free_note,
    signupUrl: info.signup_url,
    requiresEnv: info.requires_env,
    aliases: info.aliases ?? [],
  };
}

/** True when a stored key row belongs to this provider, including its old spellings. */
function ownsProvider(provider: ProviderDef, keyProvider: string): boolean {
  return keyProvider === provider.id || provider.aliases.includes(keyProvider);
}

/** A park duration as something a person can read at a glance. */
function formatRetry(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCost(value: number): string {
  if (value <= 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

// The gateway key is held in memory only. It used to be mirrored to
// localStorage in three shapes; now the server is asked for it when the user
// reveals or copies it, and a reload forgets it.

const BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';

export default function KeysPage() {
  const router = useRouter();
  const {
    user,
    loading: sessionLoading,
    error: sessionError,
    refresh: refreshSession,
  } = useSession();

  const [gatewayKey, setGatewayKey] = useState<string | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [keyNotRecoverable, setKeyNotRecoverable] = useState(false);

  // The provider catalog, painted from the backend so a new provider needs no deploy here.
  const [providers, setProviders] = useState<ProviderDef[]>(FALLBACK_PROVIDERS);
  // A failed catalog fetch leaves the three built-in rows on screen, so the page has
  // to say the list is a fallback instead of letting it read as lost providers.
  const [catalogError, setCatalogError] = useState('');

  // Every key the user has registered. A provider may hold several, so this list is
  // what the provider rows render.
  const [keys, setKeys] = useState<KeySummary[]>([]);

  const [values, setValues] = useState<Record<string, string>>({});
  const [operationLoading, setOperationLoading] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, KeyTestResult>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const [testingKey, setTestingKey] = useState<Record<string, boolean>>({});

  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageUnavailable, setUsageUnavailable] = useState(false);

  const [loadingKeys, setLoadingKeys] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Regenerate Key modal
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPassword, setRegenPassword] = useState('');
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenError, setRegenError] = useState('');

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<{
    key: KeySummary;
    providerName: string;
  } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const successTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (successTimer.current !== undefined) clearTimeout(successTimer.current);
    };
  }, []);

  function flashSuccess(message: string): void {
    setSuccess(message);
    if (successTimer.current !== undefined) clearTimeout(successTimer.current);
    successTimer.current = setTimeout(() => setSuccess(''), 4_000);
  }

  useEffect(() => {
    if (sessionLoading || sessionError) return; // still checking /me, or /me errored
    if (!user) {
      // The server guard already covers the normal case; this catches a cookie
      // that expired after render, without leaving the dashboard in place.
      router.replace('/login');
      return;
    }

    let cancelled = false;

    api
      .get<ListKeysResponse>('/user/keys')
      .then((res) => {
        if (cancelled) return;
        setKeys(normalizeKeyList(res));
        setError('');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load provider keys');
      })
      .finally(() => {
        if (!cancelled) setLoadingKeys(false);
      });

    // Older gateways do not implement /user/usage at all. A 404 hides the strip;
    // any other failure says so without pretending the numbers are zero.
    api
      .get<UsageResponse>('/user/usage')
      .then((res) => {
        if (cancelled) return;
        setUsage(res?.usage ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Older gateways do not implement /user/usage at all: a 404 hides the
        // strip; any other failure says so without pretending the numbers are zero.
        if (!(err instanceof ApiError) || err.status !== 404) setUsageUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionLoading, sessionError, user, router]);

  // Catalog and health are public data about the gateway. They only need the
  // session, not the gateway key, so the rows appear as soon as /me answers.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    api
      .get<{ providers?: ProviderInfo[] }>('/providers')
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.providers) ? res.providers.map(toProviderDef) : [];
        if (list.length > 0) setProviders(list);
        setCatalogError('');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Keep the fallback rows, but never silently: the rows below are the built-in
        // three, not what the gateway holds.
        setCatalogError(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'the gateway did not answer',
        );
      });

    api
      .get<ProvidersHealthResponse>('/providers/health')
      .then((res) => {
        if (cancelled) return;
        setHealth(res?.providers ?? {});
      })
      .catch(() => {
        /* health is a bonus signal; missing it must not block key management */
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  function providerName(id: string): string {
    return providers.find((provider) => ownsProvider(provider, id))?.name ?? id;
  }

  function healthFor(provider: ProviderDef): ProviderHealth | undefined {
    return health[provider.id] ?? provider.aliases.map((alias) => health[alias]).find(Boolean);
  }

  /**
   * The key is fetched only when the user reveals or copies it. Keeping it in
   * memory means a reload never restores it, and nothing writes it to disk.
   */
  async function loadGatewayKey(): Promise<string | null> {
    if (gatewayKey !== null) return gatewayKey;

    setKeyLoading(true);
    setKeyNotRecoverable(false);
    try {
      const res = await api.get<GatewayKeyResponse>('/user/gateway-key');
      const key = res?.gateway_api_key ?? null;
      if (key === null) {
        // A legacy hash-only account: the key still authenticates, but the
        // server has no copy it can show.
        setKeyNotRecoverable(true);
        return null;
      }
      setGatewayKey(key);
      return key;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not fetch the gateway key');
      return null;
    } finally {
      setKeyLoading(false);
    }
  }

  async function toggleReveal() {
    if (keyRevealed) {
      setKeyRevealed(false);
      return;
    }
    if ((await loadGatewayKey()) !== null) setKeyRevealed(true);
  }

  async function copyGatewayKey() {
    const key = gatewayKey ?? (await loadGatewayKey());
    if (key === null) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError('Could not copy to clipboard');
    }
  }

  function openRegen() {
    setRegenError('');
    setRegenPassword('');
    setRegenOpen(true);
  }

  function closeRegen() {
    if (regenLoading) return;
    setRegenOpen(false);
    setRegenPassword('');
    setRegenError('');
  }

  async function handleRegenerateKey(e: FormEvent) {
    e.preventDefault();
    const username = user?.username;
    if (!username) return;
    if (!regenPassword) {
      setRegenError('Password is required to regenerate your key');
      return;
    }

    setRegenLoading(true);
    setRegenError('');

    try {
      const data = await api.post<RegenerateKeyResponse>('/auth/regenerate-key', {
        username,
        password: regenPassword,
      });

      setGatewayKey(data.gateway_api_key);
      setKeyRevealed(true);
      setKeyNotRecoverable(false);
      setRegenOpen(false);
      setRegenPassword('');
      setCopied(false);
      flashSuccess('Gateway key regenerated. Update any client still using the old key.');
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : 'Failed to regenerate key');
    } finally {
      setRegenLoading(false);
    }
  }

  /** Re-read the key list. The server is the source of truth for what exists. */
  async function refreshKeys(): Promise<void> {
    const res = await api.get<ListKeysResponse>('/user/keys');
    setKeys(normalizeKeyList(res));
  }

  async function submitProviderKey(providerId: string) {
    if (!user) {
      setError('Please log in to manage provider keys');
      return;
    }
    const value = (values[providerId] ?? '').trim();
    if (!value) {
      setRowErrors((s) => ({ ...s, [providerId]: 'Paste a key first.' }));
      return;
    }

    setRowErrors((s) => {
      const next = { ...s };
      delete next[providerId];
      return next;
    });
    setOperationLoading((s) => ({ ...s, [providerId]: true }));

    try {
      await api.post<KeySummary>('/user/keys', {
        provider: providerId,
        providerKey: value,
      });

      // Refetch rather than patch local state: a submission appends, so the new
      // key must appear alongside the ones already registered for this provider.
      await refreshKeys();
      setValues((s) => ({ ...s, [providerId]: '' }));
      flashSuccess(`${providerName(providerId)} key saved.`);
    } catch (err) {
      setRowErrors((s) => ({
        ...s,
        [providerId]: err instanceof Error ? err.message : 'Failed to save key',
      }));
    } finally {
      setOperationLoading((s) => ({ ...s, [providerId]: false }));
    }
  }

  async function testKey(key: KeySummary) {
    setTestingKey((s) => ({ ...s, [key.id]: true }));
    setTestErrors((s) => {
      const next = { ...s };
      delete next[key.id];
      return next;
    });
    setTestResults((s) => {
      const next = { ...s };
      delete next[key.id];
      return next;
    });

    try {
      const result = await api.post<KeyTestResult>(`/user/keys/${key.provider}/${key.id}/test`);
      setTestResults((s) => ({ ...s, [key.id]: result }));
    } catch (err) {
      setTestErrors((s) => ({
        ...s,
        [key.id]: err instanceof Error ? err.message : 'Could not run the test',
      }));
    } finally {
      setTestingKey((s) => ({ ...s, [key.id]: false }));
    }
  }

  function requestDelete(key: KeySummary) {
    setDeleteError('');
    setDeleteTarget({ key, providerName: providerName(key.provider) });
  }

  function closeDelete() {
    if (deleteLoading) return;
    setDeleteTarget(null);
    setDeleteError('');
  }

  async function confirmDelete() {
    if (!deleteTarget || !user) return;
    setDeleteLoading(true);
    setDeleteError('');

    try {
      // Per-key delete: removes exactly this key and never the provider's others. The
      // path uses the id the row was stored under, which may be an old alias.
      await api.delete(`/user/keys/${deleteTarget.key.provider}/${deleteTarget.key.id}`);
      const removedName = deleteTarget.providerName;
      setDeleteTarget(null);
      await refreshKeys();
      setTestResults((s) => {
        const next = { ...s };
        delete next[deleteTarget.key.id];
        return next;
      });
      flashSuccess(`${removedName} key removed.`);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete key');
    } finally {
      setDeleteLoading(false);
    }
  }

  function focusFirstProvider() {
    const first = providers.find((provider) => provider.tier === 'free') ?? providers[0];
    if (!first) return;
    inputRefs.current[first.id]?.focus();
  }

  const hasKeys = keys.length > 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-100">Keys</h1>
        <p className="mt-2 text-sm text-slate-400">
          Signed in as <span className="text-slate-200">{user?.username ?? '…'}</span>. Provider
          keys are encrypted before they are stored.
        </p>
      </header>

      {sessionError && (
        <div
          role="alert"
          className="mt-5 flex flex-col gap-3 rounded-xl border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-300 sm:flex-row sm:items-center sm:justify-between"
        >
          <span>{sessionError} — your keys could not be loaded.</span>
          <button type="button" onClick={refreshSession} className={BUTTON}>
            <RefreshCw size={14} />
            Retry
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-5 rounded-xl border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      {success && (
        <div
          role="status"
          className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-300"
        >
          {success}
        </div>
      )}

      {/* Gateway key — the one credential every client needs. */}
      <section
        aria-labelledby="gateway-key-heading"
        className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-5"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 id="gateway-key-heading" className="text-lg font-semibold text-slate-100">
              Gateway key
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Use it as the <code className="font-mono text-xs text-slate-300">api_key</code> in any
              OpenAI client.
            </p>
          </div>
          <button type="button" onClick={openRegen} className={BUTTON} disabled={!user}>
            <RefreshCw size={14} />
            Regenerate key
          </button>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-slate-200">
            {keyLoading
              ? 'Fetching…'
              : gatewayKey !== null && keyRevealed
                ? gatewayKey
                : '••••••••••••••••••••'}
          </code>
          <button
            type="button"
            onClick={toggleReveal}
            disabled={keyLoading || !user}
            aria-pressed={keyRevealed}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-slate-300 transition hover:text-copper-lift disabled:opacity-50"
          >
            {keyRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
            {keyRevealed ? 'Hide' : 'Reveal'}
          </button>
          <button
            type="button"
            onClick={copyGatewayKey}
            disabled={keyLoading || !user}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-slate-300 transition hover:text-copper-lift disabled:opacity-50"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        {keyNotRecoverable && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-sm leading-relaxed text-amber-300"
          >
            This account predates encrypted key storage, so the server cannot show its key. Your
            existing gateway key still works. <strong>Regenerate key</strong> rotates it and
            immediately invalidates the old one — update every client that uses it.
          </div>
        )}

        {(usageLoading || usage !== null || usageUnavailable) && (
          <UsageStrip usage={usage} unavailable={usageUnavailable} />
        )}
      </section>

      {!sessionError && (
        <>
          {catalogError !== '' && (
            <div
              role="alert"
              className="mt-6 rounded-2xl border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm leading-relaxed text-amber-300"
            >
              The full provider catalog could not be loaded ({catalogError}). The built-in providers
              are shown below; the keys you already saved are unaffected.
            </div>
          )}

          {loadingKeys ? (
            <ProviderSkeleton />
          ) : (
            <>
              {!hasKeys && user && <EmptyState onStart={focusFirstProvider} />}

              {(['free', 'credit'] as const).map((tier) => {
                const rows = providers.filter((provider) => provider.tier === tier);
                if (rows.length === 0) return null;

                return (
                  <section key={tier} aria-labelledby={`tier-${tier}`} className="mt-8">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h2 id={`tier-${tier}`} className="text-base font-semibold text-slate-200">
                        {tier === 'free' ? 'Free-tier providers' : 'Credit-based providers'}
                      </h2>
                      <p className="text-sm text-slate-500">
                        {tier === 'free'
                          ? 'Recurring allowances — these keys keep working every day.'
                          : 'One-time signup credit — a key stops working once the balance is spent.'}
                      </p>
                    </div>

                    <ul className="mt-3 overflow-hidden rounded-xl border border-slate-800">
                      {rows.map((provider, index) => {
                        const providerKeys = keys.filter((key) =>
                          ownsProvider(provider, key.provider),
                        );
                        const currentValue = values[provider.id] ?? '';
                        const isOperating = operationLoading[provider.id] === true;

                        return (
                          <li
                            key={provider.id}
                            className={index > 0 ? 'border-t border-slate-800/60' : ''}
                          >
                            <div className="grid gap-5 px-4 py-5 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)] sm:gap-8 sm:px-5">
                              <div>
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                  <h3 className="text-base font-medium text-slate-100">
                                    {provider.name}
                                  </h3>
                                  <HealthMark status={healthFor(provider)} />
                                  {providerKeys.length > 0 && (
                                    <span className="text-xs text-slate-500">
                                      {providerKeys.length}{' '}
                                      {providerKeys.length === 1 ? 'key' : 'keys'}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1.5 max-w-[46ch] text-sm leading-relaxed text-slate-400">
                                  {provider.freeNote}
                                </p>
                                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                  <a
                                    href={provider.signupUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-copper-lift underline-offset-2 hover:underline"
                                  >
                                    Get a key
                                  </a>
                                  {provider.requiresEnv && (
                                    <span className="text-amber-400">
                                      Server also needs {provider.requiresEnv}
                                    </span>
                                  )}
                                </div>
                              </div>

                              <div>
                                {providerKeys.length > 0 && (
                                  <ul className="space-y-2">
                                    {providerKeys.map((key) => (
                                      <li
                                        key={key.id}
                                        className="rounded-lg bg-slate-950/70 px-3 py-3"
                                      >
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                          <div className="min-w-0">
                                            <p className="truncate text-sm font-medium text-slate-200">
                                              {key.label}
                                            </p>
                                            <p className="mt-0.5 truncate font-mono text-xs text-slate-500">
                                              {key.fingerprint.slice(0, 16)}
                                            </p>
                                          </div>
                                          <div className="flex flex-wrap items-center gap-2">
                                            {key.parked ? (
                                              <span className="text-xs text-amber-400">
                                                Parked · back in {formatRetry(key.retry_after_ms)}
                                              </span>
                                            ) : (
                                              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                                                <span
                                                  className="h-1.5 w-1.5 rounded-full bg-current"
                                                  aria-hidden
                                                />
                                                Ready
                                              </span>
                                            )}
                                            <button
                                              type="button"
                                              onClick={() => testKey(key)}
                                              disabled={testingKey[key.id] === true}
                                              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 disabled:opacity-50"
                                              title="Sends one small request through this key"
                                            >
                                              {testingKey[key.id] ? (
                                                <Loader2 className="animate-spin" size={13} />
                                              ) : (
                                                <Play size={13} />
                                              )}
                                              {testingKey[key.id] ? 'Testing…' : 'Test'}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() => requestDelete(key)}
                                              aria-label={`Remove ${key.label}`}
                                              title="Remove this key"
                                              className="rounded-md border border-slate-700 p-1.5 text-red-400 transition hover:border-red-500/50 hover:bg-slate-800"
                                            >
                                              <Trash2 size={13} />
                                            </button>
                                          </div>
                                        </div>

                                        {testResults[key.id] && (
                                          <TestOutcome result={testResults[key.id]} />
                                        )}
                                        {testErrors[key.id] && (
                                          <p
                                            role="alert"
                                            className="mt-2 text-xs leading-relaxed text-red-400"
                                          >
                                            {testErrors[key.id]}
                                          </p>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                )}

                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    submitProviderKey(provider.id);
                                  }}
                                  className={providerKeys.length > 0 ? 'mt-3' : ''}
                                >
                                  <label
                                    htmlFor={`provider-key-${provider.id}`}
                                    className="sr-only"
                                  >
                                    Paste a {provider.name} key
                                  </label>
                                  <div className="flex flex-col gap-2 sm:flex-row">
                                    <input
                                      ref={(node) => {
                                        inputRefs.current[provider.id] = node;
                                      }}
                                      id={`provider-key-${provider.id}`}
                                      type="password"
                                      placeholder={
                                        providerKeys.length > 0
                                          ? `Add another ${provider.name} key`
                                          : `Paste your ${provider.name} key`
                                      }
                                      value={currentValue}
                                      onChange={(e) =>
                                        setValues((s) => ({
                                          ...s,
                                          [provider.id]: e.target.value,
                                        }))
                                      }
                                      autoComplete="off"
                                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-copper"
                                    />
                                    <button
                                      type="submit"
                                      disabled={isOperating || !user}
                                      className={BUTTON}
                                    >
                                      {isOperating && (
                                        <Loader2 className="animate-spin" size={14} />
                                      )}
                                      Add key
                                    </button>
                                  </div>
                                </form>

                                {rowErrors[provider.id] && (
                                  <p
                                    role="alert"
                                    className="mt-2 text-sm leading-relaxed text-red-400"
                                  >
                                    {rowErrors[provider.id]}
                                  </p>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </>
          )}
        </>
      )}

      <Dialog open={regenOpen} onClose={closeRegen} labelledBy="regen-gateway-key-title">
        <h2 id="regen-gateway-key-title" className="text-lg font-semibold text-slate-100">
          Regenerate gateway key
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          This rotates the key immediately. Every client still using the old key stops working until
          it is updated.
        </p>

        <form onSubmit={handleRegenerateKey} className="mt-4 flex flex-col gap-4">
          <div>
            <label htmlFor="regen-password" className="mb-1 block text-sm text-slate-300">
              Password
            </label>
            <input
              id="regen-password"
              type="password"
              required
              value={regenPassword}
              onChange={(e) => setRegenPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-copper"
              autoComplete="current-password"
            />
          </div>

          {regenError && (
            <p role="alert" className="text-sm text-red-400">
              {regenError}
            </p>
          )}

          <div className="mt-1 flex justify-end gap-3">
            <button type="button" onClick={closeRegen} disabled={regenLoading} className={BUTTON}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={regenLoading || !regenPassword}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {regenLoading && <Loader2 className="animate-spin" size={14} />}
              {regenLoading ? 'Regenerating…' : 'Regenerate key'}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog open={deleteTarget !== null} onClose={closeDelete} labelledBy="delete-key-title">
        <h2 id="delete-key-title" className="text-lg font-semibold text-slate-100">
          Remove this key?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          {deleteTarget
            ? `${deleteTarget.key.label} for ${deleteTarget.providerName} stops routing immediately. Other keys for this provider stay in place.`
            : ''}
        </p>

        {deleteError && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {deleteError}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={closeDelete} disabled={deleteLoading} className={BUTTON}>
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmDelete}
            disabled={deleteLoading}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleteLoading && <Loader2 className="animate-spin" size={14} />}
            {deleteLoading ? 'Removing…' : 'Remove key'}
          </button>
        </div>
      </Dialog>
    </div>
  );
}

function HealthMark({ status }: { status?: ProviderHealth }) {
  if (status === undefined) return null;

  const tone =
    status === 'healthy'
      ? 'text-emerald-400'
      : status === 'degraded'
        ? 'text-amber-400'
        : 'text-red-400';
  const label = status === 'healthy' ? 'Healthy' : status === 'degraded' ? 'Degraded' : 'Failing';

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}

function TestOutcome({ result }: { result: KeyTestResult }) {
  if (result.ok) {
    return (
      <p role="status" className="mt-2 text-xs leading-relaxed text-emerald-400">
        Works — {result.model ?? 'a free model'} · {result.latency_ms} ms
        {result.prompt_tokens + result.completion_tokens > 0
          ? ` · ${result.prompt_tokens + result.completion_tokens} tokens`
          : ''}
      </p>
    );
  }

  return (
    <p role="alert" className="mt-2 text-xs leading-relaxed text-red-400">
      Failed
      {result.http_status !== null ? ` (HTTP ${result.http_status})` : ''} —{' '}
      {result.error ?? 'the provider rejected the key'}
    </p>
  );
}

function UsageStrip({ usage, unavailable }: { usage: UsageSummary | null; unavailable: boolean }) {
  if (unavailable) {
    return <p className="mt-4 text-xs text-slate-500">Usage is not available on this gateway.</p>;
  }

  const cells = [
    {
      label: `Requests · ${usage?.window_days ?? 30}d`,
      value: usage ? formatCount(usage.requests) : null,
    },
    { label: 'Tokens', value: usage ? formatCount(usage.total_tokens) : null },
    { label: 'Failovers', value: usage ? formatCount(usage.failovers) : null },
    { label: 'Est. cost', value: usage ? formatCost(usage.cost_usd) : null },
  ];

  return (
    <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-slate-800/60 pt-5 sm:grid-cols-4">
      {cells.map((cell) => (
        <div key={cell.label}>
          <dt className="text-xs text-slate-500">{cell.label}</dt>
          <dd className="mt-1 text-lg font-medium tabular-nums text-slate-100">
            {cell.value ?? (
              <span
                className="inline-block h-6 w-12 rounded bg-slate-800/60 motion-safe:animate-pulse"
                aria-hidden
              />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ProviderSkeleton() {
  return (
    <div role="status" aria-live="polite" className="mt-8 space-y-3">
      <span className="sr-only">Loading provider keys</span>
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-28 rounded-xl border border-slate-800 bg-slate-900/40 motion-safe:animate-pulse"
          aria-hidden
        />
      ))}
    </div>
  );
}

function EmptyState({ onStart }: { onStart: () => void }) {
  const steps = [
    'Pick a free-tier provider below.',
    'Paste the key from its console.',
    'Press Test before you send real traffic.',
  ];

  return (
    <section className="mt-8 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-base font-semibold text-slate-100">Nothing to route with yet</h2>
      <p className="mt-1 max-w-[60ch] text-sm leading-relaxed text-slate-400">
        Your gateway key is ready. Add one provider key and requests can start flowing.
      </p>

      <ol className="mt-4 space-y-2 text-sm text-slate-300">
        {steps.map((step) => (
          <li key={step} className="flex items-start gap-2">
            <Check className="mt-0.5 shrink-0 text-copper" size={16} aria-hidden />
            <span>{step}</span>
          </li>
        ))}
      </ol>

      <button
        type="button"
        onClick={onStart}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-copper px-4 py-2 text-sm font-semibold text-ink transition hover:bg-copper-lift"
      >
        Add your first key
      </button>
    </section>
  );
}

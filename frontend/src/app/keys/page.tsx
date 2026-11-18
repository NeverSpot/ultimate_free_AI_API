'use client';

import { FormEvent, useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, X, Trash2, RefreshCw, Loader2 } from 'lucide-react';
import {
  api,
  type GatewayKeyResponse,
  type KeySummary,
  type ListKeysResponse,
  type RegenerateKeyResponse,
} from '@/lib/api';
import { useSession } from '@/hooks/use-session';

type ProviderId = 'openrouter' | 'nvidia-nim' | 'tokenharbor';

interface ProviderDef {
  id: ProviderId;
  name: string;
}

const PROVIDERS: ProviderDef[] = [
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'nvidia-nim', name: 'NVIDIA NIM' },
  { id: 'tokenharbor', name: 'TokenHarbor' },
];

function getProviderName(id: ProviderId): string {
  const p = PROVIDERS.find((item) => item.id === id);
  return p ? p.name : id;
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

// The gateway key stays in localStorage through `useSyncExternalStore`: the
// server snapshot is null, so the first client render matches the server HTML,
// and React re-renders with the stored key after hydration. Auth itself comes
// from the session cookie via `useSession`, never from localStorage.
const STORAGE_CHANGE_EVENT = 'gateway-storage-change';

function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(STORAGE_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(STORAGE_CHANGE_EVENT, onChange);
  };
}

function readGatewayKeySnapshot(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('gateway_api_key') || localStorage.getItem('gateway_key');
}

function getServerSnapshot(): string | null {
  return null;
}

function storeGatewayKey(key: string): void {
  localStorage.setItem('gateway_api_key', key);
  localStorage.setItem('gateway_key', key);
  window.dispatchEvent(new Event(STORAGE_CHANGE_EVENT));
}

export default function KeysPage() {
  const router = useRouter();
  const { user, loading: sessionLoading, error: sessionError } = useSession();

  const gatewayKey = useSyncExternalStore(
    subscribeToStorage,
    readGatewayKeySnapshot,
    getServerSnapshot,
  );

  const [fingerprints, setFingerprints] = useState<Record<ProviderId, string>>({
    openrouter: '',
    'nvidia-nim': '',
    tokenharbor: '',
  });

  // Every key the user has registered. A provider may hold several, so this list —
  // not the single-fingerprint map above — is what the table renders.
  const [keys, setKeys] = useState<KeySummary[]>([]);

  const [values, setValues] = useState<Record<ProviderId, string>>({
    openrouter: '',
    'nvidia-nim': '',
    tokenharbor: '',
  });

  const [editMode, setEditMode] = useState<Record<ProviderId, boolean>>({
    openrouter: false,
    'nvidia-nim': false,
    tokenharbor: false,
  });

  const [operationLoading, setOperationLoading] = useState<Record<ProviderId, boolean>>({
    openrouter: false,
    'nvidia-nim': false,
    tokenharbor: false,
  });

  const [loadingKeys, setLoadingKeys] = useState(true);
  const [keyRestoreDone, setKeyRestoreDone] = useState(false);
  const [keyNotRecoverable, setKeyNotRecoverable] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Regenerate Key modal state
  const [showRegenModal, setShowRegenModal] = useState(false);
  const [regenPassword, setRegenPassword] = useState('');
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenError, setRegenError] = useState('');

  useEffect(() => {
    if (sessionLoading || sessionError) return; // still checking /me, or /me errored
    if (!user) {
      router.push('/login');
      return;
    }

    let cancelled = false;

    // Restore the gateway key from the server so clearing localStorage does not
    // hide it while the session cookie is still valid. Best-effort: a legacy
    // account returns null and keeps whatever the banner below says.
    api
      .get<GatewayKeyResponse>('/user/gateway-key')
      .then((res) => {
        if (cancelled) return;
        if (res?.gateway_api_key) {
          storeGatewayKey(res.gateway_api_key);
        } else {
          // A legacy hash-only account: the key exists and still authenticates,
          // but the server has no copy it can show.
          setKeyNotRecoverable(true);
        }
      })
      .catch(() => {
        /* non-fatal: the local mirror or the banner covers it */
      })
      .finally(() => {
        if (!cancelled) setKeyRestoreDone(true);
      });

    api
      .get<ListKeysResponse>('/user/keys')
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.keys) ? res.keys : [];
        setKeys(list);
        const map: Record<ProviderId, string> = {
          openrouter: '',
          'nvidia-nim': '',
          tokenharbor: '',
        };
        for (const item of list) {
          if (item.provider in map && item.fingerprint) {
            map[item.provider as ProviderId] = item.fingerprint;
          }
        }
        setFingerprints(map);
        setError('');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load provider keys');
      })
      .finally(() => {
        if (!cancelled) setLoadingKeys(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionLoading, sessionError, user, router]);

  async function copyGatewayKey() {
    if (!gatewayKey) return;
    try {
      await navigator.clipboard.writeText(gatewayKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard');
    }
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

      storeGatewayKey(data.gateway_api_key);

      setShowRegenModal(false);
      setRegenPassword('');
      setSuccess('New gateway key generated successfully!');
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : 'Failed to regenerate key');
    } finally {
      setRegenLoading(false);
    }
  }

  /** Re-read the key list. The server is the source of truth for what exists. */
  async function refreshKeys(): Promise<void> {
    const res = await api.get<ListKeysResponse>('/user/keys');
    const list = Array.isArray(res?.keys) ? res.keys : [];
    setKeys(list);
    const map: Record<ProviderId, string> = {
      openrouter: '',
      'nvidia-nim': '',
      tokenharbor: '',
    };
    for (const item of list) {
      if (item.provider in map && item.fingerprint) {
        map[item.provider as ProviderId] = item.fingerprint;
      }
    }
    setFingerprints(map);
  }

  async function submitProviderKey(provider: ProviderId) {
    if (!user) {
      setError('Please log in to manage provider keys');
      return;
    }
    const value = values[provider].trim();
    if (!value) {
      setError('Enter a provider key first');
      return;
    }
    setError('');
    setOperationLoading((s) => ({ ...s, [provider]: true }));

    try {
      await api.post<KeySummary>('/user/keys', {
        provider,
        providerKey: value,
      });

      // Refetch rather than patch local state: a submission appends, so the new
      // key must appear alongside the ones already registered for this provider.
      await refreshKeys();
      setValues((s) => ({ ...s, [provider]: '' }));
      setEditMode((s) => ({ ...s, [provider]: false }));
      setSuccess(`${getProviderName(provider)} key saved successfully`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setOperationLoading((s) => ({ ...s, [provider]: false }));
    }
  }

  async function deleteKey(provider: ProviderId, keyId: string) {
    if (!user) {
      setError('Please log in to manage provider keys');
      return;
    }
    setError('');
    setOperationLoading((s) => ({ ...s, [provider]: true }));

    try {
      // Per-key delete: removes exactly this key and never the provider's others.
      await api.delete(`/user/keys/${provider}/${keyId}`);
      await refreshKeys();
      setSuccess(`${getProviderName(provider)} key removed`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete key');
    } finally {
      setOperationLoading((s) => ({ ...s, [provider]: false }));
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-100">Your gateway key</h1>
        <p className="mt-1 text-sm text-slate-400">
          Signed in as <span className="text-slate-200">{user?.username ?? '…'}</span>
        </p>
      </div>

      {sessionError && (
        <div className="mb-4 rounded-xl border border-red-500/30 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          {sessionError}
        </div>
      )}

      {/* Gateway key banner/box */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-lg">
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">
          Personal Gateway API Key
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <code className="break-all rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm font-mono text-slate-200">
            {gatewayKey ?? '…'}
          </code>
          <div className="flex gap-2">
            <button
              onClick={copyGatewayKey}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={() => {
                setRegenError('');
                setRegenPassword('');
                setShowRegenModal(true);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700"
            >
              <RefreshCw size={16} />
              Get New
            </button>
          </div>
        </div>
      </div>

      {!gatewayKey && user && keyRestoreDone && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
          {keyNotRecoverable ? (
            <>
              This account was created before encrypted key storage, so the server cannot show its
              key here. Your existing gateway key still works. <strong>Get New</strong> rotates it
              and immediately invalidates the old one — update every client that uses it.
            </>
          ) : (
            <>
              No gateway API key is stored in this browser, and it could not be restored from the
              server. Reload the page to try again, or click <strong>Get New</strong> to issue one.
            </>
          )}
        </div>
      )}

      {/* Status messages */}
      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-400">
          {success}
        </div>
      )}

      {/* Provider Keys table */}
      <div className="mt-8 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-100">Provider keys</h2>
          <p className="mt-1 text-sm text-slate-400">
            Add your upstream provider keys to enable free-tier routing. Stored keys are encrypted
            with AES-256-GCM.
          </p>
        </div>

        {loadingKeys && !sessionError ? (
          <div className="flex items-center justify-center p-12 text-slate-400">
            <Loader2 className="animate-spin mr-2" size={20} />
            Loading provider keys…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 font-medium">Key</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {PROVIDERS.map((provider) => {
                  const providerKeys = keys.filter((key) => key.provider === provider.id);
                  const isConfigured = providerKeys.length > 0;
                  const isEditing = editMode[provider.id];
                  const currentValue = values[provider.id];
                  const isOperating = operationLoading[provider.id];

                  return (
                    <tr key={provider.id} className="align-middle">
                      <td className="px-5 py-4 font-medium text-slate-200">{provider.name}</td>
                      <td className="px-5 py-4">
                        {providerKeys.length > 0 && (
                          <ul className="mb-3 space-y-2">
                            {providerKeys.map((key) => (
                              <li
                                key={key.id}
                                className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-medium text-slate-200">
                                    {key.label}
                                  </p>
                                  <p className="truncate font-mono text-[0.65rem] text-slate-500">
                                    {key.fingerprint.slice(0, 16)}
                                  </p>
                                </div>
                                <div className="flex items-center gap-2">
                                  {key.parked ? (
                                    <span
                                      className="whitespace-nowrap text-[0.65rem] font-medium text-amber-400"
                                      title="The provider throttled this key"
                                    >
                                      throttled · back in {formatRetry(key.retry_after_ms)}
                                    </span>
                                  ) : (
                                    <span className="whitespace-nowrap text-[0.65rem] font-medium text-emerald-400">
                                      available
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => deleteKey(provider.id, key.id)}
                                    disabled={isOperating || !user}
                                    className="rounded-lg border border-slate-700 p-1.5 text-red-400 hover:bg-slate-800 disabled:opacity-50"
                                    aria-label={`Remove ${key.label}`}
                                    title="Remove this key"
                                  >
                                    {isOperating ? (
                                      <Loader2 className="animate-spin" size={14} />
                                    ) : (
                                      <Trash2 size={14} />
                                    )}
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            submitProviderKey(provider.id);
                          }}
                        >
                          <input
                            type="password"
                            placeholder={
                              isConfigured && !isEditing
                                ? `Add another ${provider.name} key`
                                : 'Paste provider key here'
                            }
                            value={currentValue}
                            onChange={(e) =>
                              setValues((s) => ({
                                ...s,
                                [provider.id]: e.target.value,
                              }))
                            }
                            className="w-full min-w-[200px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-copper"
                            autoComplete="off"
                          />
                        </form>
                      </td>
                      <td className="px-5 py-4">
                        {isConfigured ? (
                          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-400">
                            <Check size={16} /> {providerKeys.length}{' '}
                            {providerKeys.length === 1 ? 'key' : 'keys'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-slate-500">
                            <X size={16} /> Not set
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => submitProviderKey(provider.id)}
                            disabled={isOperating || !currentValue.trim() || !user}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700 disabled:opacity-50"
                          >
                            {isOperating && <Loader2 className="animate-spin" size={14} />}
                            Add key
                          </button>
                          {isEditing && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditMode((s) => ({
                                  ...s,
                                  [provider.id]: false,
                                }));
                                setValues((s) => ({
                                  ...s,
                                  [provider.id]: '',
                                }));
                              }}
                              className="rounded-lg border border-slate-700 px-2.5 py-2 text-xs text-slate-400 hover:bg-slate-800"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Password confirmation dialog for key regeneration */}
      {showRegenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-slate-100">Regenerate Gateway API Key</h3>
            <p className="mt-2 text-sm text-slate-400">
              Generating a new gateway API key will immediately invalidate your existing key. Please
              confirm your password to proceed.
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
                  autoFocus
                />
              </div>

              {regenError && <p className="text-sm text-red-400">{regenError}</p>}

              <div className="mt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowRegenModal(false);
                    setRegenPassword('');
                    setRegenError('');
                  }}
                  disabled={regenLoading}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={regenLoading || !regenPassword}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
                >
                  {regenLoading && <Loader2 className="animate-spin" size={16} />}
                  {regenLoading ? 'Regenerating…' : 'Regenerate Key'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

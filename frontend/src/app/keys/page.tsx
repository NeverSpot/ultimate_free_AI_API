"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, X, Edit2, Trash2 } from "lucide-react";
import { api } from "@/lib/api";

type Provider = {
  id: "openrouter" | "nvidia-nim" | "tokenharbor";
  name: string;
};

const PROVIDERS: Provider[] = [
  { id: "openrouter", name: "OpenRouter" },
  { id: "nvidia-nim", name: "NVIDIA NIM" },
  { id: "tokenharbor", name: "TokenHarbor" },
];

export default function KeysPage() {
  const router = useRouter();
  const [gatewayKey, setGatewayKey] = useState<string | null>(null);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState<Record<Provider["id"], boolean>>({
    openrouter: false,
    "nvidia-nim": false,
    tokenharbor: false,
  });
  const [editMode, setEditMode] = useState<Record<Provider["id"], boolean>>({
    openrouter: false,
    "nvidia-nim": false,
    tokenharbor: false,
  });
  const [values, setValues] = useState<Record<Provider["id"], string>>({
    openrouter: "",
    "nvidia-nim": "",
    tokenharbor: "",
  });
  const [saved, setSaved] = useState<Record<Provider["id"], boolean>>({
    openrouter: false,
    "nvidia-nim": false,
    tokenharbor: false,
  });
  const [error, setError] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = localStorage.getItem("gateway_key");
    const rawUser = localStorage.getItem("user");
    if (!key || !rawUser) {
      router.push("/login");
      return;
    }
    setGatewayKey(key);
    try {
      setUser(JSON.parse(rawUser));
    } catch {
      setUser({ username: "user" });
    }
  }, [router]);

  async function copyGatewayKey() {
    if (!gatewayKey) return;
    try {
      await navigator.clipboard.writeText(gatewayKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  function getNewGatewayKey() {
    // The backend regenerate flow is handled by the auth route.
    // For the scaffold we generate a client-side marker and ask the user to re-auth.
    setError("To get a new gateway key, sign out and sign in again or use the regenerate endpoint.");
  }

  async function submitProviderKey(provider: Provider["id"]) {
    const value = values[provider].trim();
    if (!value) {
      setError("Enter a provider key first");
      return;
    }
    setError("");
    setLoadingKeys((s) => ({ ...s, [provider]: true }));
    try {
      await api.post("/keys", { provider, key: value });
      setSaved((s) => ({ ...s, [provider]: true }));
      setValues((s) => ({ ...s, [provider]: "" }));
      setEditMode((s) => ({ ...s, [provider]: false }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setLoadingKeys((s) => ({ ...s, [provider]: false }));
    }
  }

  async function deleteProviderKey(provider: Provider["id"]) {
    setError("");
    setLoadingKeys((s) => ({ ...s, [provider]: true }));
    try {
      await api.delete(`/keys/${provider}`);
      setSaved((s) => ({ ...s, [provider]: false }));
      setValues((s) => ({ ...s, [provider]: "" }));
      setEditMode((s) => ({ ...s, [provider]: false }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete key");
    } finally {
      setLoadingKeys((s) => ({ ...s, [provider]: false }));
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Your gateway key</h1>
          <p className="mt-1 text-sm text-slate-400">
            Signed in as <span className="text-slate-200">{user?.username ?? "…"}</span>
          </p>
        </div>
        <button
          onClick={() => {
            localStorage.clear();
            router.push("/login");
          }}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
        >
          Sign out
        </button>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <code className="break-all rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200">
            {gatewayKey ?? "…"}
          </code>
          <div className="flex gap-2">
            <button
              onClick={copyGatewayKey}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={getNewGatewayKey}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700"
            >
              Get New
            </button>
          </div>
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      <div className="mt-8 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-100">Provider keys</h2>
          <p className="mt-1 text-sm text-slate-400">
            Add a key to enable that provider. Empty field = new key.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="px-5 py-3 font-medium">Provider</th>
                <th className="px-5 py-3 font-medium">Key</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {PROVIDERS.map((provider) => {
                const isSaved = saved[provider.id];
                const isEditing = editMode[provider.id];
                const currentValue = values[provider.id];
                const isLoading = loadingKeys[provider.id];

                return (
                  <tr key={provider.id} className="align-middle">
                    <td className="px-5 py-4 font-medium text-slate-200">{provider.name}</td>
                    <td className="px-5 py-4">
                      <form onSubmit={onSubmit}>
                        <input
                          type="password"
                          placeholder={isSaved ? "••••••••" : "Paste key here"}
                          value={currentValue}
                          onChange={(e) =>
                            setValues((s) => ({ ...s, [provider.id]: e.target.value }))
                          }
                          className="w-full min-w-[180px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
                          autoComplete="off"
                        />
                      </form>
                    </td>
                    <td className="px-5 py-4">
                      {isSaved ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400">
                          <Check size={16} /> Submitted
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-slate-500">
                          <X size={16} /> Not set
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        {isSaved && !isEditing ? (
                          <>
                            <button
                              onClick={() => setEditMode((s) => ({ ...s, [provider.id]: true }))}
                              className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"
                              aria-label="Edit"
                              title="Edit"
                            >
                              <Edit2 size={16} />
                            </button>
                            <button
                              onClick={() => deleteProviderKey(provider.id)}
                              className="rounded-lg border border-slate-700 p-2 text-red-400 hover:bg-slate-800"
                              aria-label="Delete"
                              title="Delete"
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => submitProviderKey(provider.id)}
                            disabled={isLoading || !currentValue.trim()}
                            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700 disabled:opacity-50"
                          >
                            {isSaved ? "Update" : "Submit"}
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
      </div>
    </div>
  );
}

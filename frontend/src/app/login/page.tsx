'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy } from 'lucide-react';
import { api, type LoginResponse, type RegisterResponse } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [tab, setTab] = useState<'signin' | 'register'>(() => {
    if (typeof window === 'undefined') return 'signin';
    const params = new URLSearchParams(window.location.search);
    return params.get('tab') === 'register' ? 'register' : 'signin';
  });

  // Sign-in state
  const [signInUsername, setSignInUsername] = useState('');
  const [signInPassword, setSignInPassword] = useState('');

  // Register state
  const [registerUsername, setRegisterUsername] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registeredKey, setRegisteredKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Common status
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSignInSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await api.post<LoginResponse>('/auth/login', {
        username: signInUsername.trim(),
        password: signInPassword,
      });

      const user = { userId: data.userId, username: data.username };
      localStorage.setItem('user', JSON.stringify(user));

      router.push('/keys');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  }

  async function onRegisterSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');

    const username = registerUsername.trim();
    const email = registerEmail.trim();
    const password = registerPassword;

    if (!username) {
      setError('Username is required');
      return;
    }
    if (!email || !email.includes('@')) {
      setError('Valid email address is required');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }

    setLoading(true);

    try {
      const data = await api.post<RegisterResponse>('/auth/register', {
        username,
        email,
        password,
      });

      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('gateway_api_key', data.gateway_api_key);
      localStorage.setItem('gateway_key', data.gateway_api_key);
      setRegisteredKey(data.gateway_api_key);

      router.push('/keys');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  async function copyRegisteredKey() {
    if (!registeredKey) return;
    try {
      await navigator.clipboard.writeText(registeredKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      setError('Could not copy to clipboard');
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-20">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
        {/* Tabs */}
        <div className="mb-6 flex border-b border-slate-800">
          <button
            type="button"
            onClick={() => {
              setTab('signin');
              setError('');
            }}
            className={`flex-1 pb-3 text-center text-sm font-medium transition ${
              tab === 'signin'
                ? 'border-b-2 border-slate-100 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('register');
              setError('');
            }}
            className={`flex-1 pb-3 text-center text-sm font-medium transition ${
              tab === 'register'
                ? 'border-b-2 border-slate-100 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Create Account
          </button>
        </div>

        {tab === 'signin' ? (
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Sign in</h1>
            <p className="mt-1 text-sm text-slate-400">
              Enter your username and password to access your keys.
            </p>

            <form onSubmit={onSignInSubmit} className="mt-6 flex flex-col gap-4">
              <div>
                <label htmlFor="signin-username" className="mb-1 block text-sm text-slate-300">
                  Username
                </label>
                <input
                  id="signin-username"
                  type="text"
                  required
                  value={signInUsername}
                  onChange={(e) => setSignInUsername(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
                  autoComplete="username"
                />
              </div>

              <div>
                <label htmlFor="signin-password" className="mb-1 block text-sm text-slate-300">
                  Password
                </label>
                <input
                  id="signin-password"
                  type="password"
                  required
                  value={signInPassword}
                  onChange={(e) => setSignInPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
                  autoComplete="current-password"
                />
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="mt-2 rounded-lg bg-slate-100 px-4 py-2 font-medium text-slate-900 transition hover:bg-white disabled:opacity-60"
              >
                {loading ? 'Signing in…' : 'Sign In'}
              </button>
            </form>
          </div>
        ) : (
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Create an account</h1>
            <p className="mt-1 text-sm text-slate-400">
              Register to get your personal gateway API key.
            </p>

            {registeredKey && (
              <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-4">
                <p className="text-sm font-medium text-emerald-400">
                  Account created successfully!
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Save your gateway API key now. It is shown only once in plaintext.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="flex-1 break-all rounded border border-slate-800 bg-slate-950 p-2 text-xs text-slate-200">
                    {registeredKey}
                  </code>
                  <button
                    type="button"
                    onClick={copyRegisteredKey}
                    className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-200 hover:bg-slate-700"
                  >
                    {copiedKey ? <Check size={14} /> : <Copy size={14} />}
                    {copiedKey ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            <form onSubmit={onRegisterSubmit} className="mt-6 flex flex-col gap-4">
              <div>
                <label htmlFor="register-username" className="mb-1 block text-sm text-slate-300">
                  Username
                </label>
                <input
                  id="register-username"
                  type="text"
                  required
                  value={registerUsername}
                  onChange={(e) => setRegisterUsername(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
                  autoComplete="username"
                />
              </div>

              <div>
                <label htmlFor="register-email" className="mb-1 block text-sm text-slate-300">
                  Email
                </label>
                <input
                  id="register-email"
                  type="email"
                  required
                  value={registerEmail}
                  onChange={(e) => setRegisterEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
                  autoComplete="email"
                />
              </div>

              <div>
                <label htmlFor="register-password" className="mb-1 block text-sm text-slate-300">
                  Password (min. 8 characters)
                </label>
                <input
                  id="register-password"
                  type="password"
                  required
                  minLength={8}
                  value={registerPassword}
                  onChange={(e) => setRegisterPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
                  autoComplete="new-password"
                />
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="mt-2 rounded-lg bg-slate-100 px-4 py-2 font-medium text-slate-900 transition hover:bg-white disabled:opacity-60"
              >
                {loading ? 'Creating account…' : 'Create Account'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

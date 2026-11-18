'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, Copy } from 'lucide-react';
import {
  api,
  oauthStartUrl,
  type LoginResponse,
  type OAuthProvidersResponse,
  type RegisterResponse,
  type RegisterStartedResponse,
} from '@/lib/api';
import { useSession } from '@/hooks/use-session';

/** The API redirects back with a short code; the UI owns the human wording. */
const OAUTH_ERRORS: Record<string, string> = {
  oauth_cancelled: 'Sign-in was cancelled.',
  oauth_state_mismatch: 'That sign-in link expired. Please try again.',
  email_unverified: 'Your provider has not verified that email address.',
  email_unavailable: 'That account has no verified email address to sign in with.',
  oauth_not_configured: 'That sign-in method is not available right now.',
  oauth_failed: 'Could not complete sign-in. Please try again.',
};

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.55v-1.94c-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .3.2.66.8.55A11.5 11.5 0 0 0 23.5 12A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3.01h3.87c2.26-2.09 3.55-5.17 3.55-8.88z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.94-2.91l-3.87-3.01c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.27a7.2 7.2 0 0 1 0-4.54V6.64H1.29a12 12 0 0 0 0 10.72l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.64l3.98 3.09C6.22 6.88 8.87 4.77 12 4.77z"
      />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center px-4 py-20">
          <div className="h-9 w-72 animate-pulse rounded-xl bg-slate-800/60" />
        </div>
      }
    >
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab: 'signin' | 'register' = searchParams.get('tab') === 'register' ? 'register' : 'signin';
  const setTab = (next: 'signin' | 'register') =>
    router.replace(next === 'register' ? '/login?tab=register' : '/login');

  // The session cookie is httpOnly and scoped to `/v1/user/*`, so the server
  // render cannot tell whether the visitor is signed in. Probe the session and
  // bounce authenticated visitors to the keys dashboard.
  const { user: sessionUser, loading: sessionLoading } = useSession();

  // Sign-in state
  const [signInUsername, setSignInUsername] = useState('');
  const [signInPassword, setSignInPassword] = useState('');

  // Register state. `verify` is a real step, not a modal: the account does not
  // exist until the code from the email is accepted.
  const [registerStep, setRegisterStep] = useState<'details' | 'verify'>('details');
  const [registerUsername, setRegisterUsername] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [registeredKey, setRegisteredKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Which providers the API actually has credentials for.
  const [providers, setProviders] = useState<Array<'google' | 'github'>>([]);

  // Common status
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const oauthError = searchParams.get('error');

  // Signed-in visitors never see the auth form. `replace` (not `push`) keeps
  // /login out of the back-button history, so Back cannot land here again.
  useEffect(() => {
    if (!sessionLoading && sessionUser) {
      router.replace('/keys');
    }
  }, [sessionLoading, sessionUser, router]);

  useEffect(() => {
    api
      .get<OAuthProvidersResponse>('/auth/providers')
      .then((data) => setProviders(data.providers))
      .catch(() => setProviders([]));
  }, []);

  // Resend countdown. The interval lives in the effect, so it stops on unmount.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  function startOAuth(provider: 'google' | 'github') {
    // Full-page navigation: the OAuth state cookie must travel with it.
    window.location.href = oauthStartUrl(provider);
  }

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
      // The server re-issues the same gateway key on every login, so the client
      // just stores what it was given. No key loss across sign-out or devices.
      localStorage.removeItem('gateway_api_key');
      localStorage.removeItem('gateway_key');
      if (data.gateway_api_key) {
        localStorage.setItem('gateway_api_key', data.gateway_api_key);
        localStorage.setItem('gateway_key', data.gateway_api_key);
      }
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
    const email = registerEmail.trim().toLowerCase();
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
      const data = await api.post<RegisterStartedResponse>('/auth/register', {
        username,
        email,
        password,
      });

      // Nothing exists server-side yet: hold the address and show the code form.
      setPendingEmail(data.email);
      setOtpCode('');
      setDevCode(data.dev_code ?? null);
      setResendIn(60);
      setRegisterStep('verify');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  async function onVerifySubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');

    const code = otpCode.replace(/\D/g, '');
    if (code.length !== 6) {
      setError('Enter the 6-digit code from the email');
      return;
    }

    setLoading(true);

    try {
      const data = await api.post<RegisterResponse>('/auth/register/verify', {
        email: pendingEmail,
        code,
      });

      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('gateway_api_key', data.gateway_api_key);
      localStorage.setItem('gateway_key', data.gateway_api_key);
      setRegisteredKey(data.gateway_api_key);
      setRegisterStep('details');
      setRegisterPassword('');

      router.push('/keys');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setLoading(false);
    }
  }

  async function onResend() {
    if (resendIn > 0) return;
    setError('');
    setLoading(true);

    try {
      const data = await api.post<RegisterStartedResponse>('/auth/register/resend', {
        email: pendingEmail,
      });
      setDevCode(data.dev_code ?? null);
      setResendIn(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend the code');
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

  // Hold the placeholder while the probe runs and the redirect is in flight,
  // so a signed-in visitor never sees the form flash before /keys loads.
  if (sessionLoading || sessionUser) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-20">
        <div className="h-9 w-72 animate-pulse rounded-xl bg-slate-800/60" />
      </div>
    );
  }

  const visibleError =
    error || (oauthError ? (OAUTH_ERRORS[oauthError] ?? OAUTH_ERRORS.oauth_failed) : '');

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
              setRegisterStep('details');
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

        {providers.length > 0 && (
          <div className="mb-6 flex flex-col gap-2">
            {providers.includes('google') && (
              <button
                type="button"
                onClick={() => startOAuth('google')}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500"
              >
                <GoogleIcon />
                Continue with Google
              </button>
            )}
            {providers.includes('github') && (
              <button
                type="button"
                onClick={() => startOAuth('github')}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500"
              >
                <GitHubIcon />
                Continue with GitHub
              </button>
            )}
            <div className="my-2 flex items-center gap-3 text-xs text-slate-500">
              <span className="h-px flex-1 bg-slate-800" />
              or use email
              <span className="h-px flex-1 bg-slate-800" />
            </div>
          </div>
        )}

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
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-copper"
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
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-copper"
                  autoComplete="current-password"
                />
              </div>

              {visibleError && <p className="text-sm text-red-400">{visibleError}</p>}

              <button
                type="submit"
                disabled={loading}
                className="mt-2 rounded-lg bg-copper px-4 py-2 font-medium text-ink transition hover:bg-copper-lift disabled:opacity-60"
              >
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          </div>
        ) : registerStep === 'verify' ? (
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Check your email</h1>
            <p className="mt-1 text-sm text-slate-400">
              We sent a 6-digit code to <span className="text-slate-200">{pendingEmail}</span>. The
              code expires in 10 minutes.
            </p>

            {devCode && (
              <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/40 p-2 text-xs text-amber-300">
                Development mode: your code is <span className="font-mono">{devCode}</span>
              </p>
            )}

            <form onSubmit={onVerifySubmit} className="mt-6 flex flex-col gap-4">
              <div>
                <label htmlFor="register-code" className="mb-1 block text-sm text-slate-300">
                  Verification code
                </label>
                <input
                  id="register-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-center font-mono text-xl tracking-[0.5em] text-slate-100 outline-none focus:border-copper"
                  placeholder="000000"
                />
              </div>

              {visibleError && <p className="text-sm text-red-400">{visibleError}</p>}

              <button
                type="submit"
                disabled={loading}
                className="rounded-lg bg-copper px-4 py-2 font-medium text-ink transition hover:bg-copper-lift disabled:opacity-60"
              >
                {loading ? 'Verifying...' : 'Verify and create account'}
              </button>

              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setRegisterStep('details');
                    setError('');
                  }}
                  className="text-slate-400 hover:text-slate-200"
                >
                  Use a different email
                </button>
                <button
                  type="button"
                  onClick={onResend}
                  disabled={resendIn > 0 || loading}
                  className="text-slate-400 hover:text-slate-200 disabled:opacity-50"
                >
                  {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
                </button>
              </div>
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
                  This is your gateway API key. You can view it any time on the Keys page.
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
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-copper"
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
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-copper"
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
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-copper"
                  autoComplete="new-password"
                />
              </div>

              {visibleError && <p className="text-sm text-red-400">{visibleError}</p>}

              <button
                type="submit"
                disabled={loading}
                className="mt-2 rounded-lg bg-copper px-4 py-2 font-medium text-ink transition hover:bg-copper-lift disabled:opacity-60"
              >
                {loading ? 'Sending code...' : 'Create Account'}
              </button>
              <p className="text-center text-xs text-slate-500">
                We will email a 6-digit code to confirm the address before the account is created.
              </p>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

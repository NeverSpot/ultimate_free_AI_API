'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, type SessionUser } from '@/lib/api';

interface SessionState {
  user: SessionUser | null;
  loading: boolean;
  error: string | null;
  /** Re-probe `/user/me` after login, logout or a transient failure. */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

interface SessionResult {
  user: SessionUser | null;
  error: string | null;
}

/**
 * One in-flight probe for the whole browser session.
 *
 * Module scope, not React state, is what makes "one `/me` per page load" true
 * even under React Strict Mode's double effect: the second consumer joins the
 * promise the first one started. `refresh()` clears it on purpose.
 */
let sessionPromise: Promise<SessionResult> | null = null;

function readSession(): Promise<SessionResult> {
  sessionPromise ??= api
    .get<SessionUser>('/user/me')
    .then((user): SessionResult => ({ user, error: null }))
    .catch((error: unknown): SessionResult => {
      if (error instanceof ApiError && error.status === 401) {
        // Signed out is a valid answer, not a failure to report.
        return { user: null, error: null };
      }
      // A transport or server failure must stay retryable.
      sessionPromise = null;
      return {
        user: null,
        error: error instanceof Error ? error.message : 'Could not reach the server',
      };
    });
  return sessionPromise;
}

/**
 * The session lives in the root layout, above every page and the header, so
 * AuthNav, the landing CTAs, /login and /keys all read the same probe instead
 * of each firing their own. The cookie is httpOnly, so the browser learns who
 * the user is only by asking the API — but it asks once per load.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let alive = true;

    readSession()
      .then((result) => {
        if (!alive) return;
        setUser(result.user);
        setError(result.error);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      mounted.current = false;
    };
  }, []);

  // The gateway key used to live in localStorage in three shapes. This is the
  // single cleanup point: the key now stays in memory on /keys and is fetched
  // from the server on demand, so stale copies must not survive a deploy.
  useEffect(() => {
    try {
      localStorage.removeItem('gateway_api_key');
      localStorage.removeItem('gateway_key');
      localStorage.removeItem('user');
    } catch {
      /* storage can be blocked; there is nothing to clean up in that case */
    }
  }, []);

  const refresh = useCallback(async () => {
    sessionPromise = null;
    if (mounted.current) {
      setLoading(true);
      setError(null);
    }
    const result = await readSession();
    if (!mounted.current) return;
    setUser(result.user);
    setError(result.error);
    setLoading(false);
  }, []);

  return (
    <SessionContext.Provider value={{ user, loading, error, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error('useSession must be used inside SessionProvider');
  }
  return context;
}

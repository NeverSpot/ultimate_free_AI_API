'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';

export interface SessionUser {
  id: string;
  username: string;
  email: string;
}

/**
 * Single source of truth for the browser session: the httpOnly cookie is the
 * only credential, so the user is whatever `GET /v1/user/me` returns. Refetching
 * on pathname changes keeps the header in sync after login/logout navigation.
 */
export function useSession() {
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // No synchronous setState here — only inside async callbacks
    // (react-hooks/set-state-in-effect).
    api
      .get<SessionUser>('/user/me')
      .then((u) => {
        if (alive) {
          setUser(u);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const status = (e as { status?: number })?.status;
        if (status === 401) {
          setUser(null);
          setError(null);
        } else {
          setError(e instanceof Error ? e.message : 'Could not reach the server');
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [pathname]);

  return { user, loading, error };
}

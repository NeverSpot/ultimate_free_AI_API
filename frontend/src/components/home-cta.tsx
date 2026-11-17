'use client';

import Link from 'next/link';
import { useSession } from '@/hooks/use-session';

/**
 * The landing CTAs depend on the session, which only the browser can see: the
 * session cookie is httpOnly and path-scoped to `/v1/user/*`, so `/` never
 * receives it. Signed-in visitors get one dashboard link instead of the two
 * account-creation links.
 */
export function HomeCta() {
  const { user, loading } = useSession();

  if (loading) {
    // Hold the layout while the session probe runs so a signed-in visitor does
    // not see "Create Account" flash before the dashboard link replaces it.
    return (
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <div className="h-12 w-56 animate-pulse rounded-xl bg-slate-800/60" />
      </div>
    );
  }

  if (user) {
    return (
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <Link
          href="/keys"
          className="inline-flex items-center gap-2 rounded-xl bg-slate-100 px-6 py-3 text-base font-semibold text-slate-950 transition hover:bg-white shadow-lg shadow-white/5"
        >
          Go to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
      <Link
        href="/login?tab=register"
        className="inline-flex items-center gap-2 rounded-xl bg-slate-100 px-6 py-3 text-base font-semibold text-slate-950 transition hover:bg-white shadow-lg shadow-white/5"
      >
        Create Account
      </Link>
      <Link
        href="/login"
        className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-6 py-3 text-base font-semibold text-slate-200 transition hover:bg-slate-800"
      >
        Sign In
      </Link>
    </div>
  );
}

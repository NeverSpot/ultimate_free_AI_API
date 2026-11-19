'use client';

import Link from 'next/link';
import { useSession } from '@/components/session-provider';

/**
 * The landing CTAs depend on the session, which only the browser can see: the
 * cookie is httpOnly, so `/` stays static and asks the shared SessionProvider
 * instead of rendering auth state on the server.
 *
 * `variant="onCopper"` flips the fills for the closing field: a copper button on
 * a copper ground would vanish, so there the primary action is the dark one.
 */
export function HomeCta({ variant = 'default' }: { variant?: 'default' | 'onCopper' }) {
  const { user, loading } = useSession();

  const row =
    variant === 'onCopper'
      ? 'mt-6 flex flex-wrap items-center gap-3'
      : 'mt-10 flex flex-wrap items-center gap-3';

  const primary =
    variant === 'onCopper'
      ? 'inline-flex items-center gap-2 rounded-lg bg-slate-950 px-6 py-3 text-base font-semibold text-slate-100 transition hover:bg-slate-900'
      : 'inline-flex items-center gap-2 rounded-lg bg-copper px-6 py-3 text-base font-semibold text-ink transition hover:bg-copper-lift';

  const secondary =
    variant === 'onCopper'
      ? 'inline-flex items-center gap-2 rounded-lg border border-ink/30 px-6 py-3 text-base font-semibold text-ink transition hover:bg-ink/10'
      : 'inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-6 py-3 text-base font-semibold text-slate-200 transition hover:bg-slate-800';

  if (loading) {
    // Hold the layout while the session probe runs so a signed-in visitor does
    // not see "Create Account" flash before the dashboard link replaces it.
    // Deliberately static: the landing page ships no self-animation.
    const skeleton = variant === 'onCopper' ? 'bg-ink/20' : 'bg-slate-800/60';
    return (
      <div className={row}>
        <div className={`h-12 w-56 rounded-lg ${skeleton}`} />
      </div>
    );
  }

  if (user) {
    return (
      <div className={row}>
        <Link href="/keys" className={primary}>
          Go to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className={row}>
      <Link href="/login?tab=register" className={primary}>
        Create Account
      </Link>
      <Link href="/login" className={secondary}>
        Sign In
      </Link>
    </div>
  );
}

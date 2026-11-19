'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '@/components/session-provider';

export function AuthNav() {
  const { user, loading, refresh } = useSession();
  const router = useRouter();

  if (loading) return <nav className="flex items-center gap-4 text-sm text-slate-300" />;

  if (!user) {
    return (
      <nav className="flex items-center gap-4 text-sm text-slate-300">
        <Link href="/login" className="transition hover:text-copper-lift">
          Login
        </Link>
      </nav>
    );
  }

  return (
    <nav className="flex items-center gap-4 text-sm text-slate-300">
      <Link href="/keys" className="transition hover:text-copper-lift">
        Keys
      </Link>
      <button
        type="button"
        onClick={async () => {
          try {
            await api.post('/auth/logout'); // must succeed before we clear/redirect
          } catch {
            return; // keep the session; the page can still show its own error
          }
          await refresh();
          router.push('/login');
        }}
        className="transition hover:text-copper-lift"
      >
        Sign out
      </button>
    </nav>
  );
}

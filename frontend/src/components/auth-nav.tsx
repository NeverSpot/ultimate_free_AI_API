'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '../hooks/use-session';

export function AuthNav() {
  const { user, loading } = useSession();
  const router = useRouter();

  if (loading) return <nav className="flex items-center gap-4 text-sm text-slate-300" />;

  if (!user) {
    return (
      <nav className="flex items-center gap-4 text-sm text-slate-300">
        <Link href="/login" className="hover:text-slate-100">
          Login
        </Link>
      </nav>
    );
  }

  return (
    <nav className="flex items-center gap-4 text-sm text-slate-300">
      <Link href="/keys" className="hover:text-slate-100">
        Keys
      </Link>
      <button
        type="button"
        onClick={async () => {
          try {
            await api.post('/auth/logout'); // must succeed before we clear/redirect
          } catch {
            return; // keep the session; surface via a toast/error if desired
          }
          try {
            localStorage.removeItem('gateway_api_key');
            localStorage.removeItem('gateway_key');
            localStorage.removeItem('gateway_key_owner');
            localStorage.removeItem('user');
          } catch {
            /* ignore */
          }
          router.push('/login');
          router.refresh();
        }}
        className="hover:text-slate-100"
      >
        Sign out
      </button>
    </nav>
  );
}

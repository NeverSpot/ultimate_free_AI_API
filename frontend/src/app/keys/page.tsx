import { Suspense } from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import KeysClient from './keys-client';

export const metadata: Metadata = {
  title: 'Keys',
};

/**
 * The session cookie is `jwt`, `Path=/`, `HttpOnly` — so the Next server can
 * read it before sending the dashboard. A signed-out visitor is redirected
 * without rendering the keys screen. Cache Components requires runtime data to
 * sit below a Suspense boundary, hence the small shell around this gate.
 */
async function KeysGate() {
  const session = (await cookies()).get('jwt');
  if (session === undefined || session.value.length === 0) {
    redirect('/login');
  }

  return <KeysClient />;
}

function KeysFallback() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10" role="status" aria-live="polite">
      <span className="sr-only">Loading keys</span>
      <div className="h-8 w-32 rounded bg-slate-800/60 motion-safe:animate-pulse" aria-hidden />
      <div
        className="mt-6 h-40 rounded-2xl border border-slate-800 bg-slate-900/40 motion-safe:animate-pulse"
        aria-hidden
      />
    </div>
  );
}

export default function KeysPage() {
  return (
    <Suspense fallback={<KeysFallback />}>
      <KeysGate />
    </Suspense>
  );
}

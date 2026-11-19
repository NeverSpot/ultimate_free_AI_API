import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Page not found',
};

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-24">
      <p className="font-mono text-sm text-slate-500">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-100">
        That page does not exist
      </h1>
      <p className="mt-4 max-w-[60ch] text-base leading-relaxed text-slate-400">
        The link may be old, or the address may have a typo. The landing page and the keys dashboard
        are both one click away.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href="/"
          className="inline-flex items-center rounded-lg bg-copper px-4 py-2 text-sm font-semibold text-ink transition hover:bg-copper-lift"
        >
          Back to the overview
        </Link>
        <Link
          href="/keys"
          className="inline-flex items-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
        >
          Go to keys
        </Link>
      </div>
    </div>
  );
}

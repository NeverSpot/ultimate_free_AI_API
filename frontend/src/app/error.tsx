'use client';

import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Route-level error boundary. It keeps the site chrome (the root layout stays
 * mounted) and offers retry, because most failures here are a gateway that is
 * restarting rather than a bug the visitor can act on.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle server logs share with the browser.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-24">
      <p className="text-sm font-medium text-copper-lift">Something went wrong</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-100">
        This page could not load
      </h1>
      <p className="mt-4 max-w-[60ch] text-base leading-relaxed text-slate-400">
        The gateway may be restarting or the request took too long. Try again; if it keeps failing,
        check the API status before changing anything on your side.
      </p>

      <button
        type="button"
        onClick={reset}
        className="mt-8 inline-flex items-center gap-2 rounded-lg bg-copper px-4 py-2 text-sm font-semibold text-ink transition hover:bg-copper-lift"
      >
        <RefreshCw size={15} />
        Try again
      </button>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * The landing page's only client island: a copy button. The snippet arrives as
 * a plain string prop, so the page around it stays a server component.
 */
export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked on an insecure origin — leave the label as it is */
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 text-left">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <span className="font-mono text-xs text-slate-400">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-slate-300 transition hover:text-copper-lift"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-4 text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-200 sm:whitespace-pre sm:text-sm">
        <code>{code}</code>
      </pre>
    </div>
  );
}

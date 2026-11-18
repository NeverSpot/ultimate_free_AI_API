import type { ReactNode } from 'react';

/**
 * The site's only page-level spacing wrapper. Two widths, one vertical
 * rhythm — sections cannot drift into their own padding.
 */
export function Section({
  children,
  width = 'text',
  divided = true,
  className = '',
}: {
  children: ReactNode;
  width?: 'text' | 'wide';
  divided?: boolean;
  className?: string;
}) {
  const max = width === 'wide' ? 'max-w-5xl' : 'max-w-3xl';
  const edge = divided ? 'border-t border-slate-800/60' : '';
  return (
    <section className={`${edge} ${className}`}>
      <div className={`mx-auto w-full ${max} px-4 py-16 sm:py-24`}>{children}</div>
    </section>
  );
}

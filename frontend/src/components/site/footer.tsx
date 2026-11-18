import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t border-slate-800">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-8 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
        <p>Ultimate Free AI Endpoint — self-hosted, OpenAI-compatible.</p>
        <nav className="flex items-center gap-4">
          <Link href="/login" className="transition hover:text-copper-lift">
            Sign in
          </Link>
          <Link href="/login?tab=register" className="transition hover:text-copper-lift">
            Create account
          </Link>
          <Link href="/keys" className="transition hover:text-copper-lift">
            Keys
          </Link>
        </nav>
      </div>
    </footer>
  );
}

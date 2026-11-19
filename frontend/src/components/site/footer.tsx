const REPO_URL = 'https://github.com/NeverSpot/ultimate_free_AI_API';

const LINKS = [
  { label: 'GitHub', href: REPO_URL },
  { label: 'Docs', href: `${REPO_URL}/blob/master/README.md` },
  { label: 'Provider notes', href: `${REPO_URL}/blob/master/docs/providers.md` },
];

/**
 * Static by design: the header's AuthNav already answers "signed in?", and a
 * second session probe in the footer would only duplicate that request.
 */
export function Footer() {
  return (
    <footer className="border-t border-slate-800/60">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
        <p>Ultimate Free AI Endpoint — self-hosted, OpenAI-compatible.</p>
        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="transition hover:text-copper-lift"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}

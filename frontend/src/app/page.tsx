import { HomeCta } from '@/components/home-cta';
import { CodeBlock } from '@/components/site/code-block';
import { Section } from '@/components/site/section';

/**
 * The snippet has to show an absolute URL a Python client can actually reach.
 * NEXT_PUBLIC_API_URL carries it when set to a full origin (Vercel: the project
 * domain plus `/v1`); otherwise the page falls back to a labelled placeholder
 * instead of advertising a localhost address that no reader can call.
 */
const CONFIGURED_API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const API_URL_IS_PLACEHOLDER = !CONFIGURED_API_URL.startsWith('http');
const DOCS_API_URL = API_URL_IS_PLACEHOLDER
  ? 'https://your-gateway.example.com/v1'
  : CONFIGURED_API_URL.replace(/\/+$/, '');

const REPO_URL = 'https://github.com/NeverSpot/ultimate_free_AI_API';

const QUICKSTART = `from openai import OpenAI

client = OpenAI(
    base_url="${DOCS_API_URL}",
    api_key="gk_your_gateway_key",
)

reply = client.chat.completions.create(
    model="free",
    messages=[{"role": "user", "content": "hello"}],
)`;

const FACTS = ['12 free-tier providers', '7 credit-backed, opt-in', 'OpenAI SDK compatible'];

const STEPS = [
  {
    title: 'Add a key',
    body: 'One row per provider key, encrypted with AES-256-GCM. It never leaves the gateway.',
  },
  {
    title: 'Reserve headroom',
    body: 'Per-minute, per-day and per-token limits are checked and counted in one Redis round-trip.',
  },
  {
    title: 'Fail over early',
    body: 'A 429 or an open breaker moves to the next provider. After the first token it stops instead of retrying.',
  },
];

/**
 * An illustration, not a captured request: the rows are one request's route
 * through two providers, and the 12s retry is an example value.
 */
const TRANSCRIPT = [
  { provider: 'openrouter', status: '429 · rate-limited, retry after 12s' },
  { provider: 'groq', status: '200 · streaming' },
];

export default function Home() {
  return (
    <>
      {/* Hero — the argument on the left, the API and one failover on the right. */}
      <Section divided={false} width="wide">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-16">
          <div>
            <h1 className="text-5xl leading-[1.05] font-semibold tracking-tight text-slate-100 sm:text-6xl lg:text-7xl">
              Your free keys, pooled into <span className="text-copper">one endpoint</span>.
            </h1>

            <p className="mt-6 max-w-[60ch] text-base leading-relaxed text-slate-400">
              Point any OpenAI SDK at one endpoint. The gateway reserves rate-limit headroom before
              dispatch, then fails over to the next provider if one refuses.
            </p>

            <HomeCta />

            <ul className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-400">
              {FACTS.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>

          <div>
            <CodeBlock
              code={QUICKSTART}
              label={
                API_URL_IS_PLACEHOLDER ? 'python · replace the base URL' : 'python · openai sdk'
              }
            />

            <figure className="mt-6 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <figcaption className="text-sm font-medium text-slate-300">
                One request, two providers
              </figcaption>
              <p className="mt-2 font-mono text-xs text-slate-500">POST /v1/chat/completions</p>
              <ol className="mt-2 space-y-2 font-mono text-[13px] leading-relaxed">
                {TRANSCRIPT.map((row) => (
                  <li key={row.provider} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <span className="text-slate-200">{row.provider}</span>
                    <span className="text-slate-400">{row.status}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-sm leading-relaxed text-slate-500">
                The gateway skips the wait and fails over to the next provider.
              </p>
            </figure>

            <p className="mt-6 text-sm leading-relaxed text-slate-400">
              4.7 ms p50 gateway overhead · 0.0% client 429s in the{' '}
              <a
                href={`${REPO_URL}/blob/master/load/report.md`}
                className="text-slate-200 underline decoration-slate-700 underline-offset-4 transition hover:text-copper-lift"
                target="_blank"
                rel="noreferrer"
              >
                208-request load run
              </a>
              .
            </p>
          </div>
        </div>
      </Section>

      {/* How a request moves — three moves, no numbering, no cards. */}
      <Section width="wide" divided={false}>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-16">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-slate-100 sm:text-4xl">
              How a request moves
            </h2>
            <p className="mt-4 max-w-[34ch] text-base leading-relaxed text-slate-400">
              One OpenAI-shaped call. Everything else is the gateway&apos;s problem.
            </p>
          </div>

          <ol className="space-y-8">
            {STEPS.map((step) => (
              <li key={step.title}>
                <h3 className="text-base font-semibold text-slate-100">{step.title}</h3>
                <p className="mt-2 max-w-[60ch] text-base leading-relaxed text-slate-400">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      {/* Closing — one decisive copper field, dark buttons for contrast. */}
      <Section divided={false} width="wide" className="bg-copper">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="max-w-[22ch] text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              Bring a key. Get an endpoint.
            </h2>
            <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-ink">
              No client rewrite: point your SDK at the gateway and ask for the model free.
            </p>
          </div>
          <HomeCta variant="onCopper" />
        </div>
      </Section>
    </>
  );
}

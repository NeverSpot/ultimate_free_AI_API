import { HomeCta } from '@/components/home-cta';
import { CodeBlock } from '@/components/site/code-block';
import { Section } from '@/components/site/section';

/**
 * The snippet has to show an absolute URL a Python client can actually reach.
 * NEXT_PUBLIC_API_URL carries it when set to a full origin (Vercel: the project
 * domain plus `/v1`); otherwise the page falls back to a placeholder instead of
 * advertising a localhost address that no reader can call.
 */
const CONFIGURED_API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const DOCS_API_URL = CONFIGURED_API_URL.startsWith('http')
  ? CONFIGURED_API_URL.replace(/\/+$/, '')
  : 'https://your-gateway.example.com/v1';

const QUICKSTART = `from openai import OpenAI

client = OpenAI(
    base_url="${DOCS_API_URL}",
    api_key="gk_your_gateway_key",
)

reply = client.chat.completions.create(
    model="free",
    messages=[{"role": "user", "content": "hello"}],
)`;

const FACTS = [
  '12 free-tier providers',
  '7 credit-backed, opt-in',
  'OpenAI SDK compatible',
] as const;

const STEPS = [
  {
    title: 'Add a key',
    body: 'One row per provider key, encrypted at rest. Nothing leaves the gateway.',
  },
  {
    title: 'Reserve headroom',
    body: 'It checks your per-minute, per-day and per-token limits and counts the request in the same step, so two requests can never claim the same capacity.',
  },
  {
    title: 'Fail over early',
    body: 'A rate limit or a provider that keeps failing hands the request to the next one. After the first streamed token it stops instead of retrying.',
  },
] as const;

export default function Home() {
  return (
    <>
      {/* 1. Hero — headline, one sentence, actions, the API as the product shot. */}
      <Section divided={false}>
        <div className="text-center">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-copper">
            OpenAI-compatible · self-hosted
          </p>

          <h1 className="mt-6 text-4xl font-semibold tracking-tight text-slate-100 sm:text-5xl">
            Many free models. <span className="text-copper">One API key.</span>
          </h1>

          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-slate-400">
            Free-tier keys are capped per provider. This gateway pools twelve providers&apos; free
            models — OpenRouter, Groq, Cerebras, Gemini and more — behind a single OpenAI-compatible
            endpoint, so a request that hits a rate limit on one provider is routed to another that
            still has capacity.
          </p>

          <HomeCta />

          <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-xs text-slate-400">
            {FACTS.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>

          <div className="mx-auto mt-10 max-w-xl">
            <CodeBlock code={QUICKSTART} label="python · openai sdk" />
          </div>
        </div>
      </Section>

      {/* 2. How a request moves — numbered narrative, no cards. */}
      <Section width="wide">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-16">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
              How a request moves
            </h2>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-slate-400">
              Three steps, all inside one OpenAI-shaped call.
            </p>
          </div>

          <ol className="divide-y divide-slate-800 border-t border-slate-800">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-5 py-6">
                <span className="font-mono text-xs text-copper-lift">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3 className="text-base font-semibold text-slate-100">{step.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      {/* 3. Closing CTA — the last chance to act. */}
      <Section divided={false} className="bg-slate-900/40">
        <div className="text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
            Bring a key. Get an endpoint.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-400">
            No client rewrite — point your SDK at the gateway and ask for the model{' '}
            <code className="rounded bg-slate-950 px-1.5 py-0.5 font-mono text-xs text-slate-200">
              free
            </code>
            .
          </p>
          <HomeCta />
        </div>
      </Section>
    </>
  );
}

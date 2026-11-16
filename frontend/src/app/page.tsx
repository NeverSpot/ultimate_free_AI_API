import Link from 'next/link';
import { KeyRound, ShieldCheck, Zap } from 'lucide-react';

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/80 px-4 py-1.5 text-xs font-medium text-slate-300">
        <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
        OpenAI-Compatible Free-Tier Gateway
      </div>

      <h1 className="mt-8 max-w-3xl text-5xl font-bold tracking-tight text-slate-100 sm:text-6xl">
        Many free models.
        <br />
        <span className="text-slate-400">One API key.</span>
      </h1>

      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-400">
        Free-tier keys are capped per provider. This gateway pools the free models from OpenRouter,
        NVIDIA NIM, TokenHarbor and more behind a single OpenAI-compatible endpoint — so a request
        that would 429 on one provider is routed to another that still has capacity.
      </p>

      {/* Landing CTAs */}
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <Link
          href="/login?tab=register"
          className="inline-flex items-center gap-2 rounded-xl bg-slate-100 px-6 py-3 text-base font-semibold text-slate-950 transition hover:bg-white shadow-lg shadow-white/5"
        >
          Create Account
        </Link>
        <Link
          href="/login"
          className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-6 py-3 text-base font-semibold text-slate-200 transition hover:bg-slate-800"
        >
          Sign In
        </Link>
      </div>

      {/* Value Prop Highlights */}
      <div className="mt-20 grid max-w-4xl grid-cols-1 gap-6 sm:grid-cols-3 text-left">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur">
          <div className="mb-4 inline-flex rounded-lg border border-slate-800 bg-slate-950 p-3 text-slate-200">
            <KeyRound size={20} />
          </div>
          <h3 className="text-base font-semibold text-slate-100">Bring Your Own Keys</h3>
          <p className="mt-2 text-sm text-slate-400">
            Plug in your free provider keys. Keys are encrypted at rest with AES-256-GCM.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur">
          <div className="mb-4 inline-flex rounded-lg border border-slate-800 bg-slate-950 p-3 text-slate-200">
            <Zap size={20} />
          </div>
          <h3 className="text-base font-semibold text-slate-100">Capacity-First Routing</h3>
          <p className="mt-2 text-sm text-slate-400">
            Dynamic ledger tracks RPM/TPM across providers and routes to the model with head-room.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur">
          <div className="mb-4 inline-flex rounded-lg border border-slate-800 bg-slate-950 p-3 text-slate-200">
            <ShieldCheck size={20} />
          </div>
          <h3 className="text-base font-semibold text-slate-100">Automatic Failover</h3>
          <p className="mt-2 text-sm text-slate-400">
            Pre-token streaming failover and circuit breakers ensure zero 429 downtime for your
            apps.
          </p>
        </div>
      </div>
    </div>
  );
}

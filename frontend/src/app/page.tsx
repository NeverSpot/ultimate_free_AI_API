import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-slate-100 sm:text-6xl">
        One API endpoint.
        <br />
        Free-tier LLM access.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-slate-400">
        Bring your own provider keys. The gateway routes your requests across OpenRouter,
        NVIDIA NIM and TokenHarbor with capacity-first routing and automatic failover.
      </p>
      <Link
        href="/login"
        className="mt-10 inline-flex items-center rounded-xl border border-slate-700 bg-slate-800 px-6 py-3 text-base font-medium text-slate-100 transition hover:bg-slate-700"
      >
        Get your API key
      </Link>
    </div>
  );
}

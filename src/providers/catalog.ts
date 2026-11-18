/**
 * The provider catalog: one row per upstream the gateway can talk to.
 *
 * This file is data, not wiring. `providers/defaults.ts` turns each row into an
 * adapter, `credentials/pool.ts` turns its `keyEnvVar` into a pool entry, and the
 * `/v1/providers` route serves the same rows to the keys screen — so a provider is
 * added in exactly one place and every surface follows.
 *
 * Two rules that are easy to get wrong:
 *
 * 1. `tier: 'credit'` providers are opt-in (`ENABLE_CREDIT_PROVIDERS=1`). Their
 *    "free" is a finite signup balance, not a recurring allowance, and a gateway
 *    that silently spends someone's $5 is worse than one that returns 429.
 * 2. `freeRule` describes how to read *evidence* from the provider's own model
 *    catalog. `unknown` means the provider publishes no free signal at all: those
 *    models report `is_free: null` and are never chosen for a "free" request.
 */

export type ProviderTier = 'free' | 'credit';

/** How a provider's `/models` answer is turned into `is_free`. */
export type FreeModelRule =
  | { kind: 'all' }
  | { kind: 'suffix'; suffix: string }
  | { kind: 'id-includes'; value: string }
  | { kind: 'id-prefix'; prefixes: readonly string[] }
  | { kind: 'pricing-zero' }
  | { kind: 'unknown' };

/** `legacy` rows keep their hand-written adapter; the rest are built from the catalog. */
export type ProviderWire = 'openai' | 'replicate' | 'legacy';

export interface ProviderSpec {
  id: string;
  name: string;
  tier: ProviderTier;
  wire: ProviderWire;
  /** `{ACCOUNT_ID}`-style placeholders are resolved from the environment. */
  baseUrl: string;
  keyEnvVar: string;
  freeRule: FreeModelRule;
  /** One sentence for the keys screen: what "free" means for this provider. */
  freeNote: string;
  signupUrl: string;
  docsUrl: string;
  /** Extra spellings already used by clients or the database. */
  aliases?: readonly string[];
  /** Configuration that must exist besides the key before the adapter can answer. */
  requiresEnv?: string;
}

export const PROVIDER_SPECS: readonly ProviderSpec[] = [
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    tier: 'free',
    wire: 'legacy',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyEnvVar: 'NVIDIA_NIM_KEYS',
    freeRule: { kind: 'unknown' },
    freeNote: 'Credit-based developer access; the model list carries no free flag.',
    signupUrl: 'https://build.nvidia.com',
    docsUrl: 'https://docs.api.nvidia.com',
    aliases: ['nvidia-nim'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    tier: 'free',
    wire: 'legacy',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnvVar: 'OPENROUTER_KEYS',
    freeRule: { kind: 'pricing-zero' },
    freeNote: ':free models — 50 requests/day, 1,000 with $10 of credit.',
    signupUrl: 'https://openrouter.ai',
    docsUrl: 'https://openrouter.ai/docs',
  },
  {
    id: 'tokenharbor',
    name: 'Token Harbor',
    tier: 'free',
    wire: 'legacy',
    baseUrl: 'https://tokenharbor.ai/v1',
    keyEnvVar: 'TOKENHARBOR_KEYS',
    freeRule: { kind: 'suffix', suffix: ':free' },
    freeNote: 'Four :free models on a weekly rolling allowance; never billed.',
    signupUrl: 'https://tokenharbor.ai',
    docsUrl: 'https://tokenharbor.ai/docs',
  },
  {
    id: 'groq',
    name: 'Groq',
    tier: 'free',
    wire: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnvVar: 'GROQ_KEYS',
    freeRule: { kind: 'all' },
    freeNote: 'Free plan: requests per minute and per day, no card required.',
    signupUrl: 'https://console.groq.com',
    docsUrl: 'https://console.groq.com/docs',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    tier: 'free',
    wire: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnvVar: 'CEREBRAS_KEYS',
    freeRule: { kind: 'all' },
    freeNote: 'Free tier: about 1M tokens/day per model, 5 requests/minute.',
    signupUrl: 'https://cloud.cerebras.ai',
    docsUrl: 'https://inference-docs.cerebras.ai',
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    tier: 'free',
    wire: 'openai',
    baseUrl: 'https://api.sambanova.ai/v1',
    keyEnvVar: 'SAMBANOVA_KEYS',
    freeRule: { kind: 'all' },
    freeNote: 'Free tier with rate limits; no card required.',
    signupUrl: 'https://cloud.sambanova.ai',
    docsUrl: 'https://docs.sambanova.ai',
  },
  {
    id: 'zai',
    name: 'Z.ai (Zhipu)',
    tier: 'free',
    wire: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    keyEnvVar: 'ZAI_KEYS',
    freeRule: { kind: 'id-includes', value: 'flash' },
    freeNote: 'GLM Flash models are free; every other GLM model is billed.',
    signupUrl: 'https://z.ai',
    docsUrl: 'https://docs.z.ai',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    tier: 'free',
    wire: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnvVar: 'MISTRAL_KEYS',
    freeRule: { kind: 'all' },
    freeNote: 'Free experiment plan: a daily token quota at low rate limits.',
    signupUrl: 'https://console.mistral.ai',
    docsUrl: 'https://docs.mistral.ai',
  },
  {
    id: 'google',
    name: 'Google AI Studio',
    tier: 'free',
    wire: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnvVar: 'GOOGLE_AI_KEYS',
    freeRule: {
      kind: 'id-prefix',
      prefixes: [
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemma-',
      ],
    },
    freeNote: 'Gemini Flash and Gemma models have a free tier; Pro models are billed.',
    signupUrl: 'https://aistudio.google.com',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    tier: 'free',
    wire: 'openai',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    keyEnvVar: 'CLOUDFLARE_AI_KEYS',
    freeRule: { kind: 'all' },
    freeNote: '10,000 Neurons per day, resetting daily.',
    signupUrl: 'https://dash.cloudflare.com',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/',
    requiresEnv: 'CLOUDFLARE_ACCOUNT_ID',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    tier: 'free',
    wire: 'openai',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    keyEnvVar: 'COHERE_KEYS',
    freeRule: { kind: 'all' },
    freeNote: 'Trial key: 1,000 calls/month at 20 requests/minute.',
    signupUrl: 'https://dashboard.cohere.com',
    docsUrl: 'https://docs.cohere.com/docs/compatibility-api',
  },
  {
    id: 'aimlapi',
    name: 'AIML API',
    tier: 'free',
    wire: 'openai',
    baseUrl: 'https://api.aimlapi.com/v1',
    keyEnvVar: 'AIMLAPI_KEYS',
    freeRule: { kind: 'unknown' },
    freeNote: 'Advertises a free tier but flags no free models, so nothing routes to it.',
    signupUrl: 'https://aimlapi.com',
    docsUrl: 'https://docs.aimlapi.com',
  },
  {
    id: 'together',
    name: 'Together AI',
    tier: 'credit',
    wire: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    keyEnvVar: 'TOGETHER_KEYS',
    freeRule: { kind: 'all' },
    freeNote: '$5 of signup credit. Finite: requests fail once it is spent.',
    signupUrl: 'https://api.together.ai',
    docsUrl: 'https://docs.together.ai',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    tier: 'credit',
    wire: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyEnvVar: 'FIREWORKS_KEYS',
    freeRule: { kind: 'all' },
    freeNote: '$1 of signup credit. Finite.',
    signupUrl: 'https://fireworks.ai',
    docsUrl: 'https://docs.fireworks.ai',
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    tier: 'credit',
    wire: 'openai',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    keyEnvVar: 'DEEPINFRA_KEYS',
    freeRule: { kind: 'all' },
    freeNote: 'Signup credits; the amount is not published. Finite.',
    signupUrl: 'https://deepinfra.com',
    docsUrl: 'https://deepinfra.com/docs/openai_api',
  },
  {
    id: 'novita',
    name: 'Novita AI',
    tier: 'credit',
    wire: 'openai',
    baseUrl: 'https://api.novita.ai/openai',
    keyEnvVar: 'NOVITA_KEYS',
    freeRule: { kind: 'all' },
    freeNote: 'About $0.50 of signup credit. Finite.',
    signupUrl: 'https://novita.ai',
    docsUrl: 'https://novita.ai/docs/guides/introduction',
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic',
    tier: 'credit',
    wire: 'openai',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    keyEnvVar: 'HYPERBOLIC_KEYS',
    freeRule: { kind: 'all' },
    freeNote: 'A small standing credit. Finite.',
    signupUrl: 'https://app.hyperbolic.xyz',
    docsUrl: 'https://docs.hyperbolic.xyz',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    tier: 'credit',
    wire: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    keyEnvVar: 'HUGGINGFACE_KEYS',
    freeRule: { kind: 'all' },
    freeNote: 'Included monthly credits; PRO adds $2. Finite each month.',
    signupUrl: 'https://huggingface.co/settings/tokens',
    docsUrl: 'https://huggingface.co/docs/inference-providers',
  },
  {
    id: 'replicate',
    name: 'Replicate',
    tier: 'credit',
    wire: 'replicate',
    baseUrl: 'https://api.replicate.com/v1',
    keyEnvVar: 'REPLICATE_KEYS',
    freeRule: { kind: 'all' },
    freeNote: '$5 of signup credit. Finite, and billed per second of compute.',
    signupUrl: 'https://replicate.com',
    docsUrl: 'https://replicate.com/docs',
  },
];

/** Enable credit-backed providers. Off unless explicitly set to `1`. */
export const CREDIT_PROVIDERS_ENV = 'ENABLE_CREDIT_PROVIDERS';

export function findProviderSpec(id: string): ProviderSpec | undefined {
  return PROVIDER_SPECS.find((spec) => spec.id === id || (spec.aliases?.includes(id) ?? false));
}

/** Credit providers are registered only when the operator opted in. */
export function isProviderEnabled(spec: ProviderSpec, env: NodeJS.ProcessEnv): boolean {
  return spec.tier === 'free' || env[CREDIT_PROVIDERS_ENV] === '1';
}

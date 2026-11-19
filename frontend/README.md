# Frontend

The Next.js app for **Ultimate Free AI Endpoint**: the landing page, sign-in and
registration, and the keys dashboard. It talks to the gateway through the same
`/v1` surface an OpenAI client uses.

## Requirements

- Node.js 24 (see the repo-root `.nvmrc`)
- The gateway running separately, normally on `http://localhost:8080`

## Local development

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The app proxies `/v1/*` to the gateway during
`next dev`, so the browser and the API share an origin and the session cookie
stays first-party — exactly as it does in production.

The proxy target defaults to `http://localhost:8080`. Point it somewhere else
with `API_PROXY_TARGET` when the gateway is on another port:

```bash
API_PROXY_TARGET=http://localhost:8081 npm run dev
```

Copy `.env.example` to `.env.local` only if you need to override the defaults.
`NEXT_PUBLIC_API_URL` is usually unnecessary in development: setting it makes the
browser call that origin directly and bypass the proxy.

## API origin and the session cookie

The default API base is same-origin `/v1`.

- **Development:** `next.config.ts` rewrites `/v1/:path*` to
  `${API_PROXY_TARGET}/v1/:path*` (only while `NODE_ENV === 'development'`).
- **Production:** the root `vercel.json` routes `/v1/*` to the gateway service.
  Nothing needs to be configured when both services share a domain.
- **Different origin:** set `NEXT_PUBLIC_API_URL` to the full origin including
  `/v1` (for example `https://api.example.com/v1`) before `npm run build`. Next
  inlines `NEXT_PUBLIC_*` at build time, so changing it later needs a rebuild.

The gateway sets the session as the `jwt` cookie with `Path=/`, `HttpOnly` and
`SameSite=Strict`. Because the cookie is first-party and path-wide:

- the Next server can read it, so `/keys` redirects a signed-out visitor before
  the dashboard renders;
- one root `SessionProvider` probes `/user/me` once per page load, and
  `AuthNav`, the landing CTAs, `/login` and `/keys` all consume that one result;
- the gateway key is **never persisted**. `/keys` fetches it from
  `/user/gateway-key` only when the user reveals or copies it, and keeps it in
  memory.

## Scripts

| Command                | What it does                                                                 |
| ---------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`          | Start Next.js with the `/v1` dev proxy.                                      |
| `npm run build`        | Production build. Required before `check:landing`.                           |
| `npm run start`        | Serve the production build.                                                  |
| `npm run typecheck`    | `tsc --noEmit`.                                                              |
| `npm run lint`         | ESLint (Next core-web-vitals + TypeScript).                                  |
| `npm run check:tokens` | Token contrast guard for the slate/copper palette.                           |
| `npm run check:landing`| Landing contract: one `h1`, no `animate-*`, quickstart present, 90–230 words. |
| `npm run test`         | Vitest unit tests for the API layer.                                         |
| `npm run test:watch`   | Vitest in watch mode.                                                        |
| `npm run test:e2e`     | Playwright flows. Builds and starts its own server on port 3100.             |
| `npm run verify`       | The full gate: typecheck, lint, tokens, build, landing, unit, and E2E.       |
| `npm run verify:fast`  | Everything in `verify` except Playwright.                                    |

### Tests

Vitest covers `src/lib/api.ts`: 401 handling, timeouts, error-envelope parsing,
and key-list normalization.

Playwright covers three flows:

- landing smoke: one `h1`, the failover transcript, and the quickstart snippet;
- one `/user/me` probe per page load, including across client navigation;
- register → add a provider key → test it → delete it, with `/v1` mocked so no
  gateway or database is required.

Install the browser once before the first E2E run:

```bash
npx playwright install chromium
```

The E2E build forces `NEXT_PUBLIC_API_URL=/v1`, so a local `.env.local` pointing
at another origin cannot leak into the tests. Set `PLAYWRIGHT_BASE_URL` to test
an already-running deployment instead of starting a local server.

## Structure

```
src/app/            routes: /, /login, /keys (server guard + client dashboard),
                    error.tsx, not-found.tsx
src/components/     session provider, auth nav, landing CTAs, site primitives
src/lib/api.ts      the one fetch wrapper: timeout, ApiError, JSON handling
unit/               Vitest unit tests
e2e/                Playwright flows
scripts/            check-tokens.mjs and check-landing.mjs gates
```

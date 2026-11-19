import type { NextConfig } from 'next';

/**
 * In development the app and the gateway run on different ports. The rewrite
 * makes `/v1/*` same-origin there too, so the session cookie behaves exactly as
 * it does behind `vercel.json` in production and `.env.example` stays optional.
 * Set API_PROXY_TARGET if the gateway is not on localhost:8080.
 */
const DEV_GATEWAY = (process.env.API_PROXY_TARGET || 'http://localhost:8080').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  // Pin the workspace root: the repo has a lockfile at its root as well, and
  // Turbopack would otherwise infer the parent directory and warn on every run.
  turbopack: {
    root: __dirname,
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
  cacheComponents: true,
  // Produces .next/standalone for the runtime image; without it the container
  // needs the full node_modules tree and the image triples in size.
  output: 'standalone',
  partialPrefetching: true,
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    return [
      {
        source: '/v1/:path*',
        destination: `${DEV_GATEWAY}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;

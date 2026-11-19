import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * E2E builds and starts its own production server. The build deliberately
 * overrides NEXT_PUBLIC_API_URL with the same-origin `/v1`, so a developer's
 * `.env.local` pointing at another port cannot leak into these tests.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `npm run build && npm run start -- --port ${PORT}`,
        url: baseURL,
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        env: {
          NEXT_PUBLIC_API_URL: '/v1',
        },
      },
});

import { expect, test, type Route } from '@playwright/test';

interface MockKey {
  id: string;
  provider: string;
  label: string;
  fingerprint: string;
  created_at: string;
  updated_at: string;
  parked: boolean;
  retry_after_ms: number;
}

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test('register, add a provider key, test it, then delete it', async ({ page }) => {
  let signedIn = false;
  let keys: MockKey[] = [];
  let gatewayKeyFetches = 0;
  const now = '2026-11-19T00:00:00.000Z';

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === '/v1/user/me') {
      if (!signedIn) {
        return fulfillJson(
          route,
          { error: { message: 'Unauthorized', code: 'unauthorized' } },
          401,
        );
      }
      return fulfillJson(route, {
        id: 'user-1',
        username: 'e2e-user',
        email: 'e2e@example.com',
      });
    }

    if (path === '/v1/auth/providers') return fulfillJson(route, { providers: [] });

    if (path === '/v1/auth/register' && method === 'POST') {
      return fulfillJson(route, {
        otp_required: true,
        email: 'e2e@example.com',
        expires_in_seconds: 600,
        dev_code: '123456',
      });
    }

    if (path === '/v1/auth/register/verify' && method === 'POST') {
      signedIn = true;
      const { hostname } = new URL(request.url());
      await page
        .context()
        .addCookies([{ name: 'jwt', value: 'e2e-session', domain: hostname, path: '/' }]);
      return fulfillJson(route, {
        user: { id: 'user-1', username: 'e2e-user', email: 'e2e@example.com' },
        gateway_api_key: 'gk_e2e_secret',
      });
    }

    if (path === '/v1/user/keys' && method === 'GET') {
      return fulfillJson(route, { keys });
    }

    if (path === '/v1/user/keys' && method === 'POST') {
      const body = request.postDataJSON() as { provider: string; providerKey: string };
      const key: MockKey = {
        id: 'key-1',
        provider: body.provider,
        label: `${body.provider} key`,
        fingerprint: 'gk_e2e_…cdef',
        created_at: now,
        updated_at: now,
        parked: false,
        retry_after_ms: 0,
      };
      keys = [key];
      return fulfillJson(route, key, 201);
    }

    const testMatch = path.match(/^\/v1\/user\/keys\/([^/]+)\/([^/]+)\/test$/);
    if (testMatch && method === 'POST') {
      return fulfillJson(route, {
        ok: true,
        provider: testMatch[1],
        model: 'llama-3.1-8b-free',
        latency_ms: 42,
        prompt_tokens: 3,
        completion_tokens: 5,
        reply: 'hi',
        error: null,
        error_kind: null,
        http_status: 200,
      });
    }

    const deleteMatch = path.match(/^\/v1\/user\/keys\/([^/]+)\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      keys = keys.filter((key) => key.id !== deleteMatch[2]);
      return fulfillJson(route, {});
    }

    if (path === '/v1/user/usage') {
      return fulfillJson(route, {
        usage: {
          window_days: 30,
          requests: 1,
          prompt_tokens: 3,
          completion_tokens: 5,
          total_tokens: 8,
          cost_usd: 0,
          failovers: 1,
          last_request_at: now,
        },
      });
    }

    if (path === '/v1/providers') {
      return fulfillJson(route, {
        providers: [
          {
            id: 'groq',
            name: 'Groq',
            tier: 'free',
            key_env_var: 'GROQ_KEYS',
            free_note: 'Free tier, one key is plenty.',
            signup_url: 'https://console.groq.com',
            docs_url: 'https://console.groq.com/docs',
            aliases: [],
            requires_env: null,
          },
        ],
      });
    }

    if (path === '/v1/providers/health') return fulfillJson(route, { providers: {} });

    if (path === '/v1/user/gateway-key') {
      gatewayKeyFetches += 1;
      return fulfillJson(route, { gateway_api_key: 'gk_e2e_secret' });
    }

    return fulfillJson(route, { error: { message: `Unhandled ${method} ${path}` } }, 500);
  });

  await page.goto('/login?tab=register');

  await page.getByLabel('Username').fill('e2e-user');
  await page.getByLabel('Email').fill('e2e@example.com');
  await page.getByLabel('Password (min. 8 characters)').fill('correct-horse-battery');
  await page.locator('form button[type="submit"]').click();

  await page.getByLabel('Verification code').fill('123456');
  await page.locator('form button[type="submit"]').click();

  await page.waitForURL('**/keys');
  await expect(page.getByRole('heading', { level: 1, name: 'Keys' })).toBeVisible();

  // The gateway key is only fetched when asked for, never on page load.
  expect(gatewayKeyFetches).toBe(0);
  await expect(page.getByText('gk_e2e_secret')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reveal' }).click();
  await expect(page.getByText('gk_e2e_secret')).toBeVisible();
  expect(gatewayKeyFetches).toBe(1);

  await page.getByLabel('Paste a Groq key').fill('gsk_test_provider_key');
  await page.getByRole('button', { name: 'Add key' }).click();
  await expect(page.getByText('groq key')).toBeVisible();

  await page.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByText(/Works — llama-3\.1-8b-free · 42 ms/)).toBeVisible();

  await page.getByRole('button', { name: 'Remove groq key' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByText('Nothing to route with yet')).toBeVisible();

  // The gateway key never touches persistent storage.
  const stored = await page.evaluate(() =>
    ['gateway_api_key', 'gateway_key', 'user'].filter((key) => localStorage.getItem(key) !== null),
  );
  expect(stored).toEqual([]);
});

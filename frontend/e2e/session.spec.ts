import { expect, test } from '@playwright/test';

test('signed-out /keys redirects to /login before rendering the dashboard', async ({ page }) => {
  await page.route('**/v1/user/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Unauthorized', code: 'unauthorized' } }),
    }),
  );
  await page.route('**/v1/auth/providers', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: [] }),
    }),
  );

  await page.goto('/keys');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Keys' })).toHaveCount(0);
});

test('a page load probes /user/me once, even across client navigation', async ({ page }) => {
  let probes = 0;

  await page.route('**/v1/user/me', (route) => {
    probes += 1;
    return route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Unauthorized', code: 'unauthorized' } }),
    });
  });

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Login' })).toBeVisible();
  expect(probes).toBe(1);

  // A client navigation keeps the root SessionProvider mounted, so the login
  // page must not fire a second probe of its own.
  await page.getByRole('link', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(probes).toBe(1);
});

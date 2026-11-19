import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // The landing page is static; stub the session probe so the header is stable.
  await page.route('**/v1/user/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Unauthorized', code: 'unauthorized' } }),
    }),
  );
});

test('landing keeps its contract', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('one endpoint');
  await expect(page.getByRole('heading', { name: 'How a request moves' })).toBeVisible();

  // The failover story renders as server HTML: request, both attempts, decision.
  await expect(page.getByText('One request, two providers')).toBeVisible();
  await expect(page.getByText('POST /v1/chat/completions')).toBeVisible();
  await expect(page.getByText('openrouter')).toBeVisible();
  await expect(page.getByText('groq')).toBeVisible();
  await expect(page.getByText(/skips the wait and fails over/)).toBeVisible();

  // The quickstart is real, copyable prose rather than an image.
  await expect(page.locator('pre code')).toContainText('client = OpenAI(');
  await expect(page.locator('pre code')).toContainText('model="free"');
});

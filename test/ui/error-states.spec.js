const { test, expect } = require('@playwright/test');
const {
  ADMIN_URL,
  navigateToAdmin,
  requireServer,
  isOllamaAvailable,
  hasAdminKey,
} = require('../fixtures/test-helpers');

async function snap(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

test.describe('UI Error States and Edge Cases', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('dashboard handles stats API failure without blank-screen crash', async ({ page }) => {
    await page.route('**/admin/api/stats**', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"forced"}' });
    });
    await navigateToAdmin(page, 'dashboard');
    await page.waitForTimeout(800);
    await snap(page, 'errors-dashboard-stats-500');
    await expect(page.locator('#tab-content .stat-card, #tab-content .stats-grid').first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('body')).not.toContainText(/stack|exception|traceback/i);
  });

  test('models page remains navigable when Ollama is unavailable', async ({ page }) => {
    test.skip(await isOllamaAvailable(), 'Ollama available; skipping unavailable-state test');
    await navigateToAdmin(page, 'models');
    await page.waitForTimeout(800);
    await snap(page, 'errors-models-ollama-unavailable');
    await expect(page.locator('#tab-content').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tab-bar [data-tab="dashboard"]').first()).toBeVisible();
  });

  test('playground shows failure feedback when inference endpoint errors', async ({ page }) => {
    test.setTimeout(60000);
    await page.route('**/api/chat', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"forced chat failure"}' });
    });
    await page.route('**/v1/chat/completions', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"forced v1 failure"}' });
    });

    await navigateToAdmin(page, 'playground');
    await page.locator('[data-pg="chat"]').first().click();
    const chatInput = page.locator('#chat-input').first();
    await expect(chatInput).toBeVisible({ timeout: 10000 });
    const isDisabled = await chatInput.isDisabled();
    test.skip(isDisabled, 'Chat input disabled in current environment (likely no chat model loaded)');
    await chatInput.fill('trigger error');
    await page.locator('#chat-send').first().click();

    await expect(page.locator('#chat-messages .chat-message.assistant').last()).toBeVisible({ timeout: 15000 });
    const chatText = ((await page.locator('#chat-messages').textContent()) || '').toLowerCase();
    await snap(page, 'errors-playground-chat-500');
    expect(chatText.includes('error') || chatText.includes('failed')).toBeTruthy();
    await expect(page.locator('#chat-input').first()).toBeEnabled({ timeout: 10000 });
  });

  test('unknown admin route returns not found and dashboard remains reachable', async ({ page }) => {
    const res = await page.goto(`${ADMIN_URL}/nonexistent-page`);
    await snap(page, 'errors-admin-404');
    expect(res && res.status()).toBe(404);
    await expect(page.locator('body')).toContainText(/not found/i);

    await navigateToAdmin(page, 'dashboard');
    await expect(page.locator('#tab-content .stats-grid').first()).toBeVisible({ timeout: 10000 });
  });

  test('very long chat input does not break layout or controls', async ({ page }) => {
    await navigateToAdmin(page, 'playground');
    await page.locator('[data-pg="chat"]').first().click();
    const longText = 'x'.repeat(10000);
    const chatInput = page.locator('#chat-input').first();
    await expect(chatInput).toBeVisible({ timeout: 10000 });
    const isDisabled = await chatInput.isDisabled();
    test.skip(isDisabled, 'Chat input disabled in current environment (likely no chat model loaded)');
    await chatInput.fill(longText);

    const size = await page
      .locator('#chat-input')
      .first()
      .evaluate((el) => ({
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
      }));
    await snap(page, 'errors-long-chat-input');
    expect(size.clientWidth).toBeGreaterThan(0);
    await expect(page.locator('#chat-send').first()).toBeVisible({ timeout: 10000 });
  });
});

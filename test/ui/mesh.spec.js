const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

test.describe('Mesh Connection', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('mesh status indicator is visible', async ({ page }) => {
    await navigateToAdmin(page, 'mesh');
    await expect(page.locator('#mesh-connection-card .mesh-state-dot')).toBeVisible({ timeout: 15000 });
  });

  test('mesh card renders actions or configuration controls', async ({ page }) => {
    await navigateToAdmin(page, 'mesh');
    const card = page.locator('#mesh-connection-card');
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.locator('h3')).toBeVisible();
    await expect(card).toContainText(/mesh|connected|disconnected|reconnecting/i);
  });

  test('mesh tab shows hero banner', async ({ page }) => {
    await navigateToAdmin(page, 'mesh');
    await expect(page.locator('.mesh-hero')).toBeVisible({ timeout: 15000 });
  });

  test('mesh tab shows benefits when disconnected', async ({ page }) => {
    await navigateToAdmin(page, 'mesh');
    await expect(page.locator('#mesh-connection-card')).toBeVisible({ timeout: 15000 });

    const stateText = ((await page.locator('#mesh-connection-card').textContent()) || '').toLowerCase();
    if (stateText.includes('disconnected')) {
      await expect(page.locator('.mesh-benefits')).toBeVisible({ timeout: 15000 });
    }
  });

  test('mesh tab shows create account CTA when disconnected', async ({ page }) => {
    await navigateToAdmin(page, 'mesh');
    const card = page.locator('#mesh-connection-card');
    await expect(card).toBeVisible({ timeout: 15000 });

    const stateText = ((await card.textContent()) || '').toLowerCase();
    if (stateText.includes('disconnected')) {
      await expect(page.locator('.mesh-cta a[href="https://app.jimbomesh.ai"]')).toBeVisible({ timeout: 15000 });
    }
  });
});

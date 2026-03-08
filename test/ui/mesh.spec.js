const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

test.describe('Mesh Connection', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('mesh status indicator is visible', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    await expect(page.locator('#mesh-connection-card .mesh-state-dot')).toBeVisible({ timeout: 15000 });
  });

  test('mesh card renders actions or configuration controls', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    const card = page.locator('#mesh-connection-card');
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.locator('h3')).toBeVisible();
    await expect(card).toContainText(/mesh|connected|disconnected|reconnecting/i);
  });
});

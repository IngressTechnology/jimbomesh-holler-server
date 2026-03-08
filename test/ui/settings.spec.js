const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

test.describe('Settings / Configuration', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('loads current configuration', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    await expect(page.locator('.config-grid').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.config-sections').first()).toBeVisible({ timeout: 10000 });
  });

  test('security section is visible', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    await expect(page.locator('#apikey-masked')).toBeVisible({ timeout: 10000 });
  });

  test('save button is present and disabled by default', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    const saveButton = page.locator('#header-save-btn');
    await expect(saveButton).toBeVisible();
    await expect(saveButton).toBeDisabled();
  });
});

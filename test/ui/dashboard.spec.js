const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

test.describe('Admin Dashboard', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('loads without runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await navigateToAdmin(page, 'dashboard');
    await page.waitForLoadState('networkidle');

    expect(errors).toHaveLength(0);
  });

  test('renders system stats cards', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const dashboard = page.locator('#tab-content').first();
    await expect(dashboard.locator('.stats-grid .stat-card').first()).toBeVisible({ timeout: 10000 });
  });

  test('shows health indicator', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const dashboard = page.locator('#tab-content').first();
    await expect(dashboard.locator('#d-health .status-dot').first()).toBeVisible({ timeout: 10000 });
  });

  test('does not render dashboard error banner by default', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const dashboard = page.locator('#tab-content').first();
    await expect(dashboard.locator('#d-error .login-error')).toHaveCount(0);
  });
});

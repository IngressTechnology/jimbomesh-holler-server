const { test, expect } = require('@playwright/test');
const { ADMIN_URL, BASE_URL, navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

async function snap(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

test.describe('Admin Navigation Interactions', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('sidebar/tab links navigate to expected sections with active state', async ({ page }) => {
    const tabs = ['dashboard', 'mesh', 'models', 'playground', 'statistics', 'config', 'system', 'activity', 'documents', 'feedback'];
    await navigateToAdmin(page, 'dashboard');

    for (const tab of tabs) {
      await page.locator(`#tab-bar [data-tab="${tab}"]`).first().click();
      await page.waitForTimeout(200);
      await snap(page, `nav-${tab}`);
      const firstContent = page.locator('#tab-content .card, #tab-content .stats-grid, #tab-content .empty-state').first();
      if ((await firstContent.count()) > 0) {
        await expect.soft(firstContent).toBeVisible({ timeout: 10000 });
      } else {
        await expect.soft(page.locator('#tab-content').first()).toBeVisible({ timeout: 10000 });
      }
      await expect(page.locator(`#tab-bar [data-tab="${tab}"].active`).first()).toBeVisible({ timeout: 10000 });
    }

    await page.goto(`${BASE_URL}/docs`);
    await page.waitForLoadState('domcontentloaded');
    await snap(page, 'nav-api-docs');
    await expect(page.locator('#swagger-ui, .swagger-ui').first()).toBeVisible({ timeout: 10000 });
  });

  test('tab highlights current section on direct hash navigation', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    await page.goto(`${ADMIN_URL}#models`);
    await expect(page.locator('#tab-bar')).toBeVisible({ timeout: 10000 });
    await snap(page, 'nav-direct-models');
    await expect(page.locator('#tab-bar [data-tab="models"].active').first()).toBeVisible({ timeout: 10000 });
  });

  test('browser back and forward navigation works between sections', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    await page.locator('#tab-bar [data-tab="models"]').first().click();
    await page.locator('#tab-bar [data-tab="playground"]').first().click();

    await page.goBack();
    await snap(page, 'nav-back-models');
    await expect(page.locator('#tab-bar [data-tab="models"].active').first()).toBeVisible({ timeout: 10000 });

    await page.goBack();
    await expect(page.locator('#tab-bar').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tab-bar .tab-btn.active').first()).toBeVisible({ timeout: 10000 });

    await page.goForward();
    await snap(page, 'nav-forward-models');
    await expect(page.locator('#tab-bar').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tab-bar .tab-btn.active').first()).toBeVisible({ timeout: 10000 });
  });

  test('mobile navigation menu/tabs remain usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await navigateToAdmin(page, 'dashboard');

    const tabBar = page.locator('#tab-bar');
    await expect(tabBar).toBeVisible({ timeout: 10000 });

    const menuToggle = page.locator(
      '[data-testid*="menu"], [aria-label*="menu" i], .menu-toggle, .hamburger, #menu-toggle'
    );
    if ((await menuToggle.count()) > 0) {
      await menuToggle.first().click();
      await expect(tabBar).toBeVisible({ timeout: 10000 });
    }

    await page.locator('#tab-bar [data-tab="models"]').first().click();
    await snap(page, 'nav-mobile-models');
    await expect(page.locator('#tab-bar [data-tab="models"].active').first()).toBeVisible({ timeout: 10000 });
  });

  test('document title remains valid and navigation context updates', async ({ page }) => {
    const tabs = ['dashboard', 'mesh', 'models', 'playground', 'statistics', 'config'];
    await navigateToAdmin(page, 'dashboard');

    for (const tab of tabs) {
      await page.locator(`#tab-bar [data-tab="${tab}"]`).first().click();
      const title = await page.title();
      await snap(page, `nav-title-${tab}`);
      expect(title.trim().length).toBeGreaterThan(0);
      await expect(page.locator(`#tab-bar [data-tab="${tab}"].active`).first()).toBeVisible({ timeout: 10000 });
    }
  });

  test('invalid admin sub-route shows not-found without crashing app', async ({ page }) => {
    const response = await page.goto(`${ADMIN_URL}/nonexistent-page`);
    await snap(page, 'nav-unknown-admin-route');
    expect(response && response.status()).toBe(404);
    await expect(page.locator('body')).toContainText(/not found/i);
  });
});

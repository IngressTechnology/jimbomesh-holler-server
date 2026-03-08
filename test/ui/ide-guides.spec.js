const { test, expect } = require('@playwright/test');
const { requireServer, BASE_URL, navigateToAdmin, hasAdminKey } = require('../fixtures/test-helpers');

const IDE_GUIDES = ['vscode', 'cursor', 'windsurf', 'jetbrains', 'neovim', 'emacs', 'zed', 'warp'];

test.describe('IDE Integration Guides', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test('IDE guide content endpoint is reachable when exposed', async ({ page }) => {
    const candidates = [
      `${BASE_URL}/docs/IDE_INTEGRATIONS.md`,
      `${BASE_URL}/IDE_INTEGRATIONS.md`,
    ];

    let loaded = false;
    for (const url of candidates) {
      const res = await page.goto(url);
      if (res && res.status() === 200) {
        loaded = true;
        break;
      }
    }

    test.skip(!loaded, 'IDE guides are not exposed over HTTP in this environment');
    const body = await page.textContent('body');
    expect(body.length).toBeGreaterThan(100);
    expect(body).toContain('1920');
    for (const ide of IDE_GUIDES) {
      expect(body.toLowerCase()).toContain(ide);
    }
  });

  test('copy-to-clipboard button exists in admin configuration', async ({ page }) => {
    test.skip(!hasAdminKey(), 'Admin API key is required for authenticated admin UI checks');
    await navigateToAdmin(page, 'config');
    await expect(page.locator('#apikey-copy')).toBeVisible({ timeout: 10000 });
  });
});

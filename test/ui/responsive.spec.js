const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

const VIEWPORTS = [
  { name: 'iphone-14-pro', width: 393, height: 852 },
  { name: 'iphone-se', width: 320, height: 700 },
  { name: 'ipad', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

test.describe('Responsive Layout', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  for (const vp of VIEWPORTS) {
    test(`renders at ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await navigateToAdmin(page, 'dashboard');
      await page.waitForLoadState('networkidle');

      const { bodyWidth, viewportWidth, overflow } = await page.evaluate(() => {
        const bw = document.body.scrollWidth;
        const vw = window.innerWidth;
        return { bodyWidth: bw, viewportWidth: vw, overflow: Math.max(0, bw - vw) };
      });
      // The admin shell has a fixed minimum width region on very small screens.
      // Keep this check as a regression guard against severe overflow.
      expect(overflow, `body=${bodyWidth}, viewport=${viewportWidth}`).toBeLessThanOrEqual(120);

      await page.screenshot({
        path: `test-results/responsive-${vp.name}.png`,
        fullPage: true,
      });
    });
  }

  test('mobile navigation remains usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await navigateToAdmin(page, 'dashboard');
    await expect(page.locator('#tab-bar')).toBeVisible();
  });
});

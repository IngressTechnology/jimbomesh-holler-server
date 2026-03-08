const { test, expect } = require('@playwright/test');
const {
  BASE_URL,
  navigateToAdmin,
  requireServer,
  hasAdminKey,
} = require('../fixtures/test-helpers');

async function snap(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

async function openIdeGuidesContent(page) {
  const candidates = [
    `${BASE_URL}/docs/IDE_INTEGRATIONS.md`,
    `${BASE_URL}/IDE_INTEGRATIONS.md`,
  ];
  for (const url of candidates) {
    const res = await page.goto(url);
    if (res && res.status() === 200) return true;
  }
  return false;
}

test.describe('Clipboard and Copy Flows', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test('IDE guide code blocks expose copy controls when rendered UI provides them', async ({ page }) => {
    const loaded = await openIdeGuidesContent(page);
    test.skip(!loaded, 'IDE guides content endpoint is not exposed');

    const codeBlocks = page.locator('pre code, pre');
    const count = await codeBlocks.count();
    test.skip(count === 0, 'No code blocks rendered in this environment');

    const copyButtons = page.locator('button:has-text("Copy"), [aria-label*="copy" i], [data-testid*="copy"]');
    test.skip((await copyButtons.count()) === 0, 'No copy controls implemented for guide code blocks in this build');

    await snap(page, 'copy-ide-guides-controls');
    expect(await copyButtons.count()).toBeGreaterThan(0);
  });

  test('clicking API key copy button changes state then reverts', async ({ page }) => {
    test.skip(!hasAdminKey(), 'Admin API key is required for config copy interaction');
    await navigateToAdmin(page, 'config');

    const copyBtn = page.locator('#apikey-copy').first();
    await expect(copyBtn).toBeVisible({ timeout: 10000 });
    const before = ((await copyBtn.textContent()) || '').trim().toLowerCase();
    await copyBtn.click();
    await expect(copyBtn).toHaveClass(/btn-success-flash/, { timeout: 5000 });
    await snap(page, 'copy-api-key-copied-state');

    await page.waitForTimeout(2300);
    await expect(copyBtn).not.toHaveClass(/btn-success-flash/);
    const reverted = ((await copyBtn.textContent()) || '').trim().toLowerCase();
    expect(reverted).toBe(before);
  });

  test('settings page copy action shows visual feedback class', async ({ page }) => {
    test.skip(!hasAdminKey(), 'Admin API key is required for settings copy interaction');
    await navigateToAdmin(page, 'config');

    const copyBtn = page.locator('#apikey-copy').first();
    await copyBtn.click();
    await snap(page, 'copy-settings-feedback-class');
    const cls = (await copyBtn.getAttribute('class')) || '';
    expect(cls.toLowerCase().includes('flash') || cls.toLowerCase().includes('success')).toBeTruthy();
  });

  test('IDE guide code snippets reference port 1920 for admin endpoint examples', async ({ page }) => {
    const loaded = await openIdeGuidesContent(page);
    test.skip(!loaded, 'IDE guides content endpoint is not exposed');

    const bodyText = ((await page.textContent('body')) || '').toLowerCase();
    await snap(page, 'copy-ide-guides-port-check');
    expect(bodyText.includes('1920')).toBeTruthy();
    expect(bodyText.includes('localhost:3000')).toBeFalsy();
  });
});

const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

async function snap(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

function hasBadValue(text) {
  return /nan|undefined|null/i.test(text || '');
}

test.describe('Dashboard Deep Interactions', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('stat cards render stable values without NaN/undefined/null', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const statIds = ['#d-health', '#d-latency', '#d-uptime', '#d-models', '#d-requests', '#d-running'];

    for (const id of statIds) {
      const el = page.locator(id).first();
      await expect(el).toBeVisible({ timeout: 10000 });
      const text = (await el.textContent()) || '';
      expect(text.trim().length).toBeGreaterThan(0);
      expect(hasBadValue(text)).toBeFalsy();
    }

    await snap(page, 'dashboard-stat-values');
  });

  test('dashboard stat DOM remains present across refresh interval', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const cards = page.locator('#tab-content .stat-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const beforeCount = await cards.count();

    await page.waitForTimeout(5000);
    await snap(page, 'dashboard-refresh-stability');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const afterCount = await cards.count();
    expect(afterCount).toBeGreaterThan(0);
    expect(afterCount).toBe(beforeCount);
  });

  test('health indicator shows valid semantic state', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const health = page.locator('#d-health').first();
    await expect(health).toBeVisible({ timeout: 10000 });

    const cls = (await health.locator('.status-dot').first().getAttribute('class')) || '';
    const text = ((await health.textContent()) || '').toLowerCase();
    await snap(page, 'dashboard-health-state');
    expect(/green|yellow|red/.test(cls) || /healthy|unhealthy|degraded|error/.test(text)).toBeTruthy();
  });

  test('GPU info section displays valid content when present', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const gpuLike = page.locator('#tab-content').locator(':text-matches("gpu|vram|metal|nvidia", "i")');
    const count = await gpuLike.count();
    test.skip(count === 0, 'No dashboard GPU section in this deployment');

    const text = ((await gpuLike.first().textContent()) || '').toLowerCase();
    await snap(page, 'dashboard-gpu-section');
    expect(/gpu|vram|metal|nvidia|memory|mb|gb/.test(text)).toBeTruthy();
  });

  test('clicking each stat card does not destabilize dashboard', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const cards = page.locator('#tab-content .stat-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      await cards.nth(i).click({ force: true });
    }

    await snap(page, 'dashboard-click-cards');
    await expect(page.locator('#tab-content .stat-card').first()).toBeVisible({ timeout: 10000 });
    const warningText = ((await page.locator('#d-error').first().textContent()) || '').toLowerCase();
    expect(warningText.includes('exception')).toBeFalsy();
    expect(warningText.includes('traceback')).toBeFalsy();
  });

  test('dashboard shows no raw stack trace text during normal load', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    await page.waitForTimeout(800);
    const content = ((await page.locator('#tab-content').textContent()) || '').toLowerCase();
    await snap(page, 'dashboard-no-raw-errors');
    expect(content.includes('syntaxerror')).toBeFalsy();
    expect(content.includes('typeerror')).toBeFalsy();
    expect(content.includes('referenceerror')).toBeFalsy();
    expect(content.includes('exception')).toBeFalsy();
    expect(content.includes('traceback')).toBeFalsy();
  });
});

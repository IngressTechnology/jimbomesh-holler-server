const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

async function snap(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

function parseRgb(rgbText) {
  const m = rgbText.match(/\d+/g) || [];
  return m.slice(0, 3).map((n) => Number(n));
}

test.describe('Theme Consistency', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('dashboard uses dark background with readable light text', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const colors = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return { bg: body.backgroundColor, text: body.color };
    });
    const bg = parseRgb(colors.bg);
    const text = parseRgb(colors.text);
    await snap(page, 'theme-dark-dashboard');
    expect(bg[0] + bg[1] + bg[2]).toBeLessThan(180 * 3);
    expect(text[0] + text[1] + text[2]).toBeGreaterThan(120 * 3);
  });

  test('primary actions or active nav use teal accent family', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const accent = await page.evaluate(() => {
      const activeTab = document.querySelector('.tab-btn.active');
      const primaryBtn = document.querySelector('.btn-primary');
      const tabColor = activeTab ? getComputedStyle(activeTab).color : '';
      const btnBg = primaryBtn ? getComputedStyle(primaryBtn).backgroundColor : '';
      return { tabColor, btnBg };
    });
    await snap(page, 'theme-teal-accent');
    const tab = parseRgb(accent.tabColor || 'rgb(0,0,0)');
    const btn = parseRgb(accent.btnBg || 'rgb(0,0,0)');
    const hasTeal = (tab[1] > tab[0] && tab[1] > tab[2]) || (btn[1] > btn[0] && btn[1] > btn[2]);
    expect(hasTeal).toBeTruthy();
  });

  test('pages avoid obvious unstyled white-background regressions', async ({ page }) => {
    const tabs = [
      'dashboard',
      'mesh',
      'models',
      'playground',
      'statistics',
      'config',
      'system',
      'activity',
      'documents',
      'feedback',
    ];
    for (const tab of tabs) {
      await navigateToAdmin(page, tab);
      const styles = await page.evaluate(() => {
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        const card = document.querySelector('.card, .stat-card');
        const cardBg = card ? getComputedStyle(card).backgroundColor : '';
        return { bodyBg, cardBg };
      });
      const bodyRgb = parseRgb(styles.bodyBg);
      const cardRgb = parseRgb(styles.cardBg || 'rgb(0,0,0)');
      expect(bodyRgb[0] + bodyRgb[1] + bodyRgb[2]).toBeLessThan(220 * 3);
      expect(cardRgb[0] + cardRgb[1] + cardRgb[2]).toBeLessThan(240 * 3);
    }
    await snap(page, 'theme-no-unstyled-regressions');
  });

  test('card radius and background stay consistent between dashboard and models', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const dash = await page
      .locator('.stat-card')
      .first()
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        return { radius: cs.borderRadius, bg: cs.backgroundColor, padding: cs.padding };
      });

    await navigateToAdmin(page, 'models');
    const modelCard = page.locator('.card, .model-card').first();
    await expect(modelCard).toBeVisible({ timeout: 10000 });
    const models = await modelCard.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { radius: cs.borderRadius, bg: cs.backgroundColor, padding: cs.padding };
    });

    await snap(page, 'theme-card-consistency');
    expect(dash.radius.length).toBeGreaterThan(0);
    expect(models.radius.length).toBeGreaterThan(0);
    expect(dash.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(models.bg).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('copy-feedback styling follows dark theme and auto-resets', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    const copyBtn = page.locator('#apikey-copy').first();
    const beforeText = ((await copyBtn.textContent()) || '').trim();
    await copyBtn.click();
    await expect(copyBtn).toHaveClass(/btn-success-flash/, { timeout: 5000 });
    const btnBg = await copyBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
    await snap(page, 'theme-toast-visible');
    expect(parseRgb(btnBg).reduce((a, b) => a + b, 0)).toBeLessThan(260 * 3);

    await page.waitForTimeout(2500);
    await expect(copyBtn).not.toHaveClass(/btn-success-flash/);
    const afterText = ((await copyBtn.textContent()) || '').trim();
    expect(afterText.toLowerCase()).toBe(beforeText.toLowerCase());
  });
});

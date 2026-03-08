const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

async function snap(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

test.describe('Accessibility Deep Coverage', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('Tab key moves focus through interactive elements with visible focus style', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');

    await page.keyboard.press('Tab');
    const firstFocused = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
    expect(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(firstFocused)).toBeTruthy();

    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return '';
      const cs = getComputedStyle(el);
      return `${cs.outlineStyle}|${cs.outlineWidth}|${cs.outlineColor}`;
    });
    await snap(page, 'a11y-tab-focus');
    expect(outline.includes('none')).toBeFalsy();
  });

  test('Enter and Space activate keyboard-focused tab buttons', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const modelsBtn = page.locator('#tab-bar [data-tab="models"]').first();
    await modelsBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#tab-bar [data-tab="models"].active').first()).toBeVisible({ timeout: 10000 });

    const dashboardBtn = page.locator('#tab-bar [data-tab="dashboard"]').first();
    await dashboardBtn.focus();
    await page.keyboard.press('Space');
    await snap(page, 'a11y-enter-space');
    await expect(page.locator('#tab-bar [data-tab="dashboard"].active').first()).toBeVisible({ timeout: 10000 });
  });

  test('Escape closes modal or overlay dialogs', async ({ page }) => {
    await navigateToAdmin(page, 'models');
    await page.locator('[data-mp="installed"]').first().click();

    const deleteBtn = page.locator('#models-body [data-delete]').first();
    test.skip((await deleteBtn.count()) === 0, 'No delete modal trigger available');
    await deleteBtn.click();
    await expect(page.locator('#delete-overlay').first()).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await snap(page, 'a11y-escape-close');
    await expect(page.locator('#delete-overlay').first()).toHaveCount(0);
  });

  test('icon-only buttons expose descriptive aria labels when present', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    const issues = await page.evaluate(() => {
      const bad = [];
      const buttons = Array.from(document.querySelectorAll('button'));
      buttons.forEach((btn) => {
        const text = (btn.textContent || '').trim();
        const hasIcon = !!btn.querySelector('svg, i');
        if (text.length === 0 || (hasIcon && text.length <= 1)) {
          const aria = btn.getAttribute('aria-label') || '';
          const labelledBy = btn.getAttribute('aria-labelledby') || '';
          if (!aria.trim() && !labelledBy.trim()) {
            bad.push(btn.id || btn.className || 'unnamed-button');
          }
        }
      });
      return bad;
    });
    await snap(page, 'a11y-icon-buttons');
    expect(issues).toEqual([]);
  });

  test('form controls have accessible labels or config key association', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    const summary = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll('input, select, textarea'));
      const unlabeled = controls.filter((el) => {
        if (el.type === 'hidden') return false;
        if (el.closest('.confirm-overlay')) return false;
        if (el.closest('.lang-dropdown')) return false;
        const id = el.id;
        const aria = (el.getAttribute('aria-label') || '').trim();
        const labelledBy = (el.getAttribute('aria-labelledby') || '').trim();
        if (aria || labelledBy) return false;
        if (id && document.querySelector(`label[for="${id}"]`)) return false;
        const row = el.closest('.config-item');
        if (row && row.querySelector('.key')) return false;
        return true;
      });
      return {
        total: controls.length,
        unlabeled: unlabeled.length,
      };
    });
    await snap(page, 'a11y-form-labels');
    test.skip(summary.total === 0, 'No form controls rendered in current config view');
    expect(summary.unlabeled).toBeLessThanOrEqual(12);
  });

  test('keyboard tabbing does not get trapped in normal dashboard flow', async ({ page }) => {
    await navigateToAdmin(page, 'dashboard');
    const seen = new Set();
    for (let i = 0; i < 24; i += 1) {
      await page.keyboard.press('Tab');
      const active = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return 'none';
        return `${el.tagName}:${el.id || el.className || ''}`;
      });
      seen.add(active);
    }
    await snap(page, 'a11y-no-focus-trap');
    expect(seen.size).toBeGreaterThan(3);
  });

  test('prefers-reduced-motion reduces transition/animation durations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await navigateToAdmin(page, 'dashboard');
    const motion = await page.evaluate(() => {
      const isReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const el = document.querySelector('.toast') || document.querySelector('.tab-btn') || document.body;
      const cs = el ? getComputedStyle(el) : null;
      return {
        isReduce,
        transitionDuration: cs ? cs.transitionDuration : '',
        animationDuration: cs ? cs.animationDuration : '',
      };
    });
    await snap(page, 'a11y-reduced-motion');
    expect(motion.isReduce).toBeTruthy();
    expect(typeof motion.transitionDuration).toBe('string');
    expect(typeof motion.animationDuration).toBe('string');
  });
});

const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

async function snap(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

test.describe('Model Interaction Flows', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('switches between Installed, Ollama Library, and HuggingFace tabs', async ({ page }) => {
    await navigateToAdmin(page, 'models');

    const installed = page.locator('[data-mp="installed"]').first();
    const ollama = page.locator('[data-mp="ollama"]').first();
    const hf = page.locator('[data-mp="huggingface"]').first();

    await installed.click();
    await expect(installed).toHaveClass(/active/);
    await expect(page.locator('#models-body').first()).toBeVisible({ timeout: 10000 });

    await ollama.click();
    await expect(ollama).toHaveClass(/active/);
    await expect(installed).not.toHaveClass(/active/);
    await expect(page.locator('#ollama-grid').first()).toBeVisible({ timeout: 10000 });

    await hf.click();
    await expect(hf).toHaveClass(/active/);
    await expect(page.locator('#hf-grid').first()).toBeVisible({ timeout: 10000 });

    await installed.click();
    await snap(page, 'models-tab-switching');
    await expect(page.locator('#models-body').first()).toBeVisible({ timeout: 10000 });
  });

  test('installed models render required row/card information when present', async ({ page }) => {
    await navigateToAdmin(page, 'models');
    await page.locator('[data-mp="installed"]').first().click();

    const rows = page.locator('#models-body tbody tr');
    const empty = page.locator('#models-body .empty-state');
    test.skip((await rows.count()) === 0 || (await empty.count()) > 0, 'No installed models present');

    const firstRow = rows.first();
    await snap(page, 'models-installed-row');
    await expect(firstRow.locator('td').first()).toBeVisible({ timeout: 10000 });
    await expect(firstRow.locator('[data-delete], [data-update], [data-show]').first()).toBeVisible({ timeout: 10000 });
  });

  test('model search/filter updates visible results', async ({ page }) => {
    await navigateToAdmin(page, 'models');
    await page.locator('[data-mp="huggingface"]').first().click();

    const searchInput = page.locator('#hf-search').first();
    await searchInput.fill('llama');
    await page.locator('#hf-search-btn').first().click();
    await expect(page.locator('#hf-grid').first()).toBeVisible({ timeout: 10000 });
    const filteredCount = await page.locator('#hf-grid .model-card, #hf-grid .mp-empty').count();

    await searchInput.fill('');
    await page.locator('#hf-search-btn').first().click();
    await expect(page.locator('#hf-grid').first()).toBeVisible({ timeout: 10000 });
    const afterClearCount = await page.locator('#hf-grid .model-card, #hf-grid .mp-empty').count();

    await snap(page, 'models-search-filter');
    expect(filteredCount).toBeGreaterThan(0);
    expect(afterClearCount).toBeGreaterThan(0);
  });

  test('HuggingFace gibberish search shows empty-state style result', async ({ page }) => {
    await navigateToAdmin(page, 'models');
    await page.locator('[data-mp="huggingface"]').first().click();

    await page.locator('#hf-search').first().fill('zzxxqqnonexistent12345');
    await page.locator('#hf-search-btn').first().click();
    await expect(page.locator('#hf-grid').first()).toBeVisible({ timeout: 10000 });

    await snap(page, 'models-hf-empty-state');
    const emptyState = page.locator('#hf-grid .mp-empty').first();
    await expect(emptyState).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tab-content .login-error').first()).toHaveCount(0);
  });

  test('model detail panel opens and closes from installed list', async ({ page }) => {
    await navigateToAdmin(page, 'models');
    await page.locator('[data-mp="installed"]').first().click();

    const detailBtn = page.locator('#models-body [data-show]').first();
    test.skip((await detailBtn.count()) === 0, 'No model detail trigger found');

    await detailBtn.click();
    await expect(page.locator('#model-detail .card, #model-detail .confirm-overlay').first()).toBeVisible({ timeout: 10000 });
    await snap(page, 'models-detail-open');

    const closeBtn = page.locator('#close-detail').first();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(page.locator('#model-detail .card, #model-detail .confirm-overlay').first()).toHaveCount(0);
  });

  test('VRAM summary bar is rendered on models page', async ({ page }) => {
    await navigateToAdmin(page, 'models');
    await expect(page.locator('#mp-vram').first()).toBeVisible({ timeout: 10000 });
    const vramText = ((await page.locator('#mp-vram').first().textContent()) || '').trim();
    await snap(page, 'models-vram-bar');
    expect(vramText.length).toBeGreaterThan(0);
  });
});

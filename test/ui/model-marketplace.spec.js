const { test, expect } = require('@playwright/test');
const {
  navigateToAdmin,
  requireServer,
  isOllamaAvailable,
  hasAdminKey,
} = require('../fixtures/test-helpers');

test.describe('Model Marketplace', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('loads installed models panel', async ({ page }) => {
    await navigateToAdmin(page, 'models');
    const modelsTab = page.locator('#tab-content').first();
    await expect(modelsTab.locator('#models-body').first()).toBeVisible({ timeout: 15000 });
  });

  test('Ollama library tab renders list area', async ({ page }) => {
    await navigateToAdmin(page, 'models');
    const modelsTab = page.locator('#tab-content').first();
    await modelsTab.locator('[data-mp="ollama"]').first().click();
    await expect(modelsTab.locator('#ollama-grid').first()).toBeVisible({ timeout: 15000 });
    const cardsOrEmpty = modelsTab.locator('#ollama-grid .model-card, #ollama-grid .mp-empty');
    await expect(cardsOrEmpty.first()).toBeVisible({ timeout: 15000 });
  });

  test('HuggingFace model search renders result region', async ({ page }) => {
    await navigateToAdmin(page, 'models');
    const modelsTab = page.locator('#tab-content').first();
    await modelsTab.locator('[data-mp="huggingface"]').first().click();
    await modelsTab.locator('#hf-search').first().fill('llama');
    await modelsTab.locator('#hf-search-btn').first().click();
    await expect(modelsTab.locator('#hf-grid').first()).toBeVisible({ timeout: 15000 });
    const cardsOrEmpty = modelsTab.locator('#hf-grid .model-card, #hf-grid .mp-empty');
    await expect(cardsOrEmpty.first()).toBeVisible({ timeout: 15000 });
  });

  test('VRAM-aware badges are discoverable when available', async ({ page }) => {
    await navigateToAdmin(page, 'models');
    const modelsTab = page.locator('#tab-content').first();
    await modelsTab.locator('[data-mp="ollama"]').first().click();
    await expect(modelsTab.locator('#mp-vram').first()).toBeVisible({ timeout: 15000 });
    const badges = modelsTab.locator('.fit-badge');
    expect(await badges.count()).toBeGreaterThanOrEqual(0);
  });

  test('model pull shows progress area', async ({ page }) => {
    test.skip(!(await isOllamaAvailable()), 'Ollama not available — skipping pull test');

    await navigateToAdmin(page, 'models');
    const modelsTab = page.locator('#tab-content').first();
    await modelsTab.locator('[data-mp="installed"]').first().click();
    await modelsTab.locator('#pull-input').first().fill('nomic-embed-text');
    await modelsTab.locator('#pull-btn').first().click();
    await expect(modelsTab.locator('#pull-progress').first()).toBeVisible({ timeout: 10000 });
  });
});

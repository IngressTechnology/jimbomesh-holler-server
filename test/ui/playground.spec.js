const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, isOllamaAvailable, hasAdminKey } = require('../fixtures/test-helpers');

test.describe('Playground', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('chat model dropdown is visible', async ({ page }) => {
    await navigateToAdmin(page, 'playground');
    const playgroundTab = page.locator('#tab-content').first();
    await playgroundTab.locator('[data-pg="chat"]').first().click();
    await expect(playgroundTab.locator('#chat-model').first()).toBeVisible({ timeout: 10000 });
    expect(await playgroundTab.locator('#chat-model option').count()).toBeGreaterThanOrEqual(0);
  });

  test('quick prompt buttons are visible', async ({ page }) => {
    await navigateToAdmin(page, 'playground');
    const playgroundTab = page.locator('#tab-content').first();
    await playgroundTab.locator('[data-pg="chat"]').first().click();
    const quickPrompts = playgroundTab.locator('.chat-preset-btn');
    expect(await quickPrompts.count()).toBeGreaterThanOrEqual(1);
  });

  test('sending a prompt returns a response', async ({ page }) => {
    test.skip(!(await isOllamaAvailable()), 'Ollama not available — skipping inference test');
    test.setTimeout(60000);

    await navigateToAdmin(page, 'playground');
    const playgroundTab = page.locator('#tab-content').first();
    await playgroundTab.locator('[data-pg="chat"]').first().click();

    await playgroundTab.locator('#chat-input').first().fill('Say "test passed" and nothing else.');
    await playgroundTab.locator('#chat-send').first().click();

    const assistantMessage = playgroundTab.locator('.chat-message.assistant .msg-content').last();
    await expect(assistantMessage).toBeVisible({ timeout: 45000 });
    await expect(assistantMessage).not.toHaveText(/^\s*$/);
  });
});

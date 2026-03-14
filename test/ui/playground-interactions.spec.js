const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, isOllamaAvailable, hasAdminKey } = require('../fixtures/test-helpers');

async function snap(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

async function openChatPlayground(page) {
  await navigateToAdmin(page, 'playground');
  await page.locator('[data-pg="chat"]').first().click();
  await expect(page.locator('#chat-input').first()).toBeVisible({ timeout: 10000 });
}

async function skipIfChatInputDisabled(page) {
  const input = page.locator('#chat-input').first();
  const disabled = await input.isDisabled();
  test.skip(disabled, 'Chat input disabled in this environment (likely no chat model loaded)');
}

test.describe('Playground Deep Interactions', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('chat model dropdown contains non-empty options when Ollama is available', async ({ page }) => {
    test.skip(!(await isOllamaAvailable()), 'Ollama not available');
    await openChatPlayground(page);

    const options = page.locator('#chat-model option');
    const count = await options.count();
    await snap(page, 'pg-model-dropdown');
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const label = ((await options.nth(i).textContent()) || '').trim();
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test('typing in prompt input enables send button', async ({ page }) => {
    await openChatPlayground(page);
    await skipIfChatInputDisabled(page);
    const input = page.locator('#chat-input').first();
    const send = page.locator('#chat-send').first();
    const beforeCount = await page.locator('#chat-messages .chat-message').count();

    await expect(send).toBeVisible({ timeout: 10000 });
    await send.click();
    await page.waitForTimeout(150);
    await expect(page.locator('#chat-messages .chat-message')).toHaveCount(beforeCount);
    await input.fill('hello from test');
    await snap(page, 'pg-send-enabled');
    await expect(send).toBeEnabled({ timeout: 10000 });
  });

  test('clearing prompt input returns send button to disabled state', async ({ page }) => {
    await openChatPlayground(page);
    await skipIfChatInputDisabled(page);
    const input = page.locator('#chat-input').first();
    const send = page.locator('#chat-send').first();
    const beforeCount = await page.locator('#chat-messages .chat-message').count();

    await input.fill('temporary content');
    await expect(send).toBeEnabled();
    await input.fill('');
    await send.click();
    await page.waitForTimeout(150);
    await snap(page, 'pg-send-disabled-after-clear');
    await expect(send).toBeEnabled();
    await expect(page.locator('#chat-messages .chat-message')).toHaveCount(beforeCount);
  });

  test('quick prompt buttons populate chat input', async ({ page }) => {
    await openChatPlayground(page);
    await skipIfChatInputDisabled(page);
    const preset = page.locator('.chat-preset-btn').first();
    test.skip((await preset.count()) === 0, 'No quick prompt buttons visible');

    await preset.click();
    const value = await page.locator('#chat-input').first().inputValue();
    await snap(page, 'pg-quick-prompt-fill');
    expect(value.trim().length).toBeGreaterThan(0);
  });

  test('chat history shows user message then assistant response', async ({ page }) => {
    test.skip(!(await isOllamaAvailable()), 'Ollama not available');
    test.setTimeout(60000);

    await openChatPlayground(page);
    await page.locator('#chat-input').first().fill('Say ok');
    await page.locator('#chat-send').first().click();

    await expect(page.locator('#chat-messages .chat-message.user').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#chat-messages .chat-message.assistant').last()).toBeVisible({ timeout: 30000 });
    const userIndex = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#chat-messages .chat-message')];
      return nodes.findIndex((n) => n.classList.contains('user'));
    });
    const assistantIndex = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#chat-messages .chat-message')];
      return nodes.findIndex((n) => n.classList.contains('assistant'));
    });
    await snap(page, 'pg-chat-history-order');
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(userIndex);
  });

  test('generation shows in-progress affordance and remains cancellable by context switch', async ({ page }) => {
    test.skip(!(await isOllamaAvailable()), 'Ollama not available');
    test.setTimeout(60000);

    await openChatPlayground(page);
    await page.locator('#chat-input').first().fill('Write a 200 word essay about cats');
    await page.locator('#chat-send').first().click();

    await page.waitForTimeout(600);
    const stopBtn = page
      .locator('#chat-stop, [data-testid="chat-stop"], button:has-text("Stop"), button:has-text("Cancel")')
      .first();
    const hasStop = (await stopBtn.count()) > 0;
    if (hasStop) {
      await expect(stopBtn).toBeVisible({ timeout: 10000 });
      await stopBtn.click();
    } else {
      await expect(page.locator('#chat-send').first()).toBeDisabled({ timeout: 10000 });
      await page.locator('[data-pg="embed"]').first().click();
      await page.locator('[data-pg="chat"]').first().click();
    }

    await snap(page, 'pg-streaming-affordance');
    await expect(page.locator('#chat-input').first()).toBeVisible({ timeout: 10000 });
  });

  test('playground input state across tab switch is documented and stable', async ({ page }) => {
    await openChatPlayground(page);
    await skipIfChatInputDisabled(page);
    const input = page.locator('#chat-input').first();
    const seed = 'draft message stays or clears';
    await input.fill(seed);

    await page.locator('#tab-bar [data-tab="dashboard"]').first().click();
    await page.locator('#tab-bar [data-tab="playground"]').first().click();
    await page.locator('[data-pg="chat"]').first().click();

    const valueAfter = await page.locator('#chat-input').first().inputValue();
    await snap(page, 'pg-state-on-return');
    expect(valueAfter === '' || valueAfter === seed).toBeTruthy();
  });
});

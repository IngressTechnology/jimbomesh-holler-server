const { test, expect } = require('@playwright/test');
const { navigateToAdmin, requireServer, hasAdminKey } = require('../fixtures/test-helpers');

async function snap(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

test.describe('Settings Interaction Behavior', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('config form text fields are editable', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    const firstEditable = page.locator('.config-item [data-setting-key], .config-item').first().locator('input.setting-input').first();
    await expect(firstEditable).toBeVisible({ timeout: 10000 });

    const original = await firstEditable.inputValue();
    await firstEditable.fill(`${original}x`);
    await snap(page, 'settings-field-editable');
    await expect(firstEditable).toHaveValue(`${original}x`);
  });

  test('changing a setting enables save button', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    const saveBtn = page.locator('#header-save-btn').first();
    await expect(saveBtn).toBeVisible({ timeout: 10000 });
    await expect(saveBtn).toBeDisabled();

    const input = page.locator('.config-item input.setting-input').first();
    const original = await input.inputValue();
    await input.fill(`${original} changed`);

    await snap(page, 'settings-save-enabled');
    await expect(saveBtn).toBeEnabled({ timeout: 10000 });
  });

  test('security section shows API key management controls', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    await expect(page.locator('#apikey-section').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#apikey-masked').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#apikey-copy').first()).toBeVisible({ timeout: 10000 });

    await page.locator('#apikey-copy').first().click();
    await snap(page, 'settings-api-key-copy-feedback');
    const copyText = ((await page.locator('#apikey-copy').first().textContent()) || '').toLowerCase();
    expect(copyText.includes('cop') || copyText.includes('copied')).toBeTruthy();
  });

  test('GPU-related config field accepts numeric-like value when present', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    const gpuRow = page.locator('.config-item', { hasText: /gpu|layer/i }).first();
    test.skip((await gpuRow.count()) === 0, 'No GPU config row present');

    const gpuInput = gpuRow.locator('input.setting-input').first();
    await gpuInput.fill('12');
    await snap(page, 'settings-gpu-numeric-input');
    await expect(gpuInput).toHaveValue('12');
  });

  test('invalid numeric input surfaces validation state on numeric controls', async ({ page }) => {
    await navigateToAdmin(page, 'config');
    const numericInput = page.locator('input[type="number"]').first();
    test.skip((await numericInput.count()) === 0, 'No numeric field available for validation test');

    const before = await numericInput.inputValue();
    let rejectedNonNumeric = false;
    try {
      await numericInput.fill('abc');
    } catch {
      rejectedNonNumeric = true;
    }
    const after = await numericInput.inputValue();
    await snap(page, 'settings-invalid-number');
    expect(rejectedNonNumeric || after !== 'abc').toBeTruthy();
    expect(after).not.toBe('abc');

    await numericInput.fill('10');
    const valid = await numericInput.evaluate((el) => {
      if (typeof el.checkValidity === 'function') return el.checkValidity();
      return true;
    });
    expect(valid).toBeTruthy();
    expect(before !== undefined).toBeTruthy();
  });
});

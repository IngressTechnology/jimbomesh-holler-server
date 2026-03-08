const { test, expect } = require('@playwright/test');
const { requireServer, BASE_URL } = require('../fixtures/test-helpers');

async function openSwagger(page) {
  const swaggerPaths = ['/docs', '/api-docs', '/swagger'];
  for (const path of swaggerPaths) {
    const response = await page.goto(`${BASE_URL}${path}`);
    if (response && response.status() === 200) return path;
  }
  return null;
}

test.describe('API Documentation (Swagger)', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test('Swagger UI loads', async ({ page }) => {
    const path = await openSwagger(page);
    expect(path).toBeTruthy();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#swagger-ui')).toBeVisible({ timeout: 15000 });
  });

  test('lists endpoints with methods', async ({ page }) => {
    const path = await openSwagger(page);
    expect(path).toBeTruthy();
    await page.waitForLoadState('networkidle');
    const methods = page.locator('.opblock-get, .opblock-post, [data-method="get"], [data-method="post"]');
    expect(await methods.count()).toBeGreaterThan(0);
  });
});

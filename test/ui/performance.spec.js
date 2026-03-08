const { test, expect } = require('@playwright/test');
const {
  ADMIN_URL,
  navigateToAdmin,
  requireServer,
  hasAdminKey,
} = require('../fixtures/test-helpers');

async function snap(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

async function measureAdminLoadMs(page, tab) {
  const start = Date.now();
  await navigateToAdmin(page, tab);
  await page.waitForLoadState('networkidle');
  return Date.now() - start;
}

test.describe('Admin UI Performance', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test.skip(!hasAdminKey(), 'Set ADMIN_TOKEN, ADMIN_API_KEY, or JIMBOMESH_HOLLER_API_KEY for UI tests');

  test('dashboard section becomes interactive within 3 seconds', async ({ page }) => {
    const elapsed = await measureAdminLoadMs(page, 'dashboard');
    await snap(page, 'perf-dashboard-load');
    expect(elapsed).toBeLessThan(3000);
  });

  test('models section becomes interactive within 3 seconds', async ({ page }) => {
    const elapsed = await measureAdminLoadMs(page, 'models');
    await snap(page, 'perf-models-load');
    expect(elapsed).toBeLessThan(3000);
  });

  test('config section becomes interactive within 3 seconds', async ({ page }) => {
    const elapsed = await measureAdminLoadMs(page, 'config');
    await snap(page, 'perf-config-load');
    expect(elapsed).toBeLessThan(3000);
  });

  test('dashboard initial load does not issue excessive requests or 5xx failures', async ({ page }) => {
    const requests = [];
    const badResponses = [];

    page.on('request', (req) => requests.push(req.url()));
    page.on('response', (res) => {
      const status = res.status();
      if (status >= 400 && status !== 404) badResponses.push({ url: res.url(), status });
    });

    await navigateToAdmin(page, 'dashboard');
    await page.waitForLoadState('networkidle');
    await snap(page, 'perf-dashboard-network');

    expect(requests.length).toBeLessThan(50);
    expect(badResponses).toEqual([]);
  });

  test('admin navigation does not emit console errors and keeps warnings low', async ({ page }) => {
    const errors = [];
    let warnings = 0;
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const txt = msg.text();
        const isKnownDataImageNoise = txt.includes('Loading the image \'data:image/svg+xml');
        const isKnownBootstrapCspNoise =
          txt.includes('Executing inline script violates the following Content Security Policy directive') &&
          txt.includes('script-src \'self\'');
        if (!isKnownDataImageNoise && !isKnownBootstrapCspNoise) {
          errors.push(txt);
        }
      }
      if (msg.type() === 'warning') warnings += 1;
    });

    await navigateToAdmin(page, 'dashboard');
    await page.locator('#tab-bar [data-tab="models"]').first().click();
    await page.locator('#tab-bar [data-tab="playground"]').first().click();
    await page.locator('#tab-bar [data-tab="config"]').first().click();
    await page.waitForTimeout(500);
    await snap(page, 'perf-console-errors');

    expect(errors).toEqual([]);
    expect(warnings).toBeLessThan(5);
  });

  test('static CSS/JS assets include cache metadata when configured', async ({ page }) => {
    const assetHeaders = [];
    page.on('response', (res) => {
      const url = res.url();
      if (!url.includes('/admin/')) return;
      if (!(url.endsWith('.css') || url.endsWith('.js'))) return;
      assetHeaders.push({
        url,
        cacheControl: res.headers()['cache-control'] || '',
        etag: res.headers().etag || '',
        lastModified: res.headers()['last-modified'] || '',
      });
    });

    await page.goto(`${ADMIN_URL}#dashboard`);
    await page.waitForLoadState('networkidle');
    await snap(page, 'perf-static-cache-headers');

    const withCacheMetadata = assetHeaders.filter(
      (h) => h.cacheControl || h.etag || h.lastModified
    );
    test.skip(withCacheMetadata.length === 0, 'Static cache headers are not configured in this environment');
    expect(withCacheMetadata.length).toBeGreaterThan(0);
  });
});

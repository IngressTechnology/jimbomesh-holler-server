const { test, expect } = require('@playwright/test');
const { requireServer, BASE_URL, ADMIN_KEY, buildAuthHeaders } = require('../fixtures/test-helpers');

test.describe('Admin Endpoints Auth', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test('admin endpoints reject unauthenticated requests', async ({ request }) => {
    const adminPaths = ['/admin/api/settings', '/admin/api/stats', '/admin/api/status'];

    for (const path of adminPaths) {
      const res = await request.get(`${BASE_URL}${path}`);
      expect([401, 403, 404]).toContain(res.status());
    }
  });

  test('admin endpoints accept valid API key', async ({ request }) => {
    test.skip(!ADMIN_KEY, 'Missing admin key in environment');

    const res = await request.get(`${BASE_URL}/admin/api/settings`, {
      headers: buildAuthHeaders(),
    });
    expect([200, 404]).toContain(res.status());
  });
});

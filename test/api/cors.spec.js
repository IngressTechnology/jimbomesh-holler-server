const { test, expect } = require('@playwright/test');
const { requireServer, BASE_URL, ADMIN_KEY, buildAuthHeaders } = require('../fixtures/test-helpers');

test.describe('CORS / Preflight Behavior', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test('health endpoint responds to cross-origin style request', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/health`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
  });

  test('OPTIONS preflight does not 5xx', async ({ request }) => {
    const res = await request.fetch(`${BASE_URL}/v1/models`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
        ...(ADMIN_KEY ? buildAuthHeaders() : {}),
      },
    });
    expect([200, 204, 401, 403, 404]).toContain(res.status());
  });
});

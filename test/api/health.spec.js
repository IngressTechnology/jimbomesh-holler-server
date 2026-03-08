const { test, expect } = require('@playwright/test');
const { requireServer, BASE_URL } = require('../fixtures/test-helpers');

test.describe('GET /health', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test('returns 200 with valid JSON', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        status: expect.any(String),
        timestamp: expect.any(String),
      })
    );
  });

  test('includes required health fields', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/health`);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('timestamp');
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
  });
});

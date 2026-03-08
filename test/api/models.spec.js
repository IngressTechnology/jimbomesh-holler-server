const { test, expect } = require('@playwright/test');
const { requireServer, BASE_URL, isOllamaAvailable, ADMIN_KEY, buildAuthHeaders } = require('../fixtures/test-helpers');

test.describe('GET /v1/models', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test('returns OpenAI-compatible format', async ({ request }) => {
    test.skip(!ADMIN_KEY, 'Missing auth key for /v1 endpoints');
    test.skip(!(await isOllamaAvailable()), 'Ollama not available');

    const res = await request.get(`${BASE_URL}/v1/models`, {
      headers: buildAuthHeaders(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('object', 'list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.every((m) => typeof m === 'object' && m !== null)).toBe(true);
  });

  test('model entries include required fields', async ({ request }) => {
    test.skip(!ADMIN_KEY, 'Missing auth key for /v1 endpoints');
    test.skip(!(await isOllamaAvailable()), 'Ollama not available');

    const res = await request.get(`${BASE_URL}/v1/models`, {
      headers: buildAuthHeaders(),
    });
    const body = await res.json();
    test.skip(body.data.length === 0, 'No models loaded');
    const model = body.data[0];
    expect(model).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        object: 'model',
      })
    );
  });
});

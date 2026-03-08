const { test, expect } = require('@playwright/test');
const { requireServer, BASE_URL, isOllamaAvailable, ADMIN_KEY, buildAuthHeaders } = require('../fixtures/test-helpers');

test.describe('POST /v1/chat/completions', () => {
  test.beforeAll(async () => {
    await requireServer();
  });

  test('returns response payload for valid request', async ({ request }) => {
    test.skip(!ADMIN_KEY, 'Missing auth key for /v1 endpoints');
    test.skip(!(await isOllamaAvailable()), 'Ollama not available');
    test.setTimeout(60000);

    const modelsRes = await request.get(`${BASE_URL}/v1/models`, {
      headers: buildAuthHeaders(),
    });
    const models = await modelsRes.json();
    test.skip(!models.data || models.data.length === 0, 'No models loaded');

    const modelId = models.data[0].id;
    const res = await request.post(`${BASE_URL}/v1/chat/completions`, {
      headers: buildAuthHeaders(),
      data: {
        model: modelId,
        messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
        stream: false,
        max_tokens: 10,
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices.length).toBeGreaterThan(0);
    expect(body.choices[0]).toHaveProperty('message');
    expect(body.choices[0].message).toHaveProperty('content');
  });

  test('rejects missing model field', async ({ request }) => {
    test.skip(!ADMIN_KEY, 'Missing auth key for /v1 endpoints');
    test.skip(!(await isOllamaAvailable()), 'Ollama not available');
    const res = await request.post(`${BASE_URL}/v1/chat/completions`, {
      timeout: 12000,
      headers: buildAuthHeaders(),
      data: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    expect([400, 401, 403, 422, 504]).toContain(res.status());
    const body = await res.json().catch(() => ({}));
    if (![401, 403, 504].includes(res.status())) {
      expect(body).toHaveProperty('error');
    }
  });

  test('rejects empty messages array', async ({ request }) => {
    test.skip(!ADMIN_KEY, 'Missing auth key for /v1 endpoints');
    const res = await request.post(`${BASE_URL}/v1/chat/completions`, {
      headers: buildAuthHeaders(),
      data: {
        model: 'llama3.2:1b',
        messages: [],
      },
    });
    expect([400, 401, 403, 422]).toContain(res.status());
    const body = await res.json().catch(() => ({}));
    if (res.status() !== 401 && res.status() !== 403) {
      expect(body).toHaveProperty('error');
    }
  });
});

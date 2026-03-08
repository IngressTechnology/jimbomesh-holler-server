/**
 * Common test helpers for Playwright E2E tests.
 * Reads config from .env and environment variables.
 */

const path = require('node:path');
const { expect } = require('@playwright/test');
const { config } = require('dotenv');

config({ path: path.resolve(process.cwd(), '.env') });

const BASE_URL = `http://localhost:${process.env.PORT || 1920}`;
const ADMIN_URL = `${BASE_URL}/admin`;
const ADMIN_KEY =
  process.env.ADMIN_TOKEN ||
  process.env.ADMIN_API_KEY ||
  process.env.JIMBOMESH_HOLLER_API_KEY ||
  '';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

async function isOllamaAvailable() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

async function requireServer() {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error(`Health check returned ${res.status}`);
  } catch (err) {
    throw new Error(
      `Holler server not running at ${BASE_URL}. Start it with "npm start" before running E2E tests.\n${err.message}`
    );
  }
}

function buildAuthHeaders(extra = {}) {
  return {
    ...(ADMIN_KEY && { 'X-API-Key': ADMIN_KEY }),
    ...extra,
  };
}

async function navigateToAdmin(page, tab = '') {
  const url = ADMIN_KEY ? `${ADMIN_URL}#key=${encodeURIComponent(ADMIN_KEY)}` : ADMIN_URL;
  await page.goto(url);
  await expect(page.locator('body')).not.toBeEmpty();

  // If auth key is available, ensure app shell is loaded.
  if (ADMIN_KEY) {
    await expect(page.locator('#tab-bar')).toBeVisible({ timeout: 15000 });
  }

  if (tab) {
    const tabBtn = page.locator(`[data-tab="${tab}"]`);
    if ((await tabBtn.count()) > 0) {
      await tabBtn.first().click();
      await expect(page.locator('#tab-content')).toBeVisible();
    }
  }
}

function hasAdminKey() {
  return Boolean(ADMIN_KEY);
}

module.exports = {
  BASE_URL,
  ADMIN_URL,
  ADMIN_KEY,
  OLLAMA_HOST,
  isOllamaAvailable,
  requireServer,
  buildAuthHeaders,
  navigateToAdmin,
  hasAdminKey,
};

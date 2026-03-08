/**
 * Bearer Token Manager — Tier 2 Authentication
 * Manages named bearer tokens with SHA-256 hashing, scoped permissions,
 * per-token rate limits, expiry, and usage tracking.
 *
 * Tokens are stored as SHA-256 hashes in /data/keys.json (never raw).
 * Token format: jmh_ + 36 hex chars = 40 chars total.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const SAVE_INTERVAL_MS = 30000; // Write-coalesce: save at most once per 30s
const RATE_WINDOW_MS = 60000;   // 1-minute window for RPM
const HOUR_MS = 3600000;        // 1-hour window for RPH

// ── State ──────────────────────────────────────────────────────

let tokens = [];            // Array of token objects (without raw key)
const hashMap = new Map();    // Map<sha256-hash, token> for O(1) lookup
let dirty = false;          // Needs save
let saveTimer = null;       // Background save interval

// Per-token rate limiting: Map<tokenId, { rpm: { windowStart, count }, rph: { windowStart, count } }>
const rateLimits = new Map();

// Reference to db module (set via init)
let db = null;

// ── Helpers ────────────────────────────────────────────────────

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateRawToken() {
  return 'jmh_' + crypto.randomBytes(18).toString('hex');
}

function prefixFromRaw(raw) {
  return raw.slice(0, 8); // "jmh_" + first 4 hex chars
}

function rebuildHashMap() {
  hashMap.clear();
  for (let i = 0; i < tokens.length; i++) {
    hashMap.set(tokens[i].hash, tokens[i]);
  }
}

function now() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

// ── File Persistence ───────────────────────────────────────────

function loadTokens() {
  if (!fs.existsSync(KEYS_FILE)) {
    tokens = [];
    rebuildHashMap();
    return;
  }
  try {
    const raw = fs.readFileSync(KEYS_FILE, 'utf8');
    const data = JSON.parse(raw);
    tokens = data.tokens || [];
    rebuildHashMap();
    console.log('[token-manager] Loaded ' + tokens.length + ' bearer token(s) from keys.json');
  } catch (err) {
    console.error('[token-manager] Failed to load keys.json:', err.message);
    tokens = [];
    rebuildHashMap();
  }
}

function saveTokens() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const data = JSON.stringify({ version: 1, tokens: tokens }, null, 2);
  const tmpPath = KEYS_FILE + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, KEYS_FILE);
    dirty = false;
  } catch (err) {
    console.error('[token-manager] Failed to save keys.json:', err.message);
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
  }
}

function markDirty() {
  dirty = true;
}

function saveIfDirty() {
  if (dirty) saveTokens();
}

// ── Enabled Check ──────────────────────────────────────────────

function isEnabled() {
  if (!db) return false;
  try {
    const val = db.getSetting('enhanced_security_enabled');
    return val === 'true';
  } catch (_) {
    return false;
  }
}

// ── CRUD Operations ────────────────────────────────────────────

function createToken(opts) {
  const raw = generateRawToken();
  const hash = hashToken(raw);
  const token = {
    id: crypto.randomUUID(),
    name: opts.name || 'Unnamed Token',
    hash: hash,
    prefix: prefixFromRaw(raw),
    permissions: opts.permissions || ['full'],
    rpm: opts.rpm || 60,
    rph: opts.rph || 1000,
    expires_at: opts.expires_at || null,
    created_at: isoNow(),
    request_count: 0,
    last_used: null,
    hourly_usage: {},
  };
  tokens.push(token);
  hashMap.set(hash, token);
  markDirty();
  saveTokens(); // Immediate save on create (important)
  return { token: token, raw: raw };
}

function validateToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const hash = hashToken(raw);
  const token = hashMap.get(hash);
  if (!token) return null;

  // Check expiry
  if (token.expires_at) {
    const expiryMs = new Date(token.expires_at).getTime();
    if (now() > expiryMs) return null;
  }

  return token;
}

function revokeToken(id) {
  const idx = tokens.findIndex(function (t) { return t.id === id; });
  if (idx === -1) return false;
  const token = tokens[idx];
  hashMap.delete(token.hash);
  rateLimits.delete(id);
  tokens.splice(idx, 1);
  markDirty();
  saveTokens(); // Immediate save on revoke
  return true;
}

function listTokens() {
  return tokens.map(function (t) {
    return {
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      permissions: t.permissions,
      rpm: t.rpm,
      rph: t.rph,
      expires_at: t.expires_at,
      created_at: t.created_at,
      request_count: t.request_count,
      last_used: t.last_used,
      hourly_usage: t.hourly_usage,
    };
  });
}

function getToken(id) {
  const token = tokens.find(function (t) { return t.id === id; });
  if (!token) return null;
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    permissions: token.permissions,
    rpm: token.rpm,
    rph: token.rph,
    expires_at: token.expires_at,
    created_at: token.created_at,
    request_count: token.request_count,
    last_used: token.last_used,
    hourly_usage: token.hourly_usage,
  };
}

function updateToken(id, changes) {
  const token = tokens.find(function (t) { return t.id === id; });
  if (!token) return null;
  if (changes.name !== undefined) token.name = changes.name;
  if (changes.permissions !== undefined) token.permissions = changes.permissions;
  if (changes.rpm !== undefined) token.rpm = changes.rpm;
  if (changes.rph !== undefined) token.rph = changes.rph;
  if (changes.expires_at !== undefined) token.expires_at = changes.expires_at;
  markDirty();
  saveTokens(); // Immediate save on update
  return getToken(id);
}

// ── Per-Token Rate Limiting ────────────────────────────────────

function checkTokenRateLimit(id, rpm, rph) {
  const ts = now();
  const minuteWindow = ts - (ts % RATE_WINDOW_MS);
  const hourWindow = ts - (ts % HOUR_MS);

  let entry = rateLimits.get(id);
  if (!entry) {
    entry = {
      rpm: { windowStart: minuteWindow, count: 0 },
      rph: { windowStart: hourWindow, count: 0 },
    };
    rateLimits.set(id, entry);
  }

  // Reset windows if stale
  if (entry.rpm.windowStart !== minuteWindow) {
    entry.rpm = { windowStart: minuteWindow, count: 0 };
  }
  if (entry.rph.windowStart !== hourWindow) {
    entry.rph = { windowStart: hourWindow, count: 0 };
  }

  // Check limits
  if (entry.rpm.count >= rpm) {
    const retryAfterSec = Math.ceil((minuteWindow + RATE_WINDOW_MS - ts) / 1000);
    return { allowed: false, reason: 'rpm', retryAfterSec: retryAfterSec };
  }
  if (entry.rph.count >= rph) {
    const retryAfterSec2 = Math.ceil((hourWindow + HOUR_MS - ts) / 1000);
    return { allowed: false, reason: 'rph', retryAfterSec: retryAfterSec2 };
  }

  // Increment
  entry.rpm.count++;
  entry.rph.count++;

  return { allowed: true, retryAfterSec: 0 };
}

// ── Usage Tracking ─────────────────────────────────────────────

function recordTokenUsage(id) {
  const token = tokens.find(function (t) { return t.id === id; });
  if (!token) return;

  token.request_count++;
  token.last_used = isoNow();

  // Hourly bucket (ISO hour key: "2026-02-27T14")
  const hourKey = new Date().toISOString().slice(0, 13);
  if (!token.hourly_usage) token.hourly_usage = {};
  token.hourly_usage[hourKey] = (token.hourly_usage[hourKey] || 0) + 1;

  // Prune to last 24 entries
  const keys = Object.keys(token.hourly_usage).sort();
  while (keys.length > 24) {
    delete token.hourly_usage[keys.shift()];
  }

  markDirty();
}

function getTokenUsageHistory(id) {
  const token = tokens.find(function (t) { return t.id === id; });
  if (!token) return null;
  return token.hourly_usage || {};
}

// ── Init / Shutdown ────────────────────────────────────────────

function init(dbRef) {
  db = dbRef || null;
  loadTokens();
  // Write-coalescing: save dirty state at most once per 30 seconds
  saveTimer = setInterval(saveIfDirty, SAVE_INTERVAL_MS);
  if (saveTimer.unref) saveTimer.unref();
}

function shutdown() {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  saveIfDirty();
}

// ── Module Exports ─────────────────────────────────────────────

module.exports = {
  init: init,
  shutdown: shutdown,
  isEnabled: isEnabled,
  createToken: createToken,
  validateToken: validateToken,
  revokeToken: revokeToken,
  listTokens: listTokens,
  getToken: getToken,
  updateToken: updateToken,
  checkTokenRateLimit: checkTokenRateLimit,
  recordTokenUsage: recordTokenUsage,
  getTokenUsageHistory: getTokenUsageHistory,
};

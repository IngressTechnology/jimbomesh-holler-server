/**
 * JWT Validator — Tier 3 Authentication
 * Auth0 JWT validation with JWKS caching.
 * Only activates when JIMBOMESH_API_KEY env var is set (mesh-connected mode).
 *
 * Dependencies (lazy-required): jsonwebtoken, jwks-rsa
 */

const fs = require('fs');
const path = require('path');

// ── State ──────────────────────────────────────────────────────

let configured = false;
let auth0Config = null; // { domain, audience, issuer }
let jwksClient = null;

const CONFIG_PATH = path.join(__dirname, 'data', 'auth0-config.json');

// Per-buyer rate limiting: Map<buyerId, { rpm: { windowStart, count }, rph: { windowStart, count } }>
const buyerRateLimits = new Map();
const RATE_WINDOW_MS = 60000;
const HOUR_MS = 3600000;
const BUYER_LIMIT_MAX_AGE_MS = 2 * HOUR_MS;
const BUYER_LIMIT_PRUNE_INTERVAL_MS = 10 * 60000;

// ── Init ───────────────────────────────────────────────────────

function init() {
  // Only activate when JIMBOMESH_API_KEY is set (mesh-connected mode)
  if (!process.env.JIMBOMESH_API_KEY) {
    configured = false;
    return;
  }

  // Load Auth0 configuration
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('[jwt-validator] JIMBOMESH_API_KEY set but no auth0-config.json found — JWT auth inactive');
    configured = false;
    return;
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    auth0Config = JSON.parse(raw);
    if (!auth0Config.domain || !auth0Config.audience) {
      console.error('[jwt-validator] auth0-config.json missing domain or audience');
      configured = false;
      return;
    }
    if (!auth0Config.issuer) {
      auth0Config.issuer = 'https://' + auth0Config.domain + '/';
    }
  } catch (err) {
    console.error('[jwt-validator] Failed to read auth0-config.json:', err.message);
    configured = false;
    return;
  }

  // Lazy-require JWKS and JWT libs
  try {
    const jwksRsa = require('jwks-rsa');
    jwksClient = jwksRsa({
      jwksUri: 'https://' + auth0Config.domain + '/.well-known/jwks.json',
      cache: true,
      cacheMaxAge: 3600000, // 1-hour TTL
      rateLimit: true,
      jwksRequestsPerMinute: 5,
    });
    configured = true;
    _startPruneTimer();
    console.log('[jwt-validator] Auth0 JWT validation active (domain: ' + auth0Config.domain + ')');
  } catch (err) {
    console.error('[jwt-validator] Failed to initialize JWKS client:', err.message);
    configured = false;
  }
}

// ── Validation ─────────────────────────────────────────────────

function getSigningKey(header) {
  return new Promise(function (resolve, reject) {
    jwksClient.getSigningKey(header.kid, function (err, key) {
      if (err) return reject(err);
      resolve(key.getPublicKey());
    });
  });
}

async function validateJwt(token) {
  if (!configured || !jwksClient || !auth0Config) {
    throw new Error('JWT validation not configured');
  }

  const jwt = require('jsonwebtoken');

  // Decode header to get kid for JWKS lookup
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header) {
    throw new Error('Invalid JWT format');
  }

  const signingKey = await getSigningKey(decoded.header);

  return new Promise(function (resolve, reject) {
    jwt.verify(
      token,
      signingKey,
      {
        audience: auth0Config.audience,
        issuer: auth0Config.issuer,
        algorithms: ['RS256'],
      },
      function (err, payload) {
        if (err) return reject(err);

        // Extract claims
        const result = {
          buyerId: payload.sub || null,
          permissions: payload.permissions || [],
          rateLimits: payload['https://jimbomesh.ai/rate_limits'] || { rpm: 60, rph: 1000 },
          sessionId: payload.sid || null,
          expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
        };
        resolve(result);
      }
    );
  });
}

// ── Per-Buyer Rate Limiting ────────────────────────────────────

function checkBuyerRateLimit(buyerId, rpm, rph) {
  const ts = Date.now();
  const minuteWindow = ts - (ts % RATE_WINDOW_MS);
  const hourWindow = ts - (ts % HOUR_MS);

  let entry = buyerRateLimits.get(buyerId);
  if (!entry) {
    entry = {
      rpm: { windowStart: minuteWindow, count: 0 },
      rph: { windowStart: hourWindow, count: 0 },
    };
    buyerRateLimits.set(buyerId, entry);
  }

  if (entry.rpm.windowStart !== minuteWindow) {
    entry.rpm = { windowStart: minuteWindow, count: 0 };
  }
  if (entry.rph.windowStart !== hourWindow) {
    entry.rph = { windowStart: hourWindow, count: 0 };
  }

  if (entry.rpm.count >= rpm) {
    const retryAfterSec = Math.ceil((minuteWindow + RATE_WINDOW_MS - ts) / 1000);
    return { allowed: false, reason: 'rpm', retryAfterSec: retryAfterSec };
  }
  if (entry.rph.count >= rph) {
    const retryAfterSec2 = Math.ceil((hourWindow + HOUR_MS - ts) / 1000);
    return { allowed: false, reason: 'rph', retryAfterSec: retryAfterSec2 };
  }

  entry.rpm.count++;
  entry.rph.count++;

  return { allowed: true, retryAfterSec: 0 };
}

// ── Exports ────────────────────────────────────────────────────

function isConfigured() {
  return configured;
}

function getConfig() {
  if (!auth0Config) return null;
  return {
    domain: auth0Config.domain,
    audience: auth0Config.audience,
    issuer: auth0Config.issuer,
  };
}

// Periodically prune stale buyer rate limit entries to prevent unbounded growth
let _pruneInterval = null;
function _startPruneTimer() {
  if (_pruneInterval) return;
  _pruneInterval = setInterval(function () {
    const now = Date.now();
    const cutoff = now - BUYER_LIMIT_MAX_AGE_MS;
    for (const entry of buyerRateLimits) {
      const buyerId = entry[0];
      const limits = entry[1];
      if (limits.rpm.windowStart < cutoff && limits.rph.windowStart < cutoff) {
        buyerRateLimits.delete(buyerId);
      }
    }
  }, BUYER_LIMIT_PRUNE_INTERVAL_MS);
  if (_pruneInterval.unref) _pruneInterval.unref();
}

module.exports = {
  init: init,
  isConfigured: isConfigured,
  validateJwt: validateJwt,
  checkBuyerRateLimit: checkBuyerRateLimit,
  getConfig: getConfig,
  _startPruneTimer: _startPruneTimer,
};

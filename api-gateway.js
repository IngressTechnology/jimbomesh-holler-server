#!/usr/bin/env node
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

/**
 * Ollama API Gateway
 * Validates API keys before proxying requests to Ollama
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const db = require('./db');
const stats = require('./stats-collector');
const { createAdminRoutes } = require('./admin-routes');
const tokenManager = require('./token-manager');
const jwtValidator = require('./jwt-validator');
const { MeshConnector } = require('./mesh-connector');
const pkg = require('./package.json');

// Boot-time configuration (ports/TLS cannot change at runtime)
const PORT = parseInt(process.env.GATEWAY_PORT || '1920');
const OLLAMA_URL = process.env.OLLAMA_INTERNAL_URL || 'http://127.0.0.1:11435';
const OLLAMA_PARSED = new URL(OLLAMA_URL);
let currentApiKey = process.env.JIMBOMESH_HOLLER_API_KEY;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || null;
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000');
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || null;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || null;
const TLS_PASSPHRASE = process.env.TLS_PASSPHRASE || null;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const HOLLER_VERSION = pkg.version;
const NODE_RUNTIME_VERSION = process.version;

// Mesh connectivity (off-grid by default — set JIMBOMESH_API_KEY to enable)
const MESH_API_KEY = process.env.JIMBOMESH_API_KEY || '';
const MESH_URL = process.env.JIMBOMESH_COORDINATOR_URL || process.env.JIMBOMESH_MESH_URL || 'https://api.jimbomesh.ai';
const HOLLER_NAME = process.env.JIMBOMESH_HOLLER_NAME || '';
const HOLLER_ENDPOINT = process.env.JIMBOMESH_HOLLER_ENDPOINT || 'http://127.0.0.1:11435';
const AUTO_CONNECT = process.env.JIMBOMESH_AUTO_CONNECT !== 'false'; // default true

// Constant-time key comparison to prevent timing attacks
function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Runtime-configurable settings (read from SQLite, editable via admin UI)
const _cfgCache = {};
const CFG_TTL_MS = 5000;

function cfg(key, fallback) {
  const now = Date.now();
  const cached = _cfgCache[key];
  if (cached && now - cached.t < CFG_TTL_MS) return cached.v;
  try {
    const row = db.getSetting(key);
    const val = row != null ? parseInt(row) : fallback;
    _cfgCache[key] = { v: isNaN(val) ? fallback : val, t: now };
    return _cfgCache[key].v;
  } catch {
    return fallback;
  }
}

function RATE_LIMIT() {
  return cfg('rate_limit_per_min', 60);
}
function RATE_LIMIT_BURST() {
  return cfg('rate_limit_burst', 10);
}
function MAX_REQUEST_BODY_BYTES() {
  return cfg('max_request_body_bytes', 1048576);
}
function MAX_BATCH_SIZE() {
  return cfg('max_batch_size', 100);
}
function OLLAMA_TIMEOUT_MS() {
  return cfg('ollama_timeout_ms', 120000);
}
let detectedGpuCount = 0;
function MAX_CONCURRENT_REQUESTS() {
  const configured = cfg('max_concurrent_requests', null);
  if (configured !== null) return configured;
  return Math.max(1, detectedGpuCount);
}
function MAX_QUEUE_SIZE() {
  return cfg('max_queue_size', 50);
}

function _execFileAsync(cmd, args, opts) {
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, opts, function (err, stdout) {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function detectGpuCount() {
  try {
    const output = (
      await _execFileAsync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 })
    ).trim();
    const gpus = output.split('\n').filter((line) => line.trim().length > 0);
    console.log(`[api-gateway] Detected ${gpus.length} GPU(s): ${gpus.join(', ')}`);
    return gpus.length;
  } catch {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/ps`);
      if (resp.ok) {
        console.log('[api-gateway] nvidia-smi not available, defaulting GPU count from Ollama');
        return 1;
      }
    } catch {
      // intentionally empty: fallback to CPU-only mode
    }
    console.log('[api-gateway] No GPU detected, defaulting to CPU-only mode');
    return 0;
  }
}

function clearCfgCache() {
  Object.keys(_cfgCache).forEach(function (k) {
    delete _cfgCache[k];
  });
}

function estimateInputTokens(input) {
  let text = '';
  if (Array.isArray(input)) {
    text = input
      .map(function (v) {
        return typeof v === 'string' ? v : JSON.stringify(v);
      })
      .join(' ');
  } else if (typeof input === 'string') {
    text = input;
  } else if (input != null) {
    text = JSON.stringify(input);
  }
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.ceil(words * 1.3);
}

function hasToolCallsInMessage(message) {
  return !!(message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
}

// Child process PIDs (set by docker-entrypoint.sh before exec)
const OLLAMA_PID = process.env.OLLAMA_PID ? parseInt(process.env.OLLAMA_PID) : null;
const HEALTH_PID = process.env.HEALTH_PID ? parseInt(process.env.HEALTH_PID) : null;

let isShuttingDown = false;

// ── Model List Cache (30s TTL) ───────────────────────────────
let modelListCache = null;
let modelListCacheTime = 0;
const MODEL_CACHE_TTL_MS = 30000;
const HUGGINGFACE_MODELS_API = 'https://huggingface.co/api/models';

if (!currentApiKey) {
  console.error('[api-gateway] ERROR: JIMBOMESH_HOLLER_API_KEY must be set');
  process.exit(1);
}

// Key cross-contamination guards
if (currentApiKey.startsWith('jmsh_')) {
  console.error(
    '[api-gateway] ERROR: JIMBOMESH_HOLLER_API_KEY contains a SaaS mesh key (jmsh_*). This should be your LOCAL inference key. SaaS keys belong in JIMBOMESH_API_KEY.'
  );
  process.exit(1);
}
if (MESH_API_KEY && !MESH_API_KEY.startsWith('jmsh_')) {
  console.warn(
    '[api-gateway] WARNING: JIMBOMESH_API_KEY does not look like a SaaS key (expected jmsh_ prefix). Mesh connection may fail.'
  );
}
if (currentApiKey && MESH_API_KEY && currentApiKey === MESH_API_KEY) {
  console.error(
    '[api-gateway] ERROR: JIMBOMESH_HOLLER_API_KEY and JIMBOMESH_API_KEY must be different keys! Local inference and SaaS mesh credentials must never be the same.'
  );
  process.exit(1);
}

// Initialize Tier 3 (Auth0 JWT) eagerly.
jwtValidator.init();

// TLS validation: both cert and key must be set, or neither
if ((TLS_CERT_PATH && !TLS_KEY_PATH) || (!TLS_CERT_PATH && TLS_KEY_PATH)) {
  console.error('[api-gateway] ERROR: Both TLS_CERT_PATH and TLS_KEY_PATH must be set (or neither)');
  process.exit(1);
}

const useTls = !!(TLS_CERT_PATH && TLS_KEY_PATH);
const protocol = useTls ? 'HTTPS' : 'HTTP';

console.log(`[api-gateway] Starting on port ${PORT} (${protocol})`);
console.log(`[api-gateway] Proxying to ${OLLAMA_URL}`);
console.log(`[api-gateway] API key authentication enabled`);
if (ADMIN_API_KEY) {
  console.log(`[api-gateway] Separate admin key enabled (ADMIN_API_KEY)`);
}

// ── Activity Logging (SQLite) ─────────────────────────────────

const startTime = Date.now();

function recordActivity(entry) {
  try {
    db.logRequest(entry);
  } catch (err) {
    console.error('[api-gateway] Failed to log request to SQLite:', err.message);
  }
}

function getActivity() {
  try {
    return db.getRecentRequests(200, 0);
  } catch (err) {
    console.error('[api-gateway] Failed to read activity from SQLite:', err.message);
    return [];
  }
}

// ── Structured Error Response ─────────────────────────────────

function sendError(res, statusCode, code, message, extra = {}) {
  if (res.headersSent) return;

  const type = statusCode >= 500 ? 'server_error' : 'client_error';
  const headers = { 'Content-Type': 'application/json' };

  if (extra.retry_after) {
    headers['Retry-After'] = String(extra.retry_after);
  }

  const body = { error: { code, message, type } };
  if (extra.retry_after) body.error.retry_after = extra.retry_after;

  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
}

// ── Admin Routes ──────────────────────────────────────────────

let meshConnector = null;

const handleAdmin = createAdminRoutes({
  ollamaUrl: OLLAMA_URL,
  getApiKey: () => currentApiKey,
  setApiKey: (newKey) => {
    currentApiKey = newKey;
    db.setSetting('api_key_override', newKey);
    console.log('[api-gateway] API key rotated via admin UI');
  },
  adminApiKey: ADMIN_API_KEY,
  sendError,
  getActivity,
  startTime,
  db,
  onSettingsChanged: clearCfgCache,
  tokenManager,
  jwtValidator,
  getMeshConnector: () => meshConnector,
  setMeshConnector: (mc) => {
    meshConnector = mc;
  },
  getConcurrencyStats,
  meshUrl: MESH_URL,
  hollerVersion: HOLLER_VERSION,
  nodeVersion: NODE_RUNTIME_VERSION,
});

const adminEnabled = (process.env.ADMIN_ENABLED || 'true').toLowerCase() !== 'false';
if (adminEnabled) {
  console.log('[api-gateway] Admin UI enabled at /admin');
}

// ── Mesh Connectivity ──────────────────────────────────────────
function initMeshConnectivity() {
  const storedMeshApiKey = db.getSetting('mesh_api_key') || '';
  const storedAutoConnect = db.getSetting('mesh_auto_connect');
  const meshApiKeyForStartup = MESH_API_KEY || storedMeshApiKey;
  const autoConnectForStartup = storedAutoConnect == null ? AUTO_CONNECT : storedAutoConnect === 'true';

  if (meshApiKeyForStartup && autoConnectForStartup) {
    meshConnector = new MeshConnector({
      meshUrl: MESH_URL,
      apiKey: meshApiKeyForStartup,
      ollamaUrl: OLLAMA_URL,
      hollerEndpoint: HOLLER_ENDPOINT,
      db,
      version: HOLLER_VERSION,
      hollerName: HOLLER_NAME || undefined,
      getConcurrencyStats,
    });
    meshConnector.start();
  } else if (meshApiKeyForStartup) {
    console.log('[mesh] API key present but JIMBOMESH_AUTO_CONNECT=false — not connecting');
  } else {
    console.log('[mesh] Mesh mode disabled — running standalone');
  }
}

// ── Swagger UI (/docs) ──────────────────────────────────────

const SWAGGER_UI_DIR = path.dirname(require.resolve('swagger-ui-dist/package.json'));
const OPENAPI_SPEC_PATH = path.join(__dirname, 'openapi.yaml');
const SWAGGER_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.map': 'application/json',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
};

const SWAGGER_BRAND_DIR = __dirname; // swagger-brand.css & swagger-brand.js live alongside api-gateway.js
const SWAGGER_BRAND_FILES = { 'swagger-brand.css': true, 'swagger-brand.js': true };

const SWAGGER_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>JimboMesh Holler API Docs</title>
  <link rel="icon" href="/admin/assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/docs/swagger-ui.css">
  <link rel="stylesheet" href="/docs/swagger-brand.css">
  <style>html { box-sizing: border-box; } *, *::before, *::after { box-sizing: inherit; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/swagger-ui-bundle.js"></script>
  <script src="/docs/swagger-ui-standalone-preset.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/docs/openapi.yaml',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
    });
  </script>
  <script src="/docs/swagger-brand.js"></script>
</body>
</html>`;

function handleDocs(req, res) {
  const pathname = req.url.split('?')[0];

  const isDocsPath = pathname === '/docs' || pathname === '/docs/' || pathname.startsWith('/docs/');
  const isSpecAlias = pathname === '/openapi.yaml' || pathname === '/openapi.json';

  if (!isDocsPath && !isSpecAlias) return false;

  if (pathname === '/docs' || pathname === '/docs/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SWAGGER_INDEX_HTML);
    return true;
  }

  if (pathname === '/docs/openapi.yaml' || pathname === '/openapi.yaml') {
    try {
      const spec = fs.readFileSync(OPENAPI_SPEC_PATH);
      res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8' });
      res.end(spec);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'openapi.yaml not found' }));
    }
    return true;
  }

  if (pathname === '/openapi.json') {
    // Keep a stable unauthenticated alias without requiring a JSON conversion dependency.
    res.writeHead(302, { Location: '/openapi.yaml' });
    res.end();
    return true;
  }

  const relative = pathname.slice('/docs/'.length);
  if (relative.includes('..')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return true;
  }

  // Serve brand overrides from project dir before falling through to swagger-ui-dist
  const filePath = SWAGGER_BRAND_FILES[relative]
    ? path.join(SWAGGER_BRAND_DIR, relative)
    : path.join(SWAGGER_UI_DIR, relative);
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': SWAGGER_MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
  return true;
}

console.log('[api-gateway] Swagger UI available at /docs');

// ── Rate Limiting (SQLite-backed with in-memory cache) ───────

const RATE_WINDOW_MS = 60000; // 1 minute
const rateLimitCache = new Map(); // hot cache: key → { windowStart, count }

/**
 * Check and increment rate limit for a given IP.
 * Returns { allowed: boolean, remaining: number, retryAfterSec: number }
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - (now % RATE_WINDOW_MS); // align to minute boundary
  const effectiveLimit = RATE_LIMIT() + RATE_LIMIT_BURST();

  // Check hot cache first
  let entry = rateLimitCache.get(ip);

  if (!entry || entry.windowStart !== windowStart) {
    // Cache miss or stale window — check SQLite
    const row = db.getRateLimit(ip);
    if (row && row.window_start === windowStart) {
      entry = { windowStart: row.window_start, count: row.request_count };
    } else {
      entry = { windowStart, count: 0 };
    }
  }

  if (entry.count >= effectiveLimit) {
    const retryAfterSec = Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000);
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  entry.count++;
  rateLimitCache.set(ip, entry);

  // Write-through to SQLite
  db.upsertRateLimit(ip, entry.windowStart, entry.count);

  return { allowed: true, remaining: effectiveLimit - entry.count, retryAfterSec: 0 };
}

// Purge expired rate limit entries from SQLite and cache every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  db.purgeExpiredRateLimits(cutoff);

  for (const [key, entry] of rateLimitCache.entries()) {
    if (entry.windowStart < cutoff) {
      rateLimitCache.delete(key);
    }
  }
}, 5 * 60000);

// ── Concurrency Queue ────────────────────────────────────────

let activeOllamaRequests = 0;
const requestQueue = [];

function getConcurrencyStats() {
  return {
    maxConcurrentRequests: MAX_CONCURRENT_REQUESTS(),
    activeRequests: activeOllamaRequests,
    queueDepth: requestQueue.length,
    gpuCount: detectedGpuCount,
  };
}

function acquireSlot() {
  return new Promise((resolve, reject) => {
    if (activeOllamaRequests < MAX_CONCURRENT_REQUESTS()) {
      activeOllamaRequests++;
      resolve();
      return;
    }
    if (requestQueue.length >= MAX_QUEUE_SIZE()) {
      reject(new Error('queue_full'));
      return;
    }
    requestQueue.push({ resolve, reject });
  });
}

function releaseSlot() {
  if (requestQueue.length > 0 && activeOllamaRequests <= MAX_CONCURRENT_REQUESTS()) {
    const next = requestQueue.shift();
    next.resolve();
  } else {
    activeOllamaRequests--;
  }
}

// ── HTTP/HTTPS Server ────────────────────────────────────────

// ── Auth Helpers ──────────────────────────────────────────────

function routeToScope(method, pathname) {
  if (pathname === '/v1/embeddings' || pathname.startsWith('/api/embed')) return 'embeddings';
  if (pathname === '/v1/chat/completions' || pathname.startsWith('/api/chat') || pathname.startsWith('/api/generate'))
    return 'chat';
  if (pathname.startsWith('/v1/documents/')) return 'documents';
  return 'full';
}

function tokenHasPermission(token, scope) {
  if (token.permissions.includes('full')) return true;
  return token.permissions.includes(scope);
}

// Lazy-load document pipeline for public document routes
let _pipeline = null;
function getPipeline() {
  if (!_pipeline) {
    try {
      _pipeline = require('./document-pipeline');
    } catch (_) {
      _pipeline = null;
    }
  }
  return _pipeline;
}

// ── Model List Fetcher (with caching) ────────────────────────
function fetchModelList() {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    if (modelListCache && now - modelListCacheTime < MODEL_CACHE_TTL_MS) {
      resolve(modelListCache);
      return;
    }

    const req = http.request(
      {
        hostname: OLLAMA_PARSED.hostname,
        port: parseInt(OLLAMA_PARSED.port) || 11435,
        path: '/api/tags',
        method: 'GET',
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Ollama returned ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            modelListCache = parsed.models || [];
            modelListCacheTime = now;
            resolve(modelListCache);
          } catch {
            reject(new Error('Invalid JSON from Ollama'));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout fetching models'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

async function fetchHuggingFaceModels(reqUrl) {
  const reqParams = new URL(reqUrl, 'http://localhost').searchParams;
  const search = reqParams.get('search') || '';
  const task = reqParams.get('task') || '';
  const limit = Math.min(Math.max(parseInt(reqParams.get('limit') || '20', 10) || 20, 1), 100);

  const upstream = new URL(HUGGINGFACE_MODELS_API);
  upstream.searchParams.set('filter', 'gguf');
  upstream.searchParams.set('sort', 'downloads');
  upstream.searchParams.set('direction', '-1');
  upstream.searchParams.set('limit', String(limit));
  if (search) upstream.searchParams.set('search', search);
  if (task) upstream.searchParams.set('task', task);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(upstream, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': `JimboMesh-Holler/${HOLLER_VERSION}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HuggingFace returned ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function createRequestHandler() {
  return async (req, res) => {
    // Security headers on all responses
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (TLS_CERT_PATH) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');

    try {
      const clientIp = TRUST_PROXY
        ? (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress
        : req.socket.remoteAddress;
      const reqStart = Date.now();

      // Health/readiness probes (always available, even during shutdown)
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }

      if (req.url === '/readyz') {
        if (isShuttingDown) {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
          res.end(JSON.stringify({ status: 'shutting_down' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }

      // Swagger UI (unauthenticated, always available)
      if (handleDocs(req, res)) {
        return;
      }

      // Reject new requests during shutdown drain
      if (isShuttingDown) {
        console.log(`[api-gateway] ${clientIp} - 503 ${req.method} ${req.url} (shutting down)`);
        sendError(res, 503, 'shutting_down', 'Server is shutting down. Not accepting new requests.', {
          retry_after: 5,
        });
        return;
      }

      // Admin routes (handles own auth)
      if (handleAdmin(req, res)) {
        return;
      }

      // ── Tiered Authentication ──────────────────────────────────
      // Resolution order: Bearer token → X-API-Key → 401
      const pathname = req.url.split('?')[0];
      const authHeader = req.headers['authorization'];
      const xApiKey = req.headers['x-api-key'];
      let authResult = null; // { keyType, tokenObj? }

      if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
        // Tier 2 or 3: Bearer token
        const bearerToken = authHeader.slice(7).trim();

        if (!bearerToken) {
          recordActivity({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.url,
            status: 401,
            ip: clientIp,
            duration_ms: Date.now() - reqStart,
          });
          sendError(res, 401, 'auth_required', 'Empty bearer token');
          return;
        }

        if (bearerToken.startsWith('jmh_')) {
          // Tier 2: Bearer token (jmh_ prefix)
          if (!tokenManager.isEnabled()) {
            console.log(`[api-gateway] ${clientIp} - 403 Enhanced security disabled`);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 403,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
            });
            sendError(
              res,
              403,
              'enhanced_security_disabled',
              'Bearer token auth is not enabled. Enable Enhanced Security in Admin UI.'
            );
            return;
          }

          const validatedToken = tokenManager.validateToken(bearerToken);
          if (!validatedToken) {
            console.log(`[api-gateway] ${clientIp} - 401 Invalid or expired bearer token`);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 401,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
            });
            sendError(res, 401, 'auth_invalid', 'Invalid or expired bearer token');
            return;
          }

          // Check permission scope
          const scope = routeToScope(req.method, pathname);
          if (!tokenHasPermission(validatedToken, scope)) {
            console.log(`[api-gateway] ${clientIp} - 403 Token "${validatedToken.name}" lacks ${scope} permission`);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 403,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: 'bearer-token:' + validatedToken.name,
            });
            sendError(res, 403, 'permission_denied', `Token does not have "${scope}" permission`);
            return;
          }

          // Per-token rate limiting
          const tokenRate = tokenManager.checkTokenRateLimit(validatedToken.id, validatedToken.rpm, validatedToken.rph);
          if (!tokenRate.allowed) {
            console.log(
              `[api-gateway] ${clientIp} - 429 Token "${validatedToken.name}" rate limit (${tokenRate.reason})`
            );
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 429,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: 'bearer-token:' + validatedToken.name,
            });
            sendError(
              res,
              429,
              'rate_limited',
              `Token rate limit exceeded (${tokenRate.reason}). Try again in ${tokenRate.retryAfterSec} seconds.`,
              { retry_after: tokenRate.retryAfterSec }
            );
            return;
          }

          // Record usage
          tokenManager.recordTokenUsage(validatedToken.id);
          authResult = { keyType: 'bearer-token:' + validatedToken.name, tokenObj: validatedToken };
        } else if (bearerToken.startsWith('eyJ')) {
          // Tier 3: Auth0 JWT
          if (!jwtValidator.isConfigured()) {
            console.log(`[api-gateway] ${clientIp} - 401 JWT auth not configured`);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 401,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
            });
            sendError(res, 401, 'auth_invalid', 'JWT authentication is not configured on this server');
            return;
          }

          try {
            const jwtResult = await jwtValidator.validateJwt(bearerToken);

            // Per-buyer rate limiting
            const buyerRate = jwtValidator.checkBuyerRateLimit(
              jwtResult.buyerId,
              jwtResult.rateLimits.rpm || 60,
              jwtResult.rateLimits.rph || 1000
            );
            if (!buyerRate.allowed) {
              console.log(
                `[api-gateway] ${clientIp} - 429 JWT buyer "${jwtResult.buyerId}" rate limit (${buyerRate.reason})`
              );
              recordActivity({
                timestamp: new Date().toISOString(),
                method: req.method,
                path: req.url,
                status: 429,
                ip: clientIp,
                duration_ms: Date.now() - reqStart,
                auth_type: 'jwt:' + jwtResult.buyerId,
              });
              sendError(
                res,
                429,
                'rate_limited',
                `Rate limit exceeded (${buyerRate.reason}). Try again in ${buyerRate.retryAfterSec} seconds.`,
                { retry_after: buyerRate.retryAfterSec }
              );
              return;
            }

            authResult = { keyType: 'jwt:' + jwtResult.buyerId, jwtClaims: jwtResult };
          } catch (jwtErr) {
            console.log(`[api-gateway] ${clientIp} - 401 JWT validation failed: ${jwtErr.message}`);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 401,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
            });
            sendError(res, 401, 'auth_invalid', 'Invalid or expired JWT');
            return;
          }
        } else {
          // Tier 1 fallback: Try matching raw API key via Bearer header
          // This enables OpenAI-compatible clients (Cursor, Continue, LiteLLM,
          // OpenClaw, Open WebUI) that only send Authorization: Bearer <key>
          const isInferenceKey = safeCompare(bearerToken, currentApiKey);
          const isAdminKey = ADMIN_API_KEY && safeCompare(bearerToken, ADMIN_API_KEY);

          if (isInferenceKey || isAdminKey) {
            authResult = { keyType: isAdminKey ? 'admin-key' : 'inference-key' };

            // IP-based rate limiting (same as X-API-Key path)
            const rateResult = checkRateLimit(clientIp);
            if (!rateResult.allowed) {
              console.log(`[api-gateway] ${clientIp} - 429 Rate limit exceeded`);
              recordActivity({
                timestamp: new Date().toISOString(),
                method: req.method,
                path: req.url,
                status: 429,
                ip: clientIp,
                duration_ms: Date.now() - reqStart,
                auth_type: authResult.keyType,
              });
              sendError(
                res,
                429,
                'rate_limited',
                `Rate limit exceeded. Try again in ${rateResult.retryAfterSec} seconds.`,
                { retry_after: rateResult.retryAfterSec }
              );
              return;
            }
          } else {
            // Genuinely unrecognized token
            console.log(`[api-gateway] ${clientIp} - 401 Unrecognized bearer token`);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 401,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
            });
            sendError(res, 401, 'auth_invalid', 'Invalid API key or unrecognized bearer token format');
            return;
          }
        }
      } else if (xApiKey) {
        // Tier 1: X-API-Key header (existing behavior)
        const isInferenceKey = safeCompare(xApiKey, currentApiKey);
        const isAdminKey = ADMIN_API_KEY && safeCompare(xApiKey, ADMIN_API_KEY);

        if (!isInferenceKey && !isAdminKey) {
          console.log(`[api-gateway] ${clientIp} - 403 Invalid API key`);
          recordActivity({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.url,
            status: 403,
            ip: clientIp,
            duration_ms: Date.now() - reqStart,
          });
          sendError(res, 403, 'auth_invalid', 'Invalid API key');
          return;
        }

        authResult = { keyType: isAdminKey ? 'admin-key' : 'inference-key' };

        // IP-based rate limiting (existing behavior for X-API-Key)
        const rateResult = checkRateLimit(clientIp);
        if (!rateResult.allowed) {
          console.log(`[api-gateway] ${clientIp} - 429 Rate limit exceeded`);
          recordActivity({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.url,
            status: 429,
            ip: clientIp,
            duration_ms: Date.now() - reqStart,
            auth_type: authResult.keyType,
          });
          sendError(
            res,
            429,
            'rate_limited',
            `Rate limit exceeded. Try again in ${rateResult.retryAfterSec} seconds.`,
            { retry_after: rateResult.retryAfterSec }
          );
          return;
        }
      } else {
        // No auth provided
        console.log(`[api-gateway] ${clientIp} - 401 Missing API key`);
        recordActivity({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: req.url,
          status: 401,
          ip: clientIp,
          duration_ms: Date.now() - reqStart,
        });
        sendError(res, 401, 'auth_required', 'Missing X-API-Key or Authorization: Bearer header');
        return;
      }

      const keyType = authResult.keyType;

      // ── OpenAI-compatible /v1/embeddings endpoint ───────────────
      if (req.method === 'POST' && req.url === '/v1/embeddings') {
        const maxBody = MAX_REQUEST_BODY_BYTES();
        const maxBatch = MAX_BATCH_SIZE();
        const ollamaTimeout = OLLAMA_TIMEOUT_MS();

        // Early Content-Length check
        const declaredLength = parseInt(req.headers['content-length']);
        if (declaredLength > maxBody) {
          console.log(
            `[api-gateway] ${clientIp} - 413 POST /v1/embeddings (body ${declaredLength} > limit ${maxBody})`
          );
          recordActivity({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.url,
            status: 413,
            ip: clientIp,
            duration_ms: Date.now() - reqStart,
            auth_type: keyType,
          });
          sendError(
            res,
            413,
            'payload_too_large',
            `Request body of ${declaredLength} bytes exceeds ${maxBody} byte limit`
          );
          req.resume();
          return;
        }

        let body = '';
        let bytesRead = 0;
        let aborted = false;

        req.on('data', (chunk) => {
          bytesRead += chunk.length;
          if (bytesRead > maxBody && !aborted) {
            aborted = true;
            console.log(`[api-gateway] ${clientIp} - 413 POST /v1/embeddings (body ${bytesRead} > limit ${maxBody})`);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 413,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 413, 'payload_too_large', `Request body exceeds ${maxBody} byte limit`);
            req.destroy();
            return;
          }
          body += chunk;
        });

        req.on('end', () => {
          if (aborted) return;

          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 400,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 400, 'invalid_request', 'Request body is not valid JSON');
            return;
          }

          const model = parsed.model || process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
          const input = parsed.input;
          if (!input) {
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 400,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 400, 'invalid_request', 'Missing required field: input');
            return;
          }

          const inputs = Array.isArray(input) ? input : [input];
          const tracking = stats.startRequest(crypto.randomUUID(), model);
          tracking.inputTokens = estimateInputTokens(input);

          // Batch size check
          if (inputs.length > maxBatch) {
            console.log(
              `[api-gateway] ${clientIp} - 400 POST /v1/embeddings (batch ${inputs.length} > limit ${maxBatch})`
            );
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 400,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 400, 'batch_too_large', `Batch size ${inputs.length} exceeds maximum of ${maxBatch}`);
            stats.failRequest(tracking, new Error('Batch size exceeded')).catch(function () {});
            return;
          }

          // Acquire concurrency slot
          acquireSlot()
            .then(() => {
              let slotReleased = false;
              function releaseOnce() {
                if (!slotReleased) {
                  slotReleased = true;
                  releaseSlot();
                }
              }

              const ollamaBody = JSON.stringify({ model, input: inputs });
              const ollamaReq = http.request(
                {
                  hostname: OLLAMA_PARSED.hostname,
                  port: parseInt(OLLAMA_PARSED.port) || 11435,
                  path: '/api/embed',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ollamaBody) },
                  timeout: ollamaTimeout,
                },
                (ollamaRes) => {
                  let ollamaData = '';
                  ollamaRes.on('data', (chunk) => {
                    ollamaData += chunk;
                  });
                  ollamaRes.on('end', () => {
                    releaseOnce();

                    if (ollamaRes.statusCode !== 200) {
                      stats
                        .failRequest(tracking, new Error('Ollama HTTP ' + ollamaRes.statusCode))
                        .catch(function () {});
                      recordActivity({
                        timestamp: new Date().toISOString(),
                        method: req.method,
                        path: req.url,
                        status: ollamaRes.statusCode,
                        ip: clientIp,
                        duration_ms: Date.now() - reqStart,
                        auth_type: keyType,
                      });
                      res.writeHead(ollamaRes.statusCode, { 'Content-Type': 'application/json' });
                      res.end(ollamaData);
                      return;
                    }

                    let ollamaResult;
                    try {
                      ollamaResult = JSON.parse(ollamaData);
                    } catch {
                      stats
                        .failRequest(tracking, new Error('Invalid JSON from Ollama embed response'))
                        .catch(function () {});
                      recordActivity({
                        timestamp: new Date().toISOString(),
                        method: req.method,
                        path: req.url,
                        status: 502,
                        ip: clientIp,
                        duration_ms: Date.now() - reqStart,
                        auth_type: keyType,
                      });
                      sendError(res, 502, 'model_error', 'Invalid response from Ollama backend');
                      return;
                    }

                    const embeddings = ollamaResult.embeddings || [];
                    const data = embeddings.map((embedding, index) => ({
                      object: 'embedding',
                      embedding,
                      index,
                    }));

                    const totalChars = inputs.reduce((sum, t) => sum + (typeof t === 'string' ? t.length : 0), 0);
                    const estimatedTokens = Math.ceil(totalChars / 4);

                    const openaiResponse = {
                      object: 'list',
                      data,
                      model: ollamaResult.model || model,
                      usage: { prompt_tokens: estimatedTokens, total_tokens: estimatedTokens },
                    };

                    console.log(
                      `[api-gateway] ${clientIp} - 200 POST /v1/embeddings (${inputs.length} input(s), ${keyType})`
                    );
                    stats
                      .completeRequest(tracking, {
                        prompt_eval_count: tracking.inputTokens,
                        eval_count: 0,
                        isToolCall: false,
                      })
                      .catch(function () {});
                    recordActivity({
                      timestamp: new Date().toISOString(),
                      method: req.method,
                      path: req.url,
                      status: 200,
                      ip: clientIp,
                      duration_ms: Date.now() - reqStart,
                      auth_type: keyType,
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(openaiResponse));
                  });
                }
              );

              ollamaReq.on('timeout', () => {
                ollamaReq.destroy();
                releaseOnce();
                stats.failRequest(tracking, new Error('Ollama embed timeout')).catch(function () {});
                console.log(`[api-gateway] ${clientIp} - 504 POST /v1/embeddings (timeout ${ollamaTimeout}ms)`);
                recordActivity({
                  timestamp: new Date().toISOString(),
                  method: req.method,
                  path: req.url,
                  status: 504,
                  ip: clientIp,
                  duration_ms: Date.now() - reqStart,
                  auth_type: keyType,
                });
                sendError(res, 504, 'request_timeout', `Ollama did not respond within ${ollamaTimeout}ms`);
              });

              ollamaReq.on('error', (err) => {
                releaseOnce();
                stats.failRequest(tracking, err).catch(function () {});
                console.error(`[api-gateway] /v1/embeddings proxy error:`, err.message);
                recordActivity({
                  timestamp: new Date().toISOString(),
                  method: req.method,
                  path: req.url,
                  status: 502,
                  ip: clientIp,
                  duration_ms: Date.now() - reqStart,
                  auth_type: keyType,
                });
                sendError(res, 502, 'model_error', 'Ollama service unavailable');
              });

              ollamaReq.write(ollamaBody);
              ollamaReq.end();
            })
            .catch((err) => {
              if (err.message === 'queue_full') {
                stats.failRequest(tracking, err).catch(function () {});
                console.log(`[api-gateway] ${clientIp} - 429 POST /v1/embeddings (queue full: ${requestQueue.length})`);
                recordActivity({
                  timestamp: new Date().toISOString(),
                  method: req.method,
                  path: req.url,
                  status: 429,
                  ip: clientIp,
                  duration_ms: Date.now() - reqStart,
                  auth_type: keyType,
                });
                sendError(res, 429, 'queue_full', `Server busy. ${MAX_QUEUE_SIZE()} requests already queued.`, {
                  retry_after: 5,
                });
              }
            });
        });
        return;
      }

      // ── OpenAI-compatible GET /v1/models endpoint ───────────────
      if (req.method === 'GET' && req.url === '/v1/models') {
        fetchModelList()
          .then((models) => {
            const openaiModels = models.map((m) => ({
              id: m.name,
              object: 'model',
              created: m.modified_at
                ? Math.floor(new Date(m.modified_at).getTime() / 1000)
                : Math.floor(Date.now() / 1000),
              owned_by: 'jimbomesh-holler',
            }));

            const response = {
              object: 'list',
              data: openaiModels,
            };

            console.log(`[api-gateway] ${clientIp} - 200 GET /v1/models (${openaiModels.length} models, ${keyType})`);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 200,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          })
          .catch((err) => {
            console.error(`[api-gateway] GET /v1/models error:`, err.message);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 503,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 503, 'model_list_unavailable', 'Could not fetch model list from Ollama');
          });
        return;
      }

      // ── Hugging Face Model Search Proxy ─────────────────────────
      if (req.method === 'GET' && pathname === '/api/models/huggingface') {
        try {
          const models = await fetchHuggingFaceModels(req.url);
          console.log(`[api-gateway] ${clientIp} - 200 GET ${req.url} (${keyType})`);
          recordActivity({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.url,
            status: 200,
            ip: clientIp,
            duration_ms: Date.now() - reqStart,
            auth_type: keyType,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(models));
        } catch (err) {
          console.error(`[api-gateway] HuggingFace proxy error:`, err.message);
          recordActivity({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.url,
            status: 502,
            ip: clientIp,
            duration_ms: Date.now() - reqStart,
            auth_type: keyType,
          });
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'HuggingFace API unavailable' }));
        }
        return;
      }

      // ── OpenAI-compatible POST /v1/chat/completions endpoint ────
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const maxBody = MAX_REQUEST_BODY_BYTES();
        const ollamaTimeout = OLLAMA_TIMEOUT_MS();

        // Early Content-Length check
        const declaredLength = parseInt(req.headers['content-length']);
        if (declaredLength > maxBody) {
          console.log(
            `[api-gateway] ${clientIp} - 413 POST /v1/chat/completions (body ${declaredLength} > limit ${maxBody})`
          );
          recordActivity({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.url,
            status: 413,
            ip: clientIp,
            duration_ms: Date.now() - reqStart,
            auth_type: keyType,
          });
          sendError(
            res,
            413,
            'payload_too_large',
            `Request body of ${declaredLength} bytes exceeds ${maxBody} byte limit`
          );
          req.resume();
          return;
        }

        let body = '';
        let bytesRead = 0;
        let aborted = false;

        req.on('data', (chunk) => {
          bytesRead += chunk.length;
          if (bytesRead > maxBody && !aborted) {
            aborted = true;
            console.log(
              `[api-gateway] ${clientIp} - 413 POST /v1/chat/completions (body ${bytesRead} > limit ${maxBody})`
            );
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 413,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 413, 'payload_too_large', `Request body exceeds ${maxBody} byte limit`);
            req.destroy();
            return;
          }
          body += chunk;
        });

        req.on('end', async () => {
          if (aborted) return;

          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 400,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 400, 'invalid_request', 'Request body is not valid JSON');
            return;
          }

          // Extract and validate parameters
          const messages = parsed.messages;
          if (!messages || !Array.isArray(messages) || messages.length === 0) {
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 400,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 400, 'invalid_request', 'Missing or invalid "messages" array');
            return;
          }

          // Validate message format
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg.role || !msg.content) {
              recordActivity({
                timestamp: new Date().toISOString(),
                method: req.method,
                path: req.url,
                status: 400,
                ip: clientIp,
                duration_ms: Date.now() - reqStart,
                auth_type: keyType,
              });
              sendError(res, 400, 'invalid_request', `Message at index ${i} missing "role" or "content"`);
              return;
            }
          }

          // Determine model (use default if not specified)
          let model = parsed.model;
          if (!model) {
            const defaultChatModel = process.env.HOLLER_DEFAULT_CHAT_MODEL;
            if (defaultChatModel) {
              model = defaultChatModel;
            } else {
              // Auto-detect first non-embedding model
              try {
                const models = await fetchModelList();
                const chatModel = models.find((m) => !m.name.includes('embed'));
                model = chatModel ? chatModel.name : models[0] ? models[0].name : null;
              } catch {
                // Fallback
                model = 'llama3.1:8b';
              }
            }
          }

          if (!model) {
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 400,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 400, 'invalid_request', 'No model specified and no default available');
            return;
          }

          // Validate model exists
          try {
            const models = await fetchModelList();
            const modelExists = models.some((m) => m.name === model);
            if (!modelExists) {
              const availableModels = models.map((m) => m.name).join(', ');
              recordActivity({
                timestamp: new Date().toISOString(),
                method: req.method,
                path: req.url,
                status: 404,
                ip: clientIp,
                duration_ms: Date.now() - reqStart,
                auth_type: keyType,
              });
              sendError(
                res,
                404,
                'model_not_found',
                `Model '${model}' not found. Available models: ${availableModels}`
              );
              return;
            }
          } catch (err) {
            console.error(`[api-gateway] Model validation error:`, err.message);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 503,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 503, 'model_list_unavailable', 'Could not validate model availability');
            return;
          }

          const stream = parsed.stream === true;
          const tracking = stats.startRequest(crypto.randomUUID(), model);

          // Build Ollama request (translate OpenAI params to Ollama format)
          const ollamaReqBody = {
            model: model,
            messages: messages,
            stream: stream,
          };

          // Map options
          const options = {};
          if (parsed.temperature !== undefined) options.temperature = parsed.temperature;
          if (parsed.top_p !== undefined) options.top_p = parsed.top_p;
          if (parsed.max_tokens !== undefined) options.num_predict = parsed.max_tokens;
          if (parsed.stop !== undefined) options.stop = Array.isArray(parsed.stop) ? parsed.stop : [parsed.stop];
          if (parsed.presence_penalty !== undefined) options.presence_penalty = parsed.presence_penalty;
          if (parsed.frequency_penalty !== undefined) options.frequency_penalty = parsed.frequency_penalty;

          if (Object.keys(options).length > 0) {
            ollamaReqBody.options = options;
          }

          // Acquire concurrency slot
          acquireSlot()
            .then(() => {
              let slotReleased = false;
              function releaseOnce() {
                if (!slotReleased) {
                  slotReleased = true;
                  releaseSlot();
                }
              }

              const ollamaBody = JSON.stringify(ollamaReqBody);
              const ollamaReq = http.request(
                {
                  hostname: OLLAMA_PARSED.hostname,
                  port: parseInt(OLLAMA_PARSED.port) || 11435,
                  path: '/api/chat',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ollamaBody) },
                  timeout: ollamaTimeout,
                },
                (ollamaRes) => {
                  if (stream) {
                    // ── Streaming Response (SSE) ──────────────────────────
                    res.writeHead(200, {
                      'Content-Type': 'text/event-stream',
                      'Cache-Control': 'no-cache',
                      Connection: 'keep-alive',
                    });

                    const chatId = 'chatcmpl-holler-' + crypto.randomUUID();
                    const created = Math.floor(Date.now() / 1000);
                    let isFirstChunk = true;
                    let streamBuffer = '';
                    let sawToolCalls = false;
                    let streamRecorded = false;

                    ollamaRes.on('data', (chunk) => {
                      streamBuffer += chunk.toString();
                      const lines = streamBuffer.split('\n');
                      streamBuffer = lines.pop();
                      for (let i = 0; i < lines.length; i++) {
                        try {
                          const obj = JSON.parse(lines[i]);

                          if (isFirstChunk && obj.message) {
                            stats.onFirstToken(tracking);
                            // First chunk: send role
                            const firstChunk = {
                              id: chatId,
                              object: 'chat.completion.chunk',
                              created: created,
                              model: model,
                              choices: [
                                {
                                  index: 0,
                                  delta: { role: 'assistant' },
                                  finish_reason: null,
                                },
                              ],
                            };
                            res.write('data: ' + JSON.stringify(firstChunk) + '\n\n');
                            isFirstChunk = false;
                          }

                          if (obj.message && obj.message.content) {
                            // Content chunk
                            const contentChunk = {
                              id: chatId,
                              object: 'chat.completion.chunk',
                              created: created,
                              model: model,
                              choices: [
                                {
                                  index: 0,
                                  delta: { content: obj.message.content },
                                  finish_reason: null,
                                },
                              ],
                            };
                            res.write('data: ' + JSON.stringify(contentChunk) + '\n\n');
                          }

                          if (obj.message && hasToolCallsInMessage(obj.message)) {
                            sawToolCalls = true;
                          }

                          if (obj.done) {
                            // Final chunk
                            const finishReason = obj.done_reason === 'length' ? 'length' : 'stop';
                            const finalChunk = {
                              id: chatId,
                              object: 'chat.completion.chunk',
                              created: created,
                              model: model,
                              choices: [
                                {
                                  index: 0,
                                  delta: {},
                                  finish_reason: finishReason,
                                },
                              ],
                            };
                            res.write('data: ' + JSON.stringify(finalChunk) + '\n\n');
                            res.write('data: [DONE]\n\n');
                            if (!streamRecorded) {
                              streamRecorded = true;
                              stats
                                .completeRequest(tracking, {
                                  prompt_eval_count: obj.prompt_eval_count || 0,
                                  eval_count: obj.eval_count || 0,
                                  isToolCall: sawToolCalls,
                                })
                                .catch(function () {});
                            }
                          }
                        } catch (_parseErr) {
                          // Partial JSON line, skip
                        }
                      }
                    });

                    ollamaRes.on('end', () => {
                      if (!streamRecorded) {
                        streamRecorded = true;
                        stats
                          .completeRequest(tracking, {
                            prompt_eval_count: 0,
                            eval_count: 0,
                            isToolCall: sawToolCalls,
                          })
                          .catch(function () {});
                      }
                      releaseOnce();
                      console.log(`[api-gateway] ${clientIp} - 200 POST /v1/chat/completions (stream, ${keyType})`);
                      recordActivity({
                        timestamp: new Date().toISOString(),
                        method: req.method,
                        path: req.url,
                        status: 200,
                        ip: clientIp,
                        duration_ms: Date.now() - reqStart,
                        auth_type: keyType,
                        request_type: 'chat',
                      });
                      res.end();
                    });

                    ollamaRes.on('error', () => {
                      releaseOnce();
                      if (!streamRecorded) {
                        streamRecorded = true;
                        stats.failRequest(tracking, new Error('Streaming response error')).catch(function () {});
                      }
                    });
                  } else {
                    // ── Non-Streaming Response ───────────────────────────
                    let ollamaData = '';
                    ollamaRes.on('data', (chunk) => {
                      ollamaData += chunk;
                    });
                    ollamaRes.on('end', () => {
                      releaseOnce();

                      if (ollamaRes.statusCode !== 200) {
                        stats
                          .failRequest(tracking, new Error('Ollama HTTP ' + ollamaRes.statusCode))
                          .catch(function () {});
                        recordActivity({
                          timestamp: new Date().toISOString(),
                          method: req.method,
                          path: req.url,
                          status: ollamaRes.statusCode,
                          ip: clientIp,
                          duration_ms: Date.now() - reqStart,
                          auth_type: keyType,
                        });
                        res.writeHead(ollamaRes.statusCode, { 'Content-Type': 'application/json' });
                        res.end(ollamaData);
                        return;
                      }

                      let ollamaResult;
                      try {
                        ollamaResult = JSON.parse(ollamaData);
                      } catch {
                        stats
                          .failRequest(tracking, new Error('Invalid JSON from Ollama chat response'))
                          .catch(function () {});
                        recordActivity({
                          timestamp: new Date().toISOString(),
                          method: req.method,
                          path: req.url,
                          status: 502,
                          ip: clientIp,
                          duration_ms: Date.now() - reqStart,
                          auth_type: keyType,
                        });
                        sendError(res, 502, 'model_error', 'Invalid response from Ollama backend');
                        return;
                      }

                      // Build OpenAI-format response
                      const finishReason = ollamaResult.done_reason === 'length' ? 'length' : 'stop';
                      const promptTokens = ollamaResult.prompt_eval_count || 0;
                      const completionTokens = ollamaResult.eval_count || 0;
                      const toolCall = hasToolCallsInMessage(ollamaResult.message);

                      const openaiResponse = {
                        id: 'chatcmpl-holler-' + crypto.randomUUID(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: ollamaResult.model || model,
                        choices: [
                          {
                            index: 0,
                            message: {
                              role: 'assistant',
                              content: ollamaResult.message ? ollamaResult.message.content : '',
                            },
                            finish_reason: finishReason,
                          },
                        ],
                        usage: {
                          prompt_tokens: promptTokens,
                          completion_tokens: completionTokens,
                          total_tokens: promptTokens + completionTokens,
                        },
                      };

                      console.log(`[api-gateway] ${clientIp} - 200 POST /v1/chat/completions (${keyType})`);
                      stats
                        .completeRequest(tracking, {
                          prompt_eval_count: promptTokens,
                          eval_count: completionTokens,
                          isToolCall: toolCall,
                        })
                        .catch(function () {});
                      recordActivity({
                        timestamp: new Date().toISOString(),
                        method: req.method,
                        path: req.url,
                        status: 200,
                        ip: clientIp,
                        duration_ms: Date.now() - reqStart,
                        auth_type: keyType,
                        request_type: 'chat',
                      });
                      res.writeHead(200, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify(openaiResponse));
                    });
                  }
                }
              );

              ollamaReq.on('timeout', () => {
                ollamaReq.destroy();
                releaseOnce();
                stats.failRequest(tracking, new Error('Ollama chat timeout')).catch(function () {});
                console.log(`[api-gateway] ${clientIp} - 504 POST /v1/chat/completions (timeout ${ollamaTimeout}ms)`);
                recordActivity({
                  timestamp: new Date().toISOString(),
                  method: req.method,
                  path: req.url,
                  status: 504,
                  ip: clientIp,
                  duration_ms: Date.now() - reqStart,
                  auth_type: keyType,
                });
                sendError(res, 504, 'request_timeout', `Ollama did not respond within ${ollamaTimeout}ms`);
              });

              ollamaReq.on('error', (err) => {
                releaseOnce();
                stats.failRequest(tracking, err).catch(function () {});
                console.error(`[api-gateway] /v1/chat/completions proxy error:`, err.message);
                recordActivity({
                  timestamp: new Date().toISOString(),
                  method: req.method,
                  path: req.url,
                  status: 502,
                  ip: clientIp,
                  duration_ms: Date.now() - reqStart,
                  auth_type: keyType,
                });
                sendError(res, 502, 'model_error', 'Ollama service unavailable');
              });

              ollamaReq.write(ollamaBody);
              ollamaReq.end();
            })
            .catch((err) => {
              if (err.message === 'queue_full') {
                stats.failRequest(tracking, err).catch(function () {});
                console.log(
                  `[api-gateway] ${clientIp} - 429 POST /v1/chat/completions (queue full: ${requestQueue.length})`
                );
                recordActivity({
                  timestamp: new Date().toISOString(),
                  method: req.method,
                  path: req.url,
                  status: 429,
                  ip: clientIp,
                  duration_ms: Date.now() - reqStart,
                  auth_type: keyType,
                });
                sendError(res, 429, 'queue_full', `Server busy. ${MAX_QUEUE_SIZE()} requests already queued.`, {
                  retry_after: 5,
                });
              }
            });
        });
        return;
      }

      // ── Public Document Routes (bearer token with documents scope) ─
      if (req.method === 'POST' && pathname === '/v1/documents/search') {
        const pipeline = getPipeline();
        if (!pipeline) {
          sendError(res, 501, 'not_available', 'Document pipeline not available');
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.query) {
              sendError(res, 400, 'invalid_request', 'Missing query');
              return;
            }
            const collection = parsed.collection || process.env.DOCUMENTS_COLLECTION || 'documents';
            const hits = await pipeline.searchDocuments(parsed.query, collection, parsed.limit || 5);
            const results = hits.map(function (h) {
              return { score: h.score, payload: h.payload };
            });
            console.log(`[api-gateway] ${clientIp} - 200 POST /v1/documents/search (${keyType})`);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 200,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: results }));
          } catch (err) {
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 500,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 500, 'search_error', err.message);
          }
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/documents/ask') {
        const pipeline = getPipeline();
        if (!pipeline) {
          sendError(res, 501, 'not_available', 'Document pipeline not available');
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.query) {
              sendError(res, 400, 'invalid_request', 'Missing query');
              return;
            }
            const collection = parsed.collection || process.env.DOCUMENTS_COLLECTION || 'documents';
            const chatModel =
              parsed.model || process.env.HOLLER_MODELS?.split(',').find((m) => !m.includes('embed')) || 'llama3.1:8b';
            const askResult = await pipeline.askDocuments(parsed.query, collection, chatModel, parsed.limit || 5);

            if (!askResult.messages) {
              console.log(`[api-gateway] ${clientIp} - 200 POST /v1/documents/ask — no results (${keyType})`);
              recordActivity({
                timestamp: new Date().toISOString(),
                method: req.method,
                path: req.url,
                status: 200,
                ip: clientIp,
                duration_ms: Date.now() - reqStart,
                auth_type: keyType,
              });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ answer: 'No relevant documents found.', sources: [] }));
              return;
            }

            // Stream SSE response (same format as admin ask endpoint)
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            const sources = askResult.hits.map(function (h) {
              return {
                score: h.score,
                filename: h.payload.filename,
                chunk_index: h.payload.chunk_index,
                text: h.payload.text,
              };
            });
            res.write('data: ' + JSON.stringify({ type: 'sources', sources: sources }) + '\n\n');

            // Chat with Ollama
            const ollamaBody = JSON.stringify({ model: chatModel, messages: askResult.messages, stream: true });
            const chatReq = http.request(
              {
                hostname: OLLAMA_PARSED.hostname,
                port: parseInt(OLLAMA_PARSED.port) || 11435,
                path: '/api/chat',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ollamaBody) },
              },
              (chatRes) => {
                chatRes.on('data', (chunk) => {
                  const lines = chunk.toString().split('\n').filter(Boolean);
                  for (let i = 0; i < lines.length; i++) {
                    try {
                      const obj = JSON.parse(lines[i]);
                      if (obj.message && obj.message.content) {
                        res.write('data: ' + JSON.stringify({ type: 'token', content: obj.message.content }) + '\n\n');
                      }
                      if (obj.done) {
                        res.write('data: ' + JSON.stringify({ type: 'done' }) + '\n\n');
                      }
                    } catch (_) {
                      /* partial JSON line */
                    }
                  }
                });
                chatRes.on('end', () => {
                  recordActivity({
                    timestamp: new Date().toISOString(),
                    method: req.method,
                    path: req.url,
                    status: 200,
                    ip: clientIp,
                    duration_ms: Date.now() - reqStart,
                    auth_type: keyType,
                  });
                  res.end();
                });
              }
            );
            chatReq.on('error', (err) => {
              res.write('data: ' + JSON.stringify({ type: 'error', error: err.message }) + '\n\n');
              res.end();
            });
            chatReq.write(ollamaBody);
            chatReq.end();
          } catch (err) {
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 500,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 500, 'ask_error', err.message);
          }
        });
        return;
      }

      // ── Proxy to Ollama (with resource limits) ──────────────────
      const maxBodyProxy = MAX_REQUEST_BODY_BYTES();
      const ollamaTimeoutProxy = OLLAMA_TIMEOUT_MS();
      const isTagsProxyRequest = req.method === 'GET' && pathname === '/api/tags';
      const isPullProxyRequest = req.method === 'POST' && pathname === '/api/pull';
      const proxyTimeoutMs = isTagsProxyRequest ? 5000 : ollamaTimeoutProxy;
      const proxyUnavailableMessage =
        isTagsProxyRequest || isPullProxyRequest ? "Couldn't connect to Ollama" : 'Ollama service unavailable';

      // Early Content-Length check for methods with a body
      const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method);
      if (hasBody) {
        const declaredLen = parseInt(req.headers['content-length']);
        if (declaredLen > maxBodyProxy) {
          console.log(
            `[api-gateway] ${clientIp} - 413 ${req.method} ${req.url} (body ${declaredLen} > limit ${maxBodyProxy})`
          );
          recordActivity({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.url,
            status: 413,
            ip: clientIp,
            duration_ms: Date.now() - reqStart,
            auth_type: keyType,
          });
          sendError(
            res,
            413,
            'payload_too_large',
            `Request body of ${declaredLen} bytes exceeds ${maxBodyProxy} byte limit`
          );
          req.resume();
          return;
        }
      }

      const proxyHeaders = { ...req.headers };
      delete proxyHeaders['x-api-key'];

      const proxyOpts = {
        hostname: OLLAMA_PARSED.hostname,
        port: parseInt(OLLAMA_PARSED.port) || 11435,
        path: req.url,
        method: req.method,
        headers: proxyHeaders,
        timeout: isPullProxyRequest ? 0 : proxyTimeoutMs,
      };
      const nativeInference =
        req.method === 'POST' &&
        (pathname === '/api/chat' || pathname === '/api/generate' || pathname === '/api/embed');
      const nativeTracking = nativeInference ? stats.startRequest(crypto.randomUUID(), 'unknown') : null;

      acquireSlot()
        .then(() => {
          let slotReleased = false;
          function releaseOnce() {
            if (!slotReleased) {
              slotReleased = true;
              releaseSlot();
            }
          }

          const proxyReq = http.request(proxyOpts, (proxyRes) => {
            let streamBuffer = '';
            let completed = false;
            let sawFirstToken = false;
            let sawToolCalls = false;
            function maybeFailNative(err) {
              if (nativeTracking && !completed) {
                completed = true;
                stats.failRequest(nativeTracking, err).catch(function () {});
              }
            }

            if (nativeTracking) {
              proxyRes.on('data', (chunk) => {
                const text = chunk.toString();
                if (!sawFirstToken && text.length > 0) {
                  sawFirstToken = true;
                  stats.onFirstToken(nativeTracking);
                }

                if (pathname === '/api/chat' || pathname === '/api/generate') {
                  streamBuffer += text;
                  const lines = streamBuffer.split('\n');
                  streamBuffer = lines.pop();
                  lines.forEach(function (line) {
                    if (!line.trim()) return;
                    try {
                      const obj = JSON.parse(line);
                      if (obj.model && nativeTracking.model === 'unknown') nativeTracking.model = obj.model;
                      if (obj.message && hasToolCallsInMessage(obj.message)) sawToolCalls = true;
                      if (obj.done) {
                        completed = true;
                        stats
                          .completeRequest(nativeTracking, {
                            prompt_eval_count: obj.prompt_eval_count || 0,
                            eval_count: obj.eval_count || 0,
                            isToolCall: sawToolCalls,
                          })
                          .catch(function () {});
                      }
                    } catch (_) {
                      /* ignore partial/incompatible chunks */
                    }
                  });
                } else if (pathname === '/api/embed') {
                  try {
                    const obj = JSON.parse(text);
                    if (obj.model && nativeTracking.model === 'unknown') nativeTracking.model = obj.model;
                    completed = true;
                    stats
                      .completeRequest(nativeTracking, {
                        prompt_eval_count: 0,
                        eval_count: 0,
                        isToolCall: false,
                      })
                      .catch(function () {});
                  } catch (_) {
                    /* ignore */
                  }
                }
              });
            }

            console.log(`[api-gateway] ${clientIp} - ${proxyRes.statusCode} ${req.method} ${req.url} (${keyType})`);
            if (nativeTracking && proxyRes.statusCode >= 400) {
              maybeFailNative(new Error('Ollama HTTP ' + proxyRes.statusCode));
            }
            if (isPullProxyRequest) {
              proxyReq.setTimeout(0);
            }
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: proxyRes.statusCode,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });

            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res, { end: true });

            proxyRes.on('end', () => {
              if (nativeTracking && !completed && proxyRes.statusCode < 400) {
                stats
                  .completeRequest(nativeTracking, {
                    prompt_eval_count: 0,
                    eval_count: 0,
                    isToolCall: sawToolCalls,
                  })
                  .catch(function () {});
              }
              releaseOnce();
            });
            proxyRes.on('error', () => {
              if (nativeTracking && !completed) {
                stats.failRequest(nativeTracking, new Error('Proxy response stream error')).catch(function () {});
              }
              releaseOnce();
            });
          });

          proxyReq.on('timeout', () => {
            proxyReq.destroy();
            releaseOnce();
            if (nativeTracking)
              stats.failRequest(nativeTracking, new Error('Native Ollama timeout')).catch(function () {});
            console.log(`[api-gateway] ${clientIp} - 504 ${req.method} ${req.url} (timeout ${proxyOpts.timeout}ms)`);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 504,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            if (isTagsProxyRequest || isPullProxyRequest) {
              sendError(res, 502, 'model_error', proxyUnavailableMessage);
            } else {
              sendError(res, 504, 'request_timeout', `Ollama did not respond within ${proxyOpts.timeout}ms`);
            }
          });

          proxyReq.on('error', (err) => {
            releaseOnce();
            if (nativeTracking) stats.failRequest(nativeTracking, err).catch(function () {});
            console.error(`[api-gateway] Proxy error for ${req.method} ${req.url}:`, err.message);
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 502,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 502, 'model_error', proxyUnavailableMessage);
          });

          res.on('close', releaseOnce);
          req.pipe(proxyReq, { end: true });
        })
        .catch((err) => {
          if (err.message === 'queue_full') {
            if (nativeTracking) stats.failRequest(nativeTracking, err).catch(function () {});
            console.log(
              `[api-gateway] ${clientIp} - 429 ${req.method} ${req.url} (queue full: ${requestQueue.length})`
            );
            recordActivity({
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: 429,
              ip: clientIp,
              duration_ms: Date.now() - reqStart,
              auth_type: keyType,
            });
            sendError(res, 429, 'queue_full', `Server busy. ${MAX_QUEUE_SIZE()} requests already queued.`, {
              retry_after: 5,
            });
            req.resume();
          }
        });
    } catch (err) {
      console.error('[api-gateway] Unhandled error in request handler:', err);
      if (!res.headersSent) {
        sendError(res, 500, 'internal_error', 'Internal server error');
      }
    }
  };
}

const requestHandler = createRequestHandler();

let server;
if (useTls) {
  const tlsOpts = {
    cert: fs.readFileSync(TLS_CERT_PATH),
    key: fs.readFileSync(TLS_KEY_PATH),
  };
  if (TLS_PASSPHRASE) tlsOpts.passphrase = TLS_PASSPHRASE;
  server = https.createServer(tlsOpts, requestHandler);
} else {
  server = http.createServer(requestHandler);
}

// Error handling
server.on('error', (err) => {
  console.error(`[api-gateway] Server error: ${err.message}`);
  process.exit(1);
});

// Track active connections for graceful shutdown logging
const activeConnections = new Set();
server.on('connection', (socket) => {
  activeConnections.add(socket);
  socket.on('close', () => activeConnections.delete(socket));
});

// ── Background Tasks (SQLite maintenance) ────────────────────

// Roll up hourly stats every 5 minutes
setInterval(
  () => {
    try {
      db.rollupHourlyStats();
    } catch (err) {
      console.error('[api-gateway] Stats rollup error:', err.message);
    }
  },
  5 * 60 * 1000
);

// Prune old logs every hour
setInterval(
  () => {
    try {
      db.pruneOldLogs();
    } catch (err) {
      console.error('[api-gateway] Log pruning error:', err.message);
    }
  },
  60 * 60 * 1000
);

// Prune high-cardinality per-request stats every hour (7-day retention).
setInterval(
  () => {
    stats.pruneOldRequestStats(7).catch(function (err) {
      console.error('[api-gateway] Stats pruning error:', err.message);
    });
  },
  60 * 60 * 1000
);

// Graceful shutdown with connection draining
function killChildProcesses() {
  if (OLLAMA_PID) {
    try {
      process.kill(OLLAMA_PID, 'SIGTERM');
    } catch (_e) {
      /* intentionally empty */
    }
  }
  if (HEALTH_PID) {
    try {
      process.kill(HEALTH_PID, 'SIGTERM');
    } catch (_e) {
      /* intentionally empty */
    }
  }
}

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[api-gateway] Received ${signal}, shutting down... draining ${activeConnections.size} connections`);

  server.close(() => {
    console.log('[api-gateway] Shutdown complete');
    if (meshConnector) {
      meshConnector.stop().catch(() => {});
    }
    tokenManager.shutdown();
    db.close();
    killChildProcesses();
    process.exit(0);
  });

  server.closeIdleConnections();

  setTimeout(() => {
    console.log(`[api-gateway] Shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms) — forcing exit`);
    db.close();
    server.closeAllConnections();
    killChildProcesses();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
async function startServer() {
  await db.init();

  const dbKey = db.getSetting('api_key_override');
  if (dbKey) {
    currentApiKey = dbKey;
    console.log('[api-gateway] Using rotated API key from database');
  }

  tokenManager.init(db);

  detectedGpuCount = await detectGpuCount();
  const concurrencyStats = getConcurrencyStats();
  console.log(
    `[api-gateway] Concurrency config: maxConcurrent=${concurrencyStats.maxConcurrentRequests}, gpuCount=${concurrencyStats.gpuCount}, queueSize=${MAX_QUEUE_SIZE()}`
  );

  initMeshConnectivity();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[api-gateway] Listening on 0.0.0.0:${PORT} (${protocol})`);
    console.log(`[api-gateway] Rate limit: ${RATE_LIMIT()}/min per IP (burst: ${RATE_LIMIT_BURST()})`);
  });
}

startServer().catch((err) => {
  console.error('[api-gateway] Failed to start server:', err.message);
  process.exit(1);
});

/**
 * Admin Routes for JimboMesh Holler Server
 * Serves the admin SPA and provides admin API endpoints.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const Busboy = require('busboy');
const pipeline = require('./document-pipeline');
const qdrant = require('./qdrant-client');
const pkg = require('./package.json');
const stats = require('./stats-collector');

// Blocked settings keys — security-critical values that must not be writable via the API
const BLOCKED_SETTING_KEYS = [
  'api_key_override', 'admin_api_key', 'enhanced_security_enabled',
  'mesh_api_key',
];
const BLOCKED_SETTING_PATTERNS = [/secret/i, /password/i, /token/i, /private.?key/i];

function isBlockedSettingKey(key) {
  if (BLOCKED_SETTING_KEYS.includes(key)) return true;
  return BLOCKED_SETTING_PATTERNS.some((re) => re.test(key));
}

// Constant-time key comparison to prevent timing attacks
function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const ADMIN_DIR = path.join(__dirname, 'admin');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── Helpers ─────────────────────────────────────────────────────

function ollamaFetch(ollamaUrl, method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(ollamaUrl);
    const opts = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || 11435,
      path: reqPath,
      method,
      headers: {},
    };
    if (body) opts.headers['Content-Type'] = 'application/json';

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const MAX_ADMIN_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_ADMIN_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve(null); }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Static File Server ──────────────────────────────────────────

function serveStatic(pathname, res) {
  if (pathname === '/admin' || pathname === '/admin/') {
    pathname = '/admin/index.html';
  }

  const relative = pathname.slice('/admin'.length) || '/index.html';
  const full = path.resolve(ADMIN_DIR, '.' + relative);

  // Path traversal protection
  if (!full.startsWith(ADMIN_DIR)) {
    json(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const content = fs.readFileSync(full);
    const ext = path.extname(full);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(content);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

// ── Route Handlers ──────────────────────────────────────────────

async function handleStatus(ollamaUrl, startTime, getActivity, res, db) {
  try {
    const latencyStart = Date.now();
    const [models, running] = await Promise.all([
      ollamaFetch(ollamaUrl, 'GET', '/api/tags'),
      ollamaFetch(ollamaUrl, 'GET', '/api/ps'),
    ]);
    const latencyMs = Date.now() - latencyStart;

    const result = {
      healthy: models.status === 200,
      ollama_latency_ms: latencyMs,
      model_count: models.data?.models?.length || 0,
      running_models: running.data?.models?.length || 0,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      recent_requests: db ? db.getRequestCount() : getActivity().length,
    };

    if (db) {
      result.total_requests = db.getRequestCount();
      result.db_size_bytes = db.getDbSize();
    }

    json(res, 200, result);
  } catch (err) {
    const result = {
      healthy: false,
      ollama_latency_ms: -1,
      model_count: 0,
      running_models: 0,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      recent_requests: db ? db.getRequestCount() : getActivity().length,
      error: err.message,
    };

    if (db) {
      result.total_requests = db.getRequestCount();
      result.db_size_bytes = db.getDbSize();
    }

    json(res, 200, result);
  }
}

async function handleModels(ollamaUrl, res, sendError) {
  try {
    const result = await ollamaFetch(ollamaUrl, 'GET', '/api/tags');
    json(res, result.status, result.data);
  } catch (err) {
    sendError(res, 502, 'model_error', `Failed to fetch models: ${err.message}`);
  }
}

function handlePull(ollamaUrl, req, res, sendError) {
  readBody(req).then((body) => {
    if (!body || !body.name) {
      sendError(res, 400, 'invalid_request', 'Missing required field: name');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const parsed = new URL(ollamaUrl);
    const proxyReq = http.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port) || 11435,
        path: '/api/pull',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (proxyRes) => {
        let buffer = '';
        proxyRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (line.trim()) res.write(`data: ${line}\n\n`);
          }
        });
        proxyRes.on('end', () => {
          if (buffer.trim()) res.write(`data: ${buffer}\n\n`);
          res.write('data: {"done":true}\n\n');
          res.end();
        });
      }
    );

    proxyReq.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });

    proxyReq.write(JSON.stringify({ name: body.name, stream: true }));
    proxyReq.end();
  });
}

async function handleDelete(ollamaUrl, name, res, sendError) {
  try {
    const parsed = new URL(ollamaUrl);
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parseInt(parsed.port) || 11435,
          path: '/api/delete',
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        },
        (proxyRes) => {
          let data = '';
          proxyRes.on('data', (chunk) => (data += chunk));
          proxyRes.on('end', () => resolve({ status: proxyRes.statusCode, data }));
        }
      );
      req.on('error', reject);
      req.write(JSON.stringify({ name }));
      req.end();
    });

    if (result.status === 200) {
      json(res, 200, { success: true, message: `Model ${name} deleted` });
    } else if (result.status === 404) {
      sendError(res, 404, 'model_not_found', `Model ${name} not found`);
    } else {
      sendError(res, 502, 'model_error', `Failed to delete model: ${result.data}`);
    }
  } catch (err) {
    sendError(res, 502, 'model_error', `Failed to delete model: ${err.message}`);
  }
}

async function handleShow(ollamaUrl, req, res, sendError) {
  const body = await readBody(req);
  if (!body || !body.name) {
    sendError(res, 400, 'invalid_request', 'Missing required field: name');
    return;
  }
  try {
    const result = await ollamaFetch(ollamaUrl, 'POST', '/api/show', body);
    json(res, result.status, result.data);
  } catch (err) {
    sendError(res, 502, 'model_error', `Failed to get model info: ${err.message}`);
  }
}

async function handleRunning(ollamaUrl, res, sendError) {
  try {
    const result = await ollamaFetch(ollamaUrl, 'GET', '/api/ps');
    json(res, result.status, result.data);
  } catch (err) {
    sendError(res, 502, 'model_error', `Failed to fetch running models: ${err.message}`);
  }
}

function handleConfig(res, db) {
  json(res, 200, {
    server: {
      gateway_port: process.env.GATEWAY_PORT || '1920',
      ollama_internal_port: process.env.OLLAMA_INTERNAL_PORT || '11435',
      rate_limit_per_min: process.env.RATE_LIMIT_PER_MIN || '60',
      admin_enabled: process.env.ADMIN_ENABLED || 'true',
    },
    ollama: {
      models: process.env.HOLLER_MODELS || 'nomic-embed-text,llama3.1:8b',
      embed_model: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
      embed_dimensions: process.env.EMBED_DIMENSIONS || '768',
      num_parallel: process.env.OLLAMA_NUM_PARALLEL || '4',
      max_loaded_models: process.env.OLLAMA_MAX_LOADED_MODELS || '2',
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || '5m',
    },
    health: {
      health_port: process.env.HEALTH_PORT || '9090',
      health_warmup: process.env.HEALTH_WARMUP || 'false',
    },
    security: {
      api_key_set: !!process.env.JIMBOMESH_HOLLER_API_KEY,
      admin_api_key_set: !!process.env.ADMIN_API_KEY,
      qdrant_api_key_set: !!process.env.QDRANT_API_KEY,
    },
    branding: {
      server_name: (db && db.getSetting('server_name')) || process.env.HOLLER_SERVER_NAME || 'Holler Server',
      admin_title: process.env.HOLLER_ADMIN_TITLE || 'JimboMesh Holler Server \u2014 Admin',
    },
  });
}

function handleActivity(getActivity, req, res, db) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const limit = Math.min(parseInt(params.get('limit') || '200'), 1000);
  const offset = parseInt(params.get('offset') || '0');

  if (db) {
    const requests = db.getRecentRequests(limit, offset);
    const total = db.getRequestCount();
    json(res, 200, { requests, total, limit, offset });
  } else {
    json(res, 200, { requests: getActivity() });
  }
}

function handleSettings(req, res, db, onSettingsChanged) {
  if (!db) {
    json(res, 501, { error: 'SQLite not available' });
    return;
  }

  if (req.method === 'GET') {
    json(res, 200, { settings: db.getAllSettings() });
    return;
  }

  // POST — update a setting
  readBody(req).then((body) => {
    if (!body || !body.key || body.value === undefined) {
      json(res, 400, { error: 'Missing key or value' });
      return;
    }
    if (isBlockedSettingKey(body.key)) {
      json(res, 403, { error: 'This setting cannot be modified via the API' });
      return;
    }
    db.setSetting(body.key, body.value);
    if (onSettingsChanged) onSettingsChanged();
    json(res, 200, { success: true, key: body.key, value: String(body.value) });
  });
}

function handleSettingsBatch(req, res, db, onSettingsChanged) {
  if (!db) {
    json(res, 501, { error: 'SQLite not available' });
    return;
  }

  readBody(req).then((body) => {
    if (!body || !Array.isArray(body.settings)) {
      json(res, 400, { error: 'Missing settings array' });
      return;
    }
    const saved = [];
    for (const { key, value } of body.settings) {
      if (!key || value === undefined) continue;
      if (isBlockedSettingKey(key)) continue;
      db.setSetting(key, value);
      saved.push({ key, value: String(value) });
    }
    if (onSettingsChanged) onSettingsChanged();
    json(res, 200, { success: true, saved });
  });
}

function parseSince(req) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const raw = params.get('since');
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function handleStats(req, res, db) {
  if (!db) {
    json(res, 501, { error: 'SQLite not available' });
    return;
  }
  const since = parseSince(req);
  Promise.all([
    stats.getGlobalSummary(since),
    stats.getModelStats(since),
  ]).then(function (result) {
    json(res, 200, {
      global: result[0],
      models: result[1],
      // Legacy compatibility for Dashboard tab while it migrates.
      summary: db.getStatsSummary(),
    });
  }).catch(function (err) {
    json(res, 500, { error: err.message });
  });
}

function handleStatsModel(req, res, model) {
  const since = parseSince(req);
  Promise.all([
    stats.getModelDetail(model, since),
    stats.getHourlyStats(model),
  ]).then(function (result) {
    json(res, 200, { model: model, stats: result[0], hourly: result[1] });
  }).catch(function (err) {
    json(res, 500, { error: err.message });
  });
}

function handleStatsRequests(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const model = params.get('model') || null;
  const limit = parseInt(params.get('limit') || '50', 10);
  stats.getRecentRequests(model, limit).then(function (requests) {
    json(res, 200, { requests: requests });
  }).catch(function (err) {
    json(res, 500, { error: err.message });
  });
}

function handleStatsHourly(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const model = params.get('model') || null;
  stats.getHourlyStats(model).then(function (hourly) {
    json(res, 200, { hourly: hourly });
  }).catch(function (err) {
    json(res, 500, { error: err.message });
  });
}

function handleStatsReset(req, res) {
  readBody(req).then(function (body) {
    const model = body && body.model ? String(body.model) : null;
    stats.resetStats(model).then(function (result) {
      json(res, 200, result);
    }).catch(function (err) {
      json(res, 500, { error: err.message });
    });
  });
}

function handleStatsPricing(req, res) {
  if (req.method === 'GET') {
    stats.getModelPricing().then(function (pricing) {
      json(res, 200, { pricing: pricing });
    }).catch(function (err) {
      json(res, 500, { error: err.message });
    });
    return;
  }

  readBody(req).then(function (body) {
    if (!body || !body.model || body.input_per_1k == null) {
      json(res, 400, { error: 'Missing model or input_per_1k' });
      return;
    }
    const model = String(body.model);
    const inputPer1k = parseFloat(body.input_per_1k);
    const outputPer1k = body.output_per_1k == null ? null : parseFloat(body.output_per_1k);
    if (!Number.isFinite(inputPer1k) || (outputPer1k != null && !Number.isFinite(outputPer1k))) {
      json(res, 400, { error: 'Invalid pricing values' });
      return;
    }
    stats.setModelPricing(model, inputPer1k, outputPer1k).then(function (saved) {
      json(res, 200, { pricing: saved });
    }).catch(function (err) {
      json(res, 500, { error: err.message });
    });
  });
}

// ── Marketplace Cache ───────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (general)
const GPU_CACHE_TTL_MS = 30 * 1000; // 30 seconds (gpu-info depends on running models)
const SYSTEM_CACHE_TTL_MS = 60 * 1000; // 60 seconds (system info can be expensive)
const _cache = {};

function cached(key, fn) {
  const entry = _cache[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  const data = fn();
  _cache[key] = { data, ts: Date.now() };
  return data;
}

async function cachedAsync(key, fn, ttl) {
  const entry = _cache[key];
  if (entry && Date.now() - entry.ts < (ttl || CACHE_TTL_MS)) return entry.data;
  const data = await fn();
  _cache[key] = { data, ts: Date.now() };
  return data;
}

// ── GPU Info ────────────────────────────────────────────────────

function detectConfiguredMode() {
  const externalUrl = process.env.OLLAMA_EXTERNAL_URL || '';
  if (externalUrl.includes('host.docker.internal')) return 'metal';

  const composeFile = process.env.COMPOSE_FILE || '';
  if (composeFile.includes('docker-compose.gpu.yml')) return 'nvidia';

  if (process.platform === 'darwin') return 'metal-native';

  return 'cpu';
}

function detectNvidiaGpu() {
  try {
    const out = execSync('nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader,nounits', { timeout: 5000, encoding: 'utf8' });
    const parts = out.trim().split(',').map(s => s.trim());
    if (parts.length >= 4) {
      return {
        name: parts[0],
        type: 'nvidia',
        vram_total_mb: parseInt(parts[1]) || 0,
        vram_used_mb: parseInt(parts[2]) || 0,
        vram_free_mb: parseInt(parts[3]) || 0,
      };
    }
  } catch { /* nvidia-smi not available */ }
  return null;
}

async function detectGpuInfo(ollamaUrl) {
  return cachedAsync('gpu-info', async () => {
    const mode = detectConfiguredMode();
    const system = { total_mb: Math.round(os.totalmem() / 1048576), free_mb: Math.round(os.freemem() / 1048576) };
    const result = { gpu: null, system, mode };

    const nvidiaGpu = detectNvidiaGpu();
    if (nvidiaGpu) {
      result.gpu = nvidiaGpu;
    }

    try {
      const ps = await ollamaFetch(ollamaUrl, 'GET', '/api/ps');
      const models = ps.data && ps.data.models ? ps.data.models : [];
      let totalSize = 0;
      let totalVram = 0;
      for (const m of models) {
        totalSize += m.size || 0;
        totalVram += m.size_vram || 0;
      }
      result.ollama_gpu = {
        running_models: models.length,
        total_size_bytes: totalSize,
        total_vram_bytes: totalVram,
        gpu_offload_pct: totalSize > 0 ? Math.round(totalVram / totalSize * 100) : 0,
      };
    } catch { /* Ollama not reachable */ }

    if (!result.gpu && (mode === 'metal' || mode === 'metal-native')) {
      const og = result.ollama_gpu;
      result.gpu = {
        name: 'Apple Silicon (Metal)',
        type: 'metal',
        vram_total_mb: system.total_mb,
        vram_used_mb: system.total_mb - system.free_mb,
        vram_free_mb: system.free_mb,
      };
      if (og && og.running_models > 0 && og.gpu_offload_pct > 0) {
        result.gpu.offload_pct = og.gpu_offload_pct;
      }
    }

    return result;
  }, GPU_CACHE_TTL_MS);
}

// ── System Info ──────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function getLinuxDistro() {
  try {
    const txt = fs.readFileSync('/etc/os-release', 'utf8');
    const pretty = (txt.match(/^PRETTY_NAME="?(.+?)"?$/m) || [])[1];
    if (pretty) return pretty;
    const name = (txt.match(/^NAME="?(.+?)"?$/m) || [])[1];
    const version = (txt.match(/^VERSION="?(.+?)"?$/m) || [])[1];
    if (name && version) return `${name} ${version}`;
    if (name) return name;
  } catch { /* ignore */ }
  return 'Linux';
}

function getPlatformLabel() {
  const platform = os.platform();
  if (platform === 'win32') {
    const release = os.release() || '';
    return `Windows ${release.startsWith('10.0.2') ? '11' : '10'}`;
  }
  if (platform === 'darwin') return `macOS ${os.release()}`;
  if (platform === 'linux') return getLinuxDistro();
  return platform;
}

function readFirstNonEmptyLine(cmd) {
  const out = execSync(cmd, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const line = out.split(/\r?\n/).map((v) => v.trim()).find(Boolean);
  return line || '';
}

function detectCpuTopology() {
  const cpus = os.cpus() || [];
  const cpuThreads = cpus.length || 1;
  let cpuCores = cpuThreads;

  try {
    if (process.platform === 'darwin') {
      cpuCores = toNumber(readFirstNonEmptyLine('sysctl -n hw.physicalcpu'), cpuCores);
      const logical = toNumber(readFirstNonEmptyLine('sysctl -n hw.logicalcpu'), cpuThreads);
      return { cpuCores: Math.max(1, cpuCores), cpuThreads: Math.max(cpuThreads, logical) };
    }

    if (process.platform === 'linux') {
      const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const physical = new Set();
      let currentPhysical = null;
      const lines = cpuInfo.split(/\r?\n/);
      for (const line of lines) {
        const phy = line.match(/^physical id\s*:\s*(\d+)/);
        if (phy) {
          currentPhysical = phy[1];
          continue;
        }
        const core = line.match(/^core id\s*:\s*(\d+)/);
        if (core && currentPhysical != null) {
          physical.add(`${currentPhysical}:${core[1]}`);
        }
      }
      if (physical.size > 0) cpuCores = physical.size;
    } else if (process.platform === 'win32') {
      const psCmd = 'powershell -NoProfile -Command "$c=(Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum; $l=(Get-CimInstance Win32_Processor | Measure-Object NumberOfLogicalProcessors -Sum).Sum; Write-Output \\"$c,$l\\""';
      const line = readFirstNonEmptyLine(psCmd);
      const parts = line.split(',').map((v) => toNumber(v.trim(), 0));
      if (parts[0] > 0) cpuCores = parts[0];
      if (parts[1] > 0) return { cpuCores: Math.max(1, cpuCores), cpuThreads: Math.max(cpuThreads, parts[1]) };
    }
  } catch { /* ignore */ }

  if (cpuCores > cpuThreads) cpuCores = cpuThreads;
  return { cpuCores: Math.max(1, cpuCores), cpuThreads: Math.max(1, cpuThreads) };
}

function readCpuTimes() {
  const cpus = os.cpus() || [];
  return cpus.map((cpu) => {
    const t = cpu.times || {};
    const idle = t.idle || 0;
    const total = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0) + idle;
    return { idle, total };
  });
}

async function sampleCpuUsagePercent() {
  const start = readCpuTimes();
  await sleep(1000);
  const end = readCpuTimes();
  if (!start.length || start.length !== end.length) return null;

  let totalDelta = 0;
  let idleDelta = 0;
  for (let i = 0; i < start.length; i += 1) {
    totalDelta += Math.max(0, end[i].total - start[i].total);
    idleDelta += Math.max(0, end[i].idle - start[i].idle);
  }
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

async function getSystemGpuInfo() {
  // 1) NVIDIA
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits',
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (out) {
      const firstLine = out.split(/\r?\n/)[0];
      const [name, driver, vramTotal, vramUsed, util, temp] = firstLine.split(',').map((s) => s.trim());
      const totalMb = toNumber(vramTotal, null);
      const usedMb = toNumber(vramUsed, null);
      return {
        name: name || 'NVIDIA GPU',
        driver: driver || null,
        vramTotalMb: totalMb,
        vramUsedMb: usedMb,
        vramUsagePercent: totalMb ? Math.round((usedMb || 0) / totalMb * 100) : null,
        utilizationPercent: toNumber(util, null),
        temperatureC: toNumber(temp, null),
      };
    }
  } catch { /* no nvidia-smi */ }

  // 2) Apple Silicon / Metal
  if (os.platform() === 'darwin' && os.arch() === 'arm64') {
    try {
      const spOutput = execSync('system_profiler SPDisplaysDataType -json', {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const displays = JSON.parse(spOutput).SPDisplaysDataType || [];
      const gpu = displays[0] || {};
      return {
        name: gpu.sppci_model || 'Apple Silicon GPU',
        driver: 'Metal',
        vramTotalMb: null,
        vramUsedMb: null,
        vramUsagePercent: null,
        utilizationPercent: null,
        temperatureC: null,
        unifiedMemory: true,
      };
    } catch { /* ignore */ }
  }

  // 3) AMD ROCm
  try {
    const out = execSync('rocm-smi --showproductname --showmeminfo vram --showuse --showtemp --csv', {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.split(/\r?\n/).filter(Boolean);
    if (lines.length >= 2) {
      const dataLine = lines[1];
      const cols = dataLine.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      return {
        name: cols[1] || 'AMD GPU',
        driver: 'ROCm',
        vramTotalMb: toNumber(cols.find((v) => /total/i.test(v)), null),
        vramUsedMb: toNumber(cols.find((v) => /used/i.test(v)), null),
        vramUsagePercent: null,
        utilizationPercent: toNumber(cols.find((v) => /gpu use/i.test(v)), null),
        temperatureC: toNumber(cols.find((v) => /temp/i.test(v)), null),
      };
    }
  } catch { /* no rocm-smi */ }

  return null;
}

function isDockerEnv() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch { /* ignore */ }
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return cgroup.includes('docker') || cgroup.includes('containerd') || cgroup.includes('kubepods');
  } catch { /* ignore */ }
  return false;
}

function parseContainerId() {
  try {
    const txt = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const match64 = txt.match(/[a-f0-9]{64}/);
    if (match64) return match64[0].slice(0, 12);
    const match12 = txt.match(/[a-f0-9]{12,}/);
    if (match12) return match12[0].slice(0, 12);
  } catch { /* ignore */ }
  return null;
}

function getDirectorySizeGb(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return null;
  try {
    const out = execSync(`du -sk "${targetPath.replace(/"/g, '\\"')}"`, {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const kb = toNumber(out.split(/\s+/)[0], null);
    if (kb == null) return null;
    return round1(kb / (1024 * 1024));
  } catch { /* fallback below */ }

  // Fallback recursion (used rarely where du is unavailable)
  let total = 0;
  const stack = [targetPath];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try { stat = fs.statSync(current); } catch { continue; }
    if (stat.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(current); } catch { entries = []; }
      for (const e of entries) stack.push(path.join(current, e));
    } else if (stat.isFile()) {
      total += stat.size;
    }
  }
  return round1(total / (1024 * 1024 * 1024));
}

function resolveEnvExpr(text) {
  return String(text).replace(/\$\{([^}:]+)(:-([^}]*))?\}/g, function (_, key, _x, def) {
    return process.env[key] != null && process.env[key] !== '' ? process.env[key] : (def || '');
  });
}

function parsePortMapping(mapping) {
  const clean = resolveEnvExpr(String(mapping || '').trim()).replace(/^['"]|['"]$/g, '');
  if (!clean) return null;
  const protoSplit = clean.split('/');
  const raw = protoSplit[0];
  const protocol = protoSplit[1] || 'tcp';
  const parts = raw.split(':');
  let binding = '0.0.0.0';
  let hostPort = null;
  let containerPort = null;

  if (parts.length === 3) {
    binding = parts[0];
    hostPort = toNumber(parts[1], null);
    containerPort = toNumber(parts[2], null);
  } else if (parts.length === 2) {
    hostPort = toNumber(parts[0], null);
    containerPort = toNumber(parts[1], null);
  } else if (parts.length === 1) {
    containerPort = toNumber(parts[0], null);
  }

  return { binding, hostPort, containerPort, protocol };
}

function composeFilesFromEnv() {
  const list = [path.join(__dirname, 'docker-compose.yml')];
  const raw = process.env.COMPOSE_FILE || '';
  if (!raw) return list;
  const sep = raw.includes(';') ? ';' : ':';
  const items = raw.split(sep).map((v) => v.trim()).filter(Boolean);
  for (const item of items) {
    const full = path.isAbsolute(item) ? item : path.join(__dirname, item);
    if (!list.includes(full)) list.push(full);
  }
  return list;
}

function parseComposeInfo() {
  const files = composeFilesFromEnv();
  const servicePorts = [];
  let composeProject = process.env.COMPOSE_PROJECT_NAME || null;

  for (const composeFile of files) {
    let content = '';
    try { content = fs.readFileSync(composeFile, 'utf8'); } catch { continue; }
    const lines = content.split(/\r?\n/);
    let inServices = false;
    let currentService = null;
    let inPorts = false;

    for (const rawLine of lines) {
      const line = rawLine.replace(/\t/g, '    ');
      if (!composeProject) {
        const nameMatch = line.match(/^name:\s*([^\s#]+)/);
        if (nameMatch) composeProject = nameMatch[1].trim();
      }

      if (/^services:\s*$/.test(line)) {
        inServices = true;
        currentService = null;
        inPorts = false;
        continue;
      }

      if (!inServices) continue;
      const svcMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
      if (svcMatch) {
        currentService = svcMatch[1];
        inPorts = false;
        continue;
      }

      if (!currentService) continue;
      if (/^    ports:\s*$/.test(line)) {
        inPorts = true;
        continue;
      }
      if (inPorts && /^    [a-zA-Z0-9_-]+:/.test(line)) {
        inPorts = false;
      }
      if (!inPorts) continue;

      const portMatch = line.match(/^      -\s*(.+)\s*$/);
      if (!portMatch) continue;
      const parsed = parsePortMapping(portMatch[1]);
      if (!parsed) continue;
      servicePorts.push({ service: currentService, ...parsed });
    }
  }

  return {
    composeProject: composeProject || 'jimbomesh-holler',
    servicePorts,
  };
}

function pickPrimaryLocalIp(isDocker) {
  const ifaces = os.networkInterfaces() || {};
  let fallback = '127.0.0.1';

  for (const name of Object.keys(ifaces)) {
    const entries = ifaces[name] || [];
    for (const iface of entries) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (!fallback || fallback === '127.0.0.1') fallback = iface.address;
      if (isDocker && /^172\.(1[6-9]|2\d|3[0-1])\./.test(iface.address)) continue;
      return iface.address;
    }
  }
  return fallback;
}

function pickDockerIp() {
  const ifaces = os.networkInterfaces() || {};
  for (const name of Object.keys(ifaces)) {
    const entries = ifaces[name] || [];
    for (const iface of entries) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (name === 'eth0') return iface.address;
      if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(iface.address)) return iface.address;
    }
  }
  return null;
}

function exposureFromBinding(binding) {
  if (!binding || binding === '0.0.0.0' || binding === '::') {
    if (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_TUNNEL_URL || process.env.PUBLIC_ENDPOINT) return 'public';
    return 'lan';
  }
  if (binding === '127.0.0.1' || binding === '::1' || binding.toLowerCase() === 'localhost') return 'local-only';
  return 'lan';
}

function serviceLabel(name, containerPort) {
  if (name === 'jimbomesh-still' && containerPort === 1920) return 'API Gateway';
  if (name === 'jimbomesh-still' && containerPort === 9090) return 'Health Check';
  if (name === 'jimbomesh-qdrant' && containerPort === 6333) return 'Qdrant Vector DB';
  if (name === 'jimbomesh-qdrant' && containerPort === 6334) return 'Qdrant gRPC';
  return name;
}

function buildPorts(composeInfo) {
  const ports = [];
  const byServicePort = new Map();
  for (const p of composeInfo.servicePorts) {
    if (p.hostPort == null || p.containerPort == null) continue;
    byServicePort.set(`${p.service}:${p.containerPort}`, p);
  }

  function addPort(service, containerPort, fallbackHostPort) {
    const mapped = byServicePort.get(`${service}:${containerPort}`);
    const port = mapped && mapped.hostPort != null ? mapped.hostPort : fallbackHostPort;
    if (port == null) return;
    const binding = mapped ? mapped.binding : '127.0.0.1';
    ports.push({
      port,
      service: serviceLabel(service, containerPort),
      binding,
      exposure: exposureFromBinding(binding),
      protocol: process.env.TLS_CERT_PATH && containerPort === 1920 ? 'https' : 'http',
    });
  }

  addPort('jimbomesh-still', 1920, toNumber(process.env.GATEWAY_PORT || process.env.OLLAMA_HOST_PORT, 1920));
  addPort('jimbomesh-still', 9090, toNumber(process.env.HEALTH_HOST_PORT || process.env.HEALTH_PORT, 9090));
  addPort('jimbomesh-qdrant', 6333, toNumber(process.env.QDRANT_HOST_PORT, null));

  // Admin Portal is on the same gateway port.
  const gateway = ports.find((p) => p.service === 'API Gateway');
  if (gateway) {
    ports.push({
      port: gateway.port,
      service: 'Admin Portal',
      binding: gateway.binding,
      exposure: gateway.exposure,
      protocol: gateway.protocol,
    });
  }

  return ports.sort((a, b) => a.port - b.port);
}

function getDockerDetails(composeInfo) {
  if (!isDockerEnv()) return null;
  const volumes = [];
  const known = [
    { name: 'ollama_models', mountpoint: '/root/.ollama' },
    { name: 'holler_data', mountpoint: '/opt/jimbomesh-still/data' },
    { name: 'qdrant_storage', mountpoint: '/qdrant/storage' },
  ];
  for (const vol of known) {
    if (!fs.existsSync(vol.mountpoint)) continue;
    volumes.push({
      name: vol.name,
      mountpoint: vol.mountpoint,
      sizeGb: getDirectorySizeGb(vol.mountpoint),
    });
  }

  let created = null;
  try {
    const st = fs.statSync('/.dockerenv');
    created = st.birthtime ? st.birthtime.toISOString() : null;
  } catch { /* ignore */ }

  return {
    containerId: parseContainerId(),
    imageName: process.env.DOCKER_IMAGE || 'jimbomesh-still:latest',
    imageId: process.env.DOCKER_IMAGE_ID || null,
    created,
    composeProject: composeInfo.composeProject,
    volumes,
  };
}

function getSecurityChecks(systemInfo) {
  const checks = [];
  const ports = systemInfo.ports || [];

  const key = process.env.JIMBOMESH_HOLLER_API_KEY || '';
  const defaultLike = /generate_with|changeme|replace_me|example/i.test(key);
  checks.push({
    name: 'API Authentication',
    status: key && !defaultLike ? 'pass' : 'fail',
    detail: key && !defaultLike ? 'API key required' : 'API key missing or placeholder',
  });

  const adminPort = ports.find((p) => p.service === 'Admin Portal');
  const adminPass = !adminPort || adminPort.binding === '127.0.0.1' || !!(process.env.ADMIN_API_KEY || process.env.JIMBOMESH_HOLLER_API_KEY);
  checks.push({
    name: 'Admin Portal Binding',
    status: adminPass ? 'pass' : 'warn',
    detail: adminPort ? `Bound to ${adminPort.binding}` : 'Admin route shares API gateway auth',
  });

  const ollamaExposure = ports.find((p) => p.port === 1920);
  const ollamaPass = !ollamaExposure || ollamaExposure.exposure === 'local-only';
  checks.push({
    name: 'Ollama Binding',
    status: ollamaPass ? 'pass' : 'warn',
    detail: ollamaExposure ? `Bound to ${ollamaExposure.binding}` : 'Not exposed via host mapping',
  });

  const httpsOn = !!process.env.TLS_CERT_PATH && !!process.env.TLS_KEY_PATH;
  checks.push({
    name: 'HTTPS',
    status: httpsOn ? 'pass' : 'warn',
    detail: httpsOn ? 'TLS configured' : 'No TLS configured (OK for local)',
  });

  let nonRootPass = true;
  let nonRootDetail = 'Running as non-root';
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    const uid = process.getuid();
    nonRootPass = uid !== 0;
    nonRootDetail = nonRootPass ? 'Running as non-root user' : 'Running as root user';
  }
  checks.push({
    name: 'Non-Root User',
    status: nonRootPass ? 'pass' : 'warn',
    detail: nonRootDetail,
  });

  let baseImagePinned = false;
  let baseImageDetail = 'Dockerfile not found';
  try {
    const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
    const from = (dockerfile.match(/^FROM\s+([^\s]+)\s*$/m) || [])[1] || '';
    baseImagePinned = !!from && !/:latest$/i.test(from);
    baseImageDetail = from ? from : 'Unknown base image';
  } catch { /* ignore */ }
  checks.push({
    name: 'Docker Image Pinned',
    status: baseImagePinned ? 'pass' : 'warn',
    detail: baseImageDetail,
  });

  checks.push({
    name: 'Security Headers',
    status: 'pass',
    detail: 'X-Frame-Options, CSP, and nosniff headers present',
  });

  const exposed = ports.filter((p) => p.exposure !== 'local-only');
  checks.push({
    name: 'Public Ports',
    status: exposed.length === 0 ? 'pass' : 'warn',
    detail: exposed.length === 0 ? 'No LAN/public host bindings detected' : exposed.map((p) => `${p.port} (${p.exposure})`).join(', '),
  });

  const qdrantEnabled = !!process.env.QDRANT_URL || ports.some((p) => p.service.indexOf('Qdrant') !== -1);
  const qdrantAuth = !qdrantEnabled || !!process.env.QDRANT_API_KEY;
  checks.push({
    name: 'Qdrant Auth',
    status: qdrantAuth ? 'pass' : 'warn',
    detail: qdrantEnabled ? (qdrantAuth ? 'API key configured' : 'Qdrant enabled but API key missing') : 'Qdrant not enabled',
  });

  checks.push({
    name: 'File Upload Restriction',
    status: 'pass',
    detail: 'Allowlisted extensions only',
  });

  const bodyLimit = toNumber(process.env.MAX_REQUEST_BODY_BYTES, 1048576);
  checks.push({
    name: 'Body Size Limit',
    status: bodyLimit > 0 ? 'pass' : 'warn',
    detail: bodyLimit > 0 ? `${bodyLimit} byte limit enforced` : 'No body size limit configured',
  });

  const scoringChecks = new Set([
    'API Authentication',
    'Admin Portal Binding',
    'Ollama Binding',
    'Non-Root User',
    'Docker Image Pinned',
    'Security Headers',
    'Public Ports',
    'Qdrant Auth',
    'File Upload Restriction',
    'Body Size Limit',
  ]);
  const score = checks.filter((c) => scoringChecks.has(c.name) && c.status === 'pass').length;
  let rating = 'Critical';
  if (score >= 10) rating = 'Excellent';
  else if (score >= 8) rating = 'Good';
  else if (score >= 6) rating = 'Fair';
  else if (score >= 4) rating = 'Poor';

  return { score, rating, checks };
}

async function collectSystemBase() {
  const cpus = os.cpus() || [];
  const cpuModel = cpus[0] && cpus[0].model ? cpus[0].model : 'Unknown';
  const cpuTopo = detectCpuTopology();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpuUsagePercent = await sampleCpuUsagePercent();
  const gpu = await getSystemGpuInfo();
  const docker = getDockerDetails(parseComposeInfo());
  const isDocker = !!docker;

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    platformLabel: getPlatformLabel(),
    arch: os.arch(),
    hardware: {
      cpu: cpuModel,
      cpuCores: cpuTopo.cpuCores,
      cpuThreads: cpuTopo.cpuThreads,
      cpuUsagePercent,
      memoryTotalGb: round1(totalMem / (1024 * 1024 * 1024)),
      memoryUsedGb: round1(usedMem / (1024 * 1024 * 1024)),
      memoryUsagePercent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : null,
      gpu,
    },
    network: {
      localIp: pickPrimaryLocalIp(isDocker),
      dockerIp: isDocker ? pickDockerIp() : null,
      isDocker,
      hostname: isDocker ? os.hostname() : null,
    },
    docker,
  };
}

async function getSystemInfoPayload() {
  const base = await cachedAsync('system-base', collectSystemBase, SYSTEM_CACHE_TTL_MS);
  const composeInfo = parseComposeInfo();
  const ports = buildPorts(composeInfo);

  const payload = {
    hostname: base.hostname,
    platform: base.platform,
    platformLabel: base.platformLabel,
    arch: base.arch,
    uptime: Math.floor(os.uptime()),
    hollerVersion: pkg.version,
    hardware: base.hardware,
    network: base.network,
    ports,
    security: { score: 0, rating: 'Critical', checks: [] },
    docker: base.network.isDocker ? {
      ...(base.docker || {}),
      composeProject: composeInfo.composeProject,
    } : null,
  };
  payload.security = getSecurityChecks(payload);
  return payload;
}

async function handleSystem(res, sendError) {
  try {
    const data = await getSystemInfoPayload();
    json(res, 200, data);
  } catch (err) {
    sendError(res, 500, 'system_info_error', `Failed to gather system info: ${err.message}`);
  }
}

// Warm the expensive system cache at startup.
getSystemInfoPayload().catch(() => {});

// ── Ollama Marketplace ──────────────────────────────────────────

async function handleMarketplaceOllama(ollamaUrl, res, sendError) {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(ADMIN_DIR, 'data', 'ollama-catalog.json'), 'utf8'));
    const installed = await ollamaFetch(ollamaUrl, 'GET', '/api/tags');
    const installedNames = new Set();
    if (installed.data && installed.data.models) {
      for (const m of installed.data.models) {
        installedNames.add(m.name);
        const base = m.name.split(':')[0];
        installedNames.add(base);
      }
    }
    const models = catalog.map(m => ({
      ...m,
      installed_tags: m.variants.filter(v => {
        const full = v.tag === 'latest' ? m.name : m.name + ':' + v.tag;
        return installedNames.has(full);
      }).map(v => v.tag),
    }));
    json(res, 200, { models, cached_at: new Date().toISOString() });
  } catch (err) {
    sendError(res, 500, 'marketplace_error', `Failed to load Ollama catalog: ${err.message}`);
  }
}

// ── HuggingFace Marketplace ─────────────────────────────────────

function hfFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'JimboMesh-Holler/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from HuggingFace')); }
      });
    }).on('error', reject);
  });
}

async function handleMarketplaceHuggingFace(req, res, sendError) {
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const search = params.get('search') || '';
    const task = params.get('task') || '';
    const sort = params.get('sort') || 'downloads';
    const limit = Math.min(parseInt(params.get('limit') || '24'), 100);

    const cacheKey = `hf:${search}:${task}:${sort}:${limit}`;
    const result = await cachedAsync(cacheKey, async () => {
      let url = `https://huggingface.co/api/models?filter=gguf&sort=${encodeURIComponent(sort)}&direction=-1&limit=${limit}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (task) url += `&pipeline_tag=${encodeURIComponent(task)}`;
      return await hfFetch(url);
    });

    json(res, 200, { models: result, cached_at: new Date().toISOString() });
  } catch (err) {
    sendError(res, 502, 'hf_error', `Failed to fetch from HuggingFace: ${err.message}`);
  }
}

// ── HuggingFace Model Detail (GGUF files) ───────────────────────

async function handleHfModelFiles(req, res, sendError) {
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const repoId = params.get('repo');
    if (!repoId) { sendError(res, 400, 'invalid_request', 'Missing repo parameter'); return; }

    const cacheKey = `hf-files:${repoId}`;
    const files = await cachedAsync(cacheKey, async () => {
      const siblings = await hfFetch(`https://huggingface.co/api/models/${encodeURIComponent(repoId)}`);
      if (!siblings || !siblings.siblings) return [];
      return siblings.siblings
        .filter(f => f.rfilename && f.rfilename.endsWith('.gguf'))
        .map(f => ({ filename: f.rfilename, size: f.size || 0 }));
    });

    json(res, 200, { files });
  } catch (err) {
    sendError(res, 502, 'hf_error', `Failed to fetch model files: ${err.message}`);
  }
}

// ── HuggingFace Import ──────────────────────────────────────────

function handleHfImport(ollamaUrl, req, res, sendError) {
  readBody(req).then((body) => {
    if (!body || !body.repo_id || !body.filename || !body.model_name) {
      sendError(res, 400, 'invalid_request', 'Missing required fields: repo_id, filename, model_name');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const tmpDir = path.join(os.tmpdir(), 'holler-imports');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* exists */ }

    const safeFilename = path.basename(body.filename);
    if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
      sendError(res, 400, 'invalid_request', 'Invalid filename');
      return;
    }
    const destPath = path.join(tmpDir, safeFilename);
    const fileUrl = `https://huggingface.co/${body.repo_id}/resolve/main/${encodeURIComponent(body.filename)}`;

    res.write(`data: ${JSON.stringify({ phase: 'download', status: 'Starting download...' })}\n\n`);

    // Download the GGUF file with redirect following
    function download(url, redirectCount) {
      if (redirectCount > 5) {
        res.write(`data: ${JSON.stringify({ error: 'Too many redirects' })}\n\n`);
        res.end();
        return;
      }

      const proto = url.startsWith('https') ? https : http;
      proto.get(url, { headers: { 'User-Agent': 'JimboMesh-Holler/1.0' } }, (dlRes) => {
        if (dlRes.statusCode >= 300 && dlRes.statusCode < 400 && dlRes.headers.location) {
          download(dlRes.headers.location, redirectCount + 1);
          return;
        }
        if (dlRes.statusCode !== 200) {
          res.write(`data: ${JSON.stringify({ error: `Download failed: HTTP ${dlRes.statusCode}` })}\n\n`);
          res.end();
          return;
        }

        const totalBytes = parseInt(dlRes.headers['content-length'] || '0');
        let downloaded = 0;
        const fileStream = fs.createWriteStream(destPath);
        let lastPct = -1;

        dlRes.on('data', (chunk) => {
          downloaded += chunk.length;
          fileStream.write(chunk);
          if (totalBytes > 0) {
            const pct = Math.round(downloaded / totalBytes * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              res.write(`data: ${JSON.stringify({ phase: 'download', status: `Downloading... ${pct}%`, completed: downloaded, total: totalBytes })}\n\n`);
            }
          }
        });

        dlRes.on('end', () => {
          fileStream.end();
          res.write(`data: ${JSON.stringify({ phase: 'download', status: 'Download complete', completed: downloaded, total: downloaded })}\n\n`);

          // Create Modelfile and register with Ollama
          const modelfile = `FROM ${destPath}`;
          res.write(`data: ${JSON.stringify({ phase: 'import', status: 'Registering model with Ollama...' })}\n\n`);

          const parsed = new URL(ollamaUrl);
          const createReq = http.request({
            hostname: parsed.hostname,
            port: parseInt(parsed.port) || 11435,
            path: '/api/create',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (createRes) => {
            let buffer = '';
            createRes.on('data', (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop();
              for (const line of lines) {
                if (line.trim()) {
                  try {
                    const parsed = JSON.parse(line);
                    res.write(`data: ${JSON.stringify({ phase: 'import', status: parsed.status || 'Processing...', done: parsed.status === 'success' })}\n\n`);
                  } catch {
                    res.write(`data: ${JSON.stringify({ phase: 'import', status: line })}\n\n`);
                  }
                }
              }
            });
            createRes.on('end', () => {
              if (buffer.trim()) {
                try {
                  const p = JSON.parse(buffer);
                  res.write(`data: ${JSON.stringify({ phase: 'import', status: p.status || 'Done', done: true })}\n\n`);
                } catch {
                  res.write(`data: ${JSON.stringify({ phase: 'import', status: buffer, done: true })}\n\n`);
                }
              }
              res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
              res.end();
              // Clean up temp file
              try { fs.unlinkSync(destPath); } catch { /* ignore */ }
            });
          });

          createReq.on('error', (err) => {
            res.write(`data: ${JSON.stringify({ error: `Ollama import failed: ${err.message}` })}\n\n`);
            res.end();
            try { fs.unlinkSync(destPath); } catch { /* ignore */ }
          });

          createReq.write(JSON.stringify({ name: body.model_name, modelfile, stream: true }));
          createReq.end();
        });

        dlRes.on('error', (err) => {
          fileStream.end();
          res.write(`data: ${JSON.stringify({ error: `Download error: ${err.message}` })}\n\n`);
          res.end();
          try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        });
      }).on('error', (err) => {
        res.write(`data: ${JSON.stringify({ error: `Connection error: ${err.message}` })}\n\n`);
        res.end();
      });
    }

    download(fileUrl, 0);
  });
}

// ── GitHub Issue Creation ────────────────────────────────────────

const GITHUB_REPO = 'IngressTechnology/jimbomesh-holler-server';

function handleGitHubIssue(req, res, sendError) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    sendError(res, 501, 'github_not_configured', 'GITHUB_TOKEN environment variable is not set');
    return;
  }

  readBody(req).then((body) => {
    if (!body || !body.title || !body.type) {
      sendError(res, 400, 'invalid_request', 'Missing required fields: title, type');
      return;
    }

    const isBug = body.type === 'bug';
    const labels = isBug ? ['bug'] : ['enhancement'];
    const sections = [];

    if (isBug) {
      sections.push('## Bug Report');
      if (body.description) sections.push('### Description\n' + body.description);
      if (body.steps) sections.push('### Steps to Reproduce\n' + body.steps);
      if (body.expected) sections.push('### Expected Behavior\n' + body.expected);
      if (body.actual) sections.push('### Actual Behavior\n' + body.actual);
    } else {
      sections.push('## Feature Request');
      if (body.description) sections.push('### Description\n' + body.description);
      if (body.useCase) sections.push('### Use Case\n' + body.useCase);
    }

    sections.push('---\n_Submitted from Admin UI_');

    const issueBody = sections.join('\n\n');

    const postData = JSON.stringify({
      title: (isBug ? '[Bug] ' : '[Feature] ') + body.title,
      body: issueBody,
      labels,
    });

    const ghReq = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/issues`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'JimboMesh-Holler/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (ghRes) => {
      let data = '';
      ghRes.on('data', (chunk) => (data += chunk));
      ghRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (ghRes.statusCode === 201) {
            json(res, 201, {
              success: true,
              issue_number: parsed.number,
              url: parsed.html_url,
            });
          } else {
            sendError(res, ghRes.statusCode, 'github_error', parsed.message || 'GitHub API error');
          }
        } catch {
          sendError(res, 502, 'github_error', 'Invalid response from GitHub');
        }
      });
    });

    ghReq.on('error', (err) => {
      sendError(res, 502, 'github_error', `GitHub API request failed: ${err.message}`);
    });

    ghReq.write(postData);
    ghReq.end();
  });
}

// ── Document RAG Pipeline Handlers ──────────────────────────────

function handleDocumentUpload(req, res, db, sendError) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    sendError(res, 400, 'invalid_request', 'Expected multipart/form-data');
    return;
  }

  const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE_BYTES || '52428800');
  const params = new URL(req.url, 'http://localhost').searchParams;
  const collection = params.get('collection') || process.env.DOCUMENTS_COLLECTION || 'documents';

  // SSE response for progress
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  pipeline.ensureDocumentsDir();
  const docId = crypto.randomUUID();
  let savedPath = null;
  let originalName = '';
  let mimeType = '';
  let fileSize = 0;
  let fileLimitHit = false;

  const busboy = Busboy({
    headers: req.headers,
    limits: { fileSize: MAX_SIZE, files: 1 },
  });

  const ALLOWED_EXTENSIONS = ['.txt', '.md', '.pdf', '.csv', '.json', '.xml', '.html', '.doc', '.docx'];

  busboy.on('file', (fieldname, file, info) => {
    originalName = path.basename(info.filename).replace(/[\x00-\x1f]/g, '');
    mimeType = info.mimeType || pipeline.guessMime(originalName);
    // Correct MIME for extensions busboy might not detect
    if (mimeType === 'application/octet-stream') {
      mimeType = pipeline.guessMime(originalName);
    }
    const ext = path.extname(originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      file.resume(); // drain the stream
      res.write(`data: ${JSON.stringify({ error: 'Unsupported file type: ' + ext + '. Allowed: ' + ALLOWED_EXTENSIONS.join(', ') })}\n\n`);
      res.end();
      return;
    }
    savedPath = path.join(pipeline.DOCUMENTS_DIR, docId + ext);
    const writeStream = fs.createWriteStream(savedPath);

    file.on('data', (chunk) => { fileSize += chunk.length; });
    file.pipe(writeStream);

    file.on('limit', () => {
      fileLimitHit = true;
      writeStream.destroy();
      try { fs.unlinkSync(savedPath); } catch (e) { /* ignore */ }
      res.write('data: ' + JSON.stringify({ error: 'File exceeds maximum size (' + Math.round(MAX_SIZE / 1048576) + 'MB)' }) + '\n\n');
      res.end();
    });
  });

  busboy.on('finish', async () => {
    if (fileLimitHit) return;
    if (!savedPath) {
      res.write('data: ' + JSON.stringify({ error: 'No file uploaded' }) + '\n\n');
      res.end();
      return;
    }

    try {
      // Compute hash for dedup
      res.write('data: ' + JSON.stringify({ phase: 'upload', status: 'Checking file...' }) + '\n\n');
      const fileHash = await pipeline.computeFileHash(savedPath);
      const existing = db.getDocumentByHash(fileHash, collection);
      if (existing) {
        fs.unlinkSync(savedPath);
        res.write('data: ' + JSON.stringify({ error: 'duplicate', existing_id: existing.id, existing_name: existing.original_name }) + '\n\n');
        res.end();
        return;
      }

      // Insert document record
      const filename = docId + path.extname(originalName);
      db.insertDocument({
        id: docId,
        filename: filename,
        original_name: originalName,
        file_hash: fileHash,
        file_size: fileSize,
        mime_type: mimeType,
        collection: collection,
        status: 'processing',
      });

      res.write('data: ' + JSON.stringify({ phase: 'upload', status: 'Upload complete', document_id: docId }) + '\n\n');

      // Process document with progress callbacks
      const result = await pipeline.processDocument(docId, savedPath, mimeType, collection, (progress) => {
        res.write('data: ' + JSON.stringify(progress) + '\n\n');
      });

      db.updateDocumentStatus(docId, 'ready', null, result.chunkCount);
      res.write('data: ' + JSON.stringify({ done: true, document_id: docId, chunks: result.chunkCount }) + '\n\n');
      res.end();
    } catch (err) {
      console.error('[documents] Processing error:', err.message);
      try { db.updateDocumentStatus(docId, 'error', err.message, 0); } catch (e) { /* ignore */ }
      res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n');
      res.end();
    }
  });

  busboy.on('error', (err) => {
    console.error('[documents] Upload error:', err.message);
    res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n');
    res.end();
  });

  req.pipe(busboy);
}

async function handleDocumentAsk(req, res, ollamaUrl, sendError) {
  try {
    var body = await readBody(req);
    if (!body || !body.query) {
      sendError(res, 400, 'invalid_request', 'Missing query');
      return;
    }

    var collection = body.collection || process.env.DOCUMENTS_COLLECTION || 'documents';
    var limit = body.limit || 5;
    var chatModel = body.model || 'llama3.1:8b';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Semantic search for relevant chunks
    var result = await pipeline.askDocuments(body.query, collection, chatModel, limit);

    if (!result.messages) {
      res.write('data: ' + JSON.stringify({ phase: 'sources', hits: [] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ phase: 'answer', message: { role: 'assistant', content: 'No relevant documents found for your query.' } }) + '\n\n');
      res.write('data: ' + JSON.stringify({ done: true }) + '\n\n');
      res.end();
      return;
    }

    // Send sources
    var sourceSummary = result.hits.map(function (h) {
      return {
        filename: h.payload.filename || 'unknown',
        document_id: h.payload.document_id,
        chunk_index: h.payload.chunk_index,
        score: Math.round(h.score * 1000) / 1000,
        text_preview: (h.payload.text || '').substring(0, 200),
      };
    });
    res.write('data: ' + JSON.stringify({ phase: 'sources', hits: sourceSummary }) + '\n\n');

    // Stream chat response from Ollama
    var parsed = new URL(ollamaUrl);
    var chatBody = JSON.stringify({ model: chatModel, messages: result.messages, stream: true });
    var chatReq = http.request({
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || 11435,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000,
    }, function (chatRes) {
      var buffer = '';
      chatRes.on('data', function (chunk) {
        buffer += chunk.toString();
        var lines = buffer.split('\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].trim()) {
            try {
              var obj = JSON.parse(lines[i]);
              res.write('data: ' + JSON.stringify({ phase: 'answer', message: obj.message, done: obj.done }) + '\n\n');
            } catch (e) { /* skip */ }
          }
        }
      });
      chatRes.on('end', function () {
        if (buffer.trim()) {
          try {
            var obj = JSON.parse(buffer);
            res.write('data: ' + JSON.stringify({ phase: 'answer', message: obj.message, done: obj.done }) + '\n\n');
          } catch (e) { /* skip */ }
        }
        res.write('data: ' + JSON.stringify({ done: true }) + '\n\n');
        res.end();
      });
    });

    chatReq.on('error', function (err) {
      res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n');
      res.end();
    });
    chatReq.on('timeout', function () {
      chatReq.destroy();
      res.write('data: ' + JSON.stringify({ error: 'Chat request timed out' }) + '\n\n');
      res.end();
    });
    chatReq.write(chatBody);
    chatReq.end();
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, 500, 'server_error', err.message);
    } else {
      res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n');
      res.end();
    }
  }
}

// ── Mesh Connectivity Handlers ───────────────────────────────────

const { MeshConnector } = require('./mesh-connector');

function handleMeshStatus(meshConnector, res, config) {
  var hasStoredMeshKey = !!(config && config.db && config.db.getSetting('mesh_api_key'));

  if (!meshConnector) {
    var meshUrl = 'https://api.jimbomesh.ai';
    var hollerName = '';
    var autoConnect = false;
    if (config && config.db) {
      meshUrl = config.db.getSetting('mesh_url') || process.env.JIMBOMESH_COORDINATOR_URL || process.env.JIMBOMESH_MESH_URL || meshUrl;
      hollerName = config.db.getSetting('holler_name') || process.env.JIMBOMESH_HOLLER_NAME || '';
      autoConnect = config.db.getSetting('mesh_auto_connect') === 'true';
    }
    json(res, 200, {
      state: 'disconnected', connected: false, connecting: false, mode: 'off-grid',
      meshUrl: meshUrl, hollerName: hollerName, autoConnect: autoConnect,
      hasStoredMeshKey: hasStoredMeshKey, log: []
    });
    return;
  }
  var status = meshConnector.getStatus();
  if (config && config.db) {
    status.autoConnect = config.db.getSetting('mesh_auto_connect') === 'true';
  }
  status.hasStoredMeshKey = hasStoredMeshKey;
  json(res, 200, status);
}

function handleMeshConnect(req, res, config) {
  readBody(req).then(function (body) {
    if (!body || !body.apiKey) {
      config.sendError(res, 400, 'invalid_request', 'Missing apiKey');
      return;
    }

    var meshUrl = body.meshUrl || config.meshUrl || 'https://api.jimbomesh.ai';
    var apiKey = body.apiKey;
    var hollerName = body.hollerName || '';
    var autoConnect = body.autoConnect !== undefined ? body.autoConnect : true;

    // SaaS API keys start with 'jmsh_' — reject anything that looks like a local key
    if (apiKey && !apiKey.startsWith('jmsh_')) {
      config.sendError(res, 400, 'invalid_key',
        'This looks like a local Holler API key, not a JimboMesh SaaS API key. SaaS keys start with jmsh_. Get yours at app.jimbomesh.ai');
      return;
    }

    // Snapshot local key before mesh operations
    var originalLocalKey = config.getApiKey();

    // Persist to SQLite so reconnect survives within the same container lifecycle
    if (config.db) {
      config.db.setSetting('mesh_api_key', apiKey);
      config.db.setSetting('mesh_url', meshUrl);
      config.db.setSetting('holler_name', hollerName);
      config.db.setSetting('mesh_auto_connect', String(autoConnect));
    }

    // Stop existing connector if any
    var existing = config.getMeshConnector();
    if (existing) {
      existing.stop().catch(function () {});
    }

    // Create and start new connector
    var connector = new MeshConnector({
      meshUrl: meshUrl,
      apiKey: apiKey,
      ollamaUrl: config.ollamaUrl,
      hollerEndpoint: process.env.JIMBOMESH_HOLLER_ENDPOINT || 'http://127.0.0.1:11435',
      db: config.db,
      version: require('./package.json').version,
      hollerName: hollerName || undefined,
    });
    config.setMeshConnector(connector);
    connector.start();

    // Defense-in-depth: verify local inference key was not modified
    var localKeyAfter = config.getApiKey();
    if (localKeyAfter !== originalLocalKey) {
      console.error('[mesh] CRITICAL: Local API key was modified during mesh connect! Rolling back.');
      config.setApiKey(originalLocalKey);
    }

    json(res, 200, { success: true });
  });
}

function handleMeshDisconnect(res, config) {
  var connector = config.getMeshConnector();
  if (connector) {
    connector.stop().catch(function () {});
  }
  config.setMeshConnector(null);

  // Keep mesh_api_key in SQLite so user can reconnect with one click.
  // Only clear transient connection state, not the key itself.
  if (config.db) {
    config.db.setSetting('mesh_auto_connect', 'false');
  }

  json(res, 200, { success: true });
}

function handleMeshSettings(req, res, config) {
  readBody(req).then(function (body) {
    if (!body) {
      config.sendError(res, 400, 'invalid_request', 'Invalid body');
      return;
    }
    if (config.db) {
      if (body.hollerName !== undefined) config.db.setSetting('holler_name', body.hollerName);
      if (body.autoConnect !== undefined) config.db.setSetting('mesh_auto_connect', String(body.autoConnect));
      if (body.meshUrl !== undefined) config.db.setSetting('mesh_url', body.meshUrl);
    }
    json(res, 200, { success: true });
  });
}

function handleMeshAutoConnect(req, res, config) {
  readBody(req).then(function (body) {
    if (!body || typeof body.enabled !== 'boolean') {
      config.sendError(res, 400, 'invalid_request', 'Missing boolean enabled');
      return;
    }
    if (config.db) {
      config.db.setSetting('mesh_auto_connect', body.enabled ? 'true' : 'false');
    }
    json(res, 200, { success: true, autoConnect: !!body.enabled });
  });
}

// ── Mesh: Connect from stored key ────────────────────────────────

function handleMeshConnectStored(res, config) {
  if (!config.db) {
    config.sendError(res, 501, 'not_available', 'SQLite not available');
    return;
  }
  var apiKey = config.db.getSetting('mesh_api_key');
  if (!apiKey) {
    config.sendError(res, 400, 'no_key', 'No stored mesh API key. Enter one first.');
    return;
  }

  var meshUrl = config.db.getSetting('mesh_url') || process.env.JIMBOMESH_COORDINATOR_URL || process.env.JIMBOMESH_MESH_URL || 'https://api.jimbomesh.ai';
  var hollerName = config.db.getSetting('holler_name') || process.env.JIMBOMESH_HOLLER_NAME || '';

  var originalLocalKey = config.getApiKey();

  var existing = config.getMeshConnector();
  if (existing) {
    existing.stop().catch(function () {});
  }

  var connector = new MeshConnector({
    meshUrl: meshUrl,
    apiKey: apiKey,
    ollamaUrl: config.ollamaUrl,
    hollerEndpoint: process.env.JIMBOMESH_HOLLER_ENDPOINT || 'http://127.0.0.1:11435',
    db: config.db,
    version: require('./package.json').version,
    hollerName: hollerName || undefined,
  });
  config.setMeshConnector(connector);
  connector.start();

  var localKeyAfter = config.getApiKey();
  if (localKeyAfter !== originalLocalKey) {
    console.error('[mesh] CRITICAL: Local API key was modified during mesh connect! Rolling back.');
    config.setApiKey(originalLocalKey);
  }

  json(res, 200, { success: true });
}

function handleMeshForgetKey(res, config) {
  if (config.db) {
    config.db.setSetting('mesh_api_key', '');
  }
  json(res, 200, { success: true });
}

function handleMeshReconnect(res, config) {
  var existing = config.getMeshConnector();
  if (!existing && !config.db) {
    config.sendError(res, 400, 'not_connected', 'No active mesh connection and no stored key');
    return;
  }

  // Stop existing connector
  if (existing) {
    existing.stop().catch(function () {});
    config.setMeshConnector(null);
  }

  var apiKey = config.db ? config.db.getSetting('mesh_api_key') : null;
  if (!apiKey) {
    config.sendError(res, 400, 'no_key', 'No stored mesh API key');
    return;
  }

  var meshUrl = config.db.getSetting('mesh_url') || process.env.JIMBOMESH_COORDINATOR_URL || process.env.JIMBOMESH_MESH_URL || 'https://api.jimbomesh.ai';
  var hollerName = config.db.getSetting('holler_name') || process.env.JIMBOMESH_HOLLER_NAME || '';

  var originalLocalKey = config.getApiKey();

  var connector = new MeshConnector({
    meshUrl: meshUrl,
    apiKey: apiKey,
    ollamaUrl: config.ollamaUrl,
    hollerEndpoint: process.env.JIMBOMESH_HOLLER_ENDPOINT || 'http://127.0.0.1:11435',
    db: config.db,
    version: require('./package.json').version,
    hollerName: hollerName || undefined,
  });
  config.setMeshConnector(connector);
  connector.start();

  var localKeyAfter = config.getApiKey();
  if (localKeyAfter !== originalLocalKey) {
    console.error('[mesh] CRITICAL: Local API key modified during reconnect! Rolling back.');
    config.setApiKey(originalLocalKey);
  }

  json(res, 200, { success: true });
}

// ── Restart Handler ─────────────────────────────────────────────

function handleRestart(req, res, config) {
  readBody(req).then(function (body) {
    var target = (body && body.target) || 'holler';
    var inDocker = isDockerEnv();

    json(res, 200, { success: true, message: 'Restarting ' + target + '...' });

    setTimeout(function () {
      if (target === 'ollama') {
        if (process.platform === 'darwin' || process.env.OLLAMA_EXTERNAL_URL) {
          try {
            execSync('pkill -f "ollama serve"', { timeout: 5000, stdio: 'ignore' });
            console.log('[admin] Ollama process killed — it should auto-restart via launchctl/brew');
          } catch (err) {
            console.log('[admin] Ollama restart: pkill failed — may not be running or already restarted');
          }
        } else {
          console.log('[admin] Ollama restart requested inside Docker — restart the Ollama container manually');
        }
      } else {
        console.log('[admin] Holler restart requested — exiting for container/process manager restart');
        process.exit(0);
      }
    }, 500);
  });
}

// ── Main Router ─────────────────────────────────────────────────

function maskKey(key) {
  if (!key || key.length < 12) return '****';
  return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
}

function createAdminRoutes(config) {
  const { ollamaUrl, getApiKey, setApiKey, adminApiKey, sendError, getActivity, startTime, db, tokenManager, jwtValidator } = config;
  const adminEnabled =
    (process.env.ADMIN_ENABLED || 'true').toLowerCase() !== 'false';

  function effectiveAdminKey() {
    return adminApiKey || getApiKey();
  }

  /**
   * Handle an incoming request.
   * Returns true if handled, false if the request should pass through.
   */
  return function handleAdmin(req, res) {
    const pathname = req.url.split('?')[0];

    if (!pathname.startsWith('/admin')) return false;

    // Kill switch
    if (!adminEnabled) {
      json(res, 404, { error: 'Not found' });
      return true;
    }

    // Static files — no auth required
    if (!pathname.startsWith('/admin/api/')) {
      serveStatic(pathname, res);
      return true;
    }

    const route = pathname.slice('/admin/api'.length);

    // Branding config — no auth (public, used by login page)
    if (req.method === 'GET' && route === '/branding') {
      const dbName = db && db.getSetting('server_name');
      const serverName = dbName || process.env.HOLLER_SERVER_NAME || 'Holler Server';
      json(res, 200, {
        serverName,
        adminTitle: process.env.HOLLER_ADMIN_TITLE || 'JimboMesh Holler Server \u2014 Admin',
      });
      return true;
    }

    // Admin API — requires admin key (or inference key if ADMIN_API_KEY not set)
    const providedKey = req.headers['x-api-key'];
    if (!safeCompare(providedKey, effectiveAdminKey())) {
      sendError(res, 401, 'auth_required', 'Admin API key required');
      return true;
    }

    if (req.method === 'GET' && route === '/status') {
      handleStatus(ollamaUrl, startTime, getActivity, res, db);
    } else if (req.method === 'GET' && route === '/models') {
      handleModels(ollamaUrl, res, sendError);
    } else if (req.method === 'POST' && route === '/models/pull') {
      handlePull(ollamaUrl, req, res, sendError);
    } else if (req.method === 'DELETE' && route.startsWith('/models/')) {
      handleDelete(ollamaUrl, decodeURIComponent(route.slice('/models/'.length)), res, sendError);
    } else if (req.method === 'POST' && route === '/models/show') {
      handleShow(ollamaUrl, req, res, sendError);
    } else if (req.method === 'GET' && route === '/models/running') {
      handleRunning(ollamaUrl, res, sendError);
    } else if (req.method === 'GET' && route === '/config') {
      handleConfig(res, db);
    } else if (req.method === 'GET' && route === '/activity') {
      handleActivity(getActivity, req, res, db);
    } else if (req.method === 'DELETE' && route === '/activity') {
      if (!db || !db.clearRequestLog) {
        sendError(res, 501, 'not_available', 'SQLite not available');
        return;
      }
      const deleted = db.clearRequestLog();
      json(res, 200, { deleted });
    } else if (req.method === 'POST' && route === '/settings/batch') {
      handleSettingsBatch(req, res, db, config.onSettingsChanged);
    } else if ((req.method === 'GET' || req.method === 'POST') && route === '/settings') {
      handleSettings(req, res, db, config.onSettingsChanged);
    } else if (req.method === 'GET' && route === '/stats') {
      handleStats(req, res, db);
    } else if (req.method === 'GET' && route.match(/^\/stats\/models\/[^/]+$/)) {
      const model = decodeURIComponent(route.slice('/stats/models/'.length));
      handleStatsModel(req, res, model);
    } else if (req.method === 'GET' && route === '/stats/requests') {
      handleStatsRequests(req, res);
    } else if (req.method === 'GET' && route === '/stats/hourly') {
      handleStatsHourly(req, res);
    } else if (req.method === 'POST' && route === '/stats/reset') {
      handleStatsReset(req, res);
    } else if ((req.method === 'GET' || req.method === 'POST') && route === '/stats/pricing') {
      handleStatsPricing(req, res);
    } else if (req.method === 'GET' && route === '/system') {
      handleSystem(res, sendError);
    } else if (req.method === 'GET' && route === '/apikey') {
      json(res, 200, { masked: maskKey(getApiKey()) });
    } else if (req.method === 'GET' && route === '/qdrantkey') {
      const qk = process.env.QDRANT_API_KEY || '';
      json(res, 200, { set: !!qk, masked: maskKey(qk) });
    } else if (req.method === 'GET' && route === '/gpu-info') {
      detectGpuInfo(ollamaUrl).then(data => json(res, 200, data)).catch(err => sendError(res, 500, 'gpu_error', err.message));
    } else if (req.method === 'GET' && route === '/marketplace/ollama') {
      handleMarketplaceOllama(ollamaUrl, res, sendError);
    } else if (req.method === 'GET' && route === '/marketplace/huggingface') {
      handleMarketplaceHuggingFace(req, res, sendError);
    } else if (req.method === 'GET' && route === '/marketplace/huggingface/files') {
      handleHfModelFiles(req, res, sendError);
    } else if (req.method === 'POST' && route === '/models/import-hf') {
      handleHfImport(ollamaUrl, req, res, sendError);
    } else if (req.method === 'POST' && route === '/github/issue') {
      handleGitHubIssue(req, res, sendError);
    } else if (req.method === 'GET' && route === '/github/status') {
      json(res, 200, { configured: !!process.env.GITHUB_TOKEN });
    } else if (req.method === 'POST' && route === '/apikey/regenerate') {
      readBody(req).then((body) => {
        if (!body || body.confirm !== 'hellyeah') {
          sendError(res, 400, 'confirmation_required', 'Must confirm with "hellyeah"');
          return;
        }
        const newKey = crypto.randomBytes(32).toString('hex');
        // Defense-in-depth: local keys are hex, never jmsh_
        if (newKey.startsWith('jmsh_')) {
          sendError(res, 500, 'key_generation_error', 'Generated key has reserved prefix. Try again.');
          return;
        }
        setApiKey(newKey);
        json(res, 200, { success: true, key: newKey, masked: maskKey(newKey) });
      });

    // ── Auth Status & Bearer Token Routes ────────────────────────
    } else if (req.method === 'GET' && route === '/auth/status') {
      var tier2Tokens = tokenManager ? tokenManager.listTokens() : [];
      var tier3Config = jwtValidator ? jwtValidator.getConfig() : null;
      json(res, 200, {
        tier1: { enabled: true },
        tier2: {
          enabled: tokenManager ? tokenManager.isEnabled() : false,
          token_count: tier2Tokens.length,
        },
        tier3: {
          configured: jwtValidator ? jwtValidator.isConfigured() : false,
          domain: tier3Config ? tier3Config.domain : null,
          audience: tier3Config ? tier3Config.audience : null,
        },
      });

    } else if (req.method === 'GET' && route === '/tokens') {
      if (!tokenManager) { json(res, 200, { tokens: [] }); return true; }
      json(res, 200, { tokens: tokenManager.listTokens() });

    } else if (req.method === 'POST' && route === '/tokens') {
      if (!tokenManager) { sendError(res, 501, 'not_available', 'Token manager not available'); return true; }
      readBody(req).then(function (body) {
        if (!body || !body.name) { sendError(res, 400, 'invalid_request', 'Missing token name'); return; }
        var opts = {
          name: body.name,
          permissions: body.permissions || ['full'],
          rpm: body.rpm || 60,
          rph: body.rph || 1000,
          expires_at: body.expires_at || null,
        };
        var result = tokenManager.createToken(opts);
        json(res, 201, {
          id: result.token.id,
          name: result.token.name,
          prefix: result.token.prefix,
          permissions: result.token.permissions,
          rpm: result.token.rpm,
          rph: result.token.rph,
          expires_at: result.token.expires_at,
          created_at: result.token.created_at,
          raw: result.raw,
        });
      });

    } else if (req.method === 'DELETE' && route.match(/^\/tokens\/[^/]+$/)) {
      if (!tokenManager) { sendError(res, 501, 'not_available', 'Token manager not available'); return true; }
      var tokenId = route.slice('/tokens/'.length);
      var revoked = tokenManager.revokeToken(tokenId);
      if (!revoked) { sendError(res, 404, 'not_found', 'Token not found'); return true; }
      json(res, 200, { revoked: true, id: tokenId });

    } else if (req.method === 'PATCH' && route.match(/^\/tokens\/[^/]+$/)) {
      if (!tokenManager) { sendError(res, 501, 'not_available', 'Token manager not available'); return true; }
      var tokenIdPatch = route.slice('/tokens/'.length);
      readBody(req).then(function (body) {
        if (!body) { sendError(res, 400, 'invalid_request', 'Missing body'); return; }
        var updated = tokenManager.updateToken(tokenIdPatch, body);
        if (!updated) { sendError(res, 404, 'not_found', 'Token not found'); return; }
        json(res, 200, updated);
      });

    } else if (req.method === 'GET' && route.match(/^\/tokens\/[^/]+\/usage$/)) {
      if (!tokenManager) { sendError(res, 501, 'not_available', 'Token manager not available'); return true; }
      var tokenIdUsage = route.split('/')[2];
      var usage = tokenManager.getTokenUsageHistory(tokenIdUsage);
      if (usage === null) { sendError(res, 404, 'not_found', 'Token not found'); return true; }
      json(res, 200, { hourly_usage: usage });

    // ── Document RAG Pipeline Routes ────────────────────────────
    } else if (req.method === 'POST' && route === '/documents/upload') {
      handleDocumentUpload(req, res, db, sendError);
    } else if (req.method === 'GET' && route === '/documents') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const collection = params.get('collection');
      const docs = collection ? db.getDocumentsByCollection(collection) : db.getAllDocuments();
      json(res, 200, { documents: docs });
    } else if (req.method === 'GET' && route.match(/^\/documents\/[^/]+\/chunks$/)) {
      const docId = route.split('/')[2];
      const doc = db.getDocument(docId);
      if (!doc) { sendError(res, 404, 'not_found', 'Document not found'); return; }
      qdrant.scrollPoints(doc.collection, { must: [{ key: 'document_id', match: { value: docId } }] }, 1000).then(function (result) {
        var chunks = (result.points || []).sort(function (a, b) { return (a.payload.chunk_index || 0) - (b.payload.chunk_index || 0); });
        json(res, 200, { document: doc, chunks: chunks.map(function (p) { return { id: p.id, text: p.payload.text, chunk_index: p.payload.chunk_index, total_chunks: p.payload.total_chunks }; }) });
      }).catch(function (err) { sendError(res, 500, 'qdrant_error', err.message); });
    } else if (req.method === 'GET' && route.match(/^\/documents\/[^/]+$/) && !route.includes('/chunks')) {
      const docId = route.slice('/documents/'.length);
      const doc = db.getDocument(docId);
      if (!doc) { sendError(res, 404, 'not_found', 'Document not found'); return; }
      json(res, 200, doc);
    } else if (req.method === 'DELETE' && route.match(/^\/documents\/[^/]+$/)) {
      const docId = route.slice('/documents/'.length);
      const doc = db.getDocument(docId);
      if (!doc) { sendError(res, 404, 'not_found', 'Document not found'); return; }
      // Delete vectors from Qdrant
      pipeline.deleteDocumentVectors(docId, doc.collection).then(function () {
        // Delete file from disk
        const filePath = path.join(pipeline.DOCUMENTS_DIR, doc.filename);
        try { fs.unlinkSync(filePath); } catch (e) { /* file may not exist */ }
        // Delete from SQLite
        db.deleteDocument(docId);
        json(res, 200, { deleted: true, id: docId });
      }).catch(function (err) {
        // Still delete from SQLite even if Qdrant fails
        try { fs.unlinkSync(path.join(pipeline.DOCUMENTS_DIR, doc.filename)); } catch (e) { /* ignore */ }
        db.deleteDocument(docId);
        json(res, 200, { deleted: true, id: docId, qdrant_warning: err.message });
      });
    } else if (req.method === 'POST' && route.match(/^\/documents\/[^/]+\/reindex$/)) {
      const docId = route.split('/')[2];
      const doc = db.getDocument(docId);
      if (!doc) { sendError(res, 404, 'not_found', 'Document not found'); return; }
      const filePath = path.join(pipeline.DOCUMENTS_DIR, doc.filename);
      if (!fs.existsSync(filePath)) { sendError(res, 404, 'file_not_found', 'Document file not found on disk'); return; }
      // SSE for reindex progress
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      db.updateDocumentStatus(docId, 'processing', null, 0);
      res.write('data: ' + JSON.stringify({ phase: 'reindex', status: 'Deleting old vectors...' }) + '\n\n');
      pipeline.deleteDocumentVectors(docId, doc.collection).then(function () {
        return pipeline.processDocument(docId, filePath, doc.mime_type, doc.collection, function (progress) {
          res.write('data: ' + JSON.stringify(progress) + '\n\n');
        });
      }).then(function (result) {
        db.updateDocumentStatus(docId, 'ready', null, result.chunkCount);
        res.write('data: ' + JSON.stringify({ done: true, chunks: result.chunkCount }) + '\n\n');
        res.end();
      }).catch(function (err) {
        db.updateDocumentStatus(docId, 'error', err.message, 0);
        res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n');
        res.end();
      });
    } else if (req.method === 'POST' && route === '/documents/query') {
      readBody(req).then(async function (body) {
        if (!body || !body.query) { sendError(res, 400, 'invalid_request', 'Missing query'); return; }
        try {
          var collection = body.collection || process.env.DOCUMENTS_COLLECTION || 'documents';
          var hits = await pipeline.searchDocuments(body.query, collection, body.limit || 5);
          json(res, 200, { results: hits.map(function (h) { return { score: h.score, payload: h.payload }; }) });
        } catch (err) { sendError(res, 500, 'search_error', err.message); }
      });
    } else if (req.method === 'POST' && route === '/documents/ask') {
      handleDocumentAsk(req, res, ollamaUrl, sendError);

    // ── Collection Management Routes ────────────────────────────
    } else if (req.method === 'GET' && route === '/collections') {
      qdrant.listCollections().then(function (collections) {
        json(res, 200, { collections: collections });
      }).catch(function (err) { sendError(res, 500, 'qdrant_error', err.message); });
    } else if (req.method === 'POST' && route === '/collections') {
      readBody(req).then(async function (body) {
        if (!body || !body.name) { sendError(res, 400, 'invalid_request', 'Missing collection name'); return; }
        try {
          await qdrant.createCollection(body.name, body.size, body.distance);
          json(res, 200, { created: true, name: body.name });
        } catch (err) { sendError(res, 500, 'qdrant_error', err.message); }
      });
    } else if (req.method === 'DELETE' && route.match(/^\/collections\/[^/]+$/)) {
      var collName = decodeURIComponent(route.slice('/collections/'.length));
      qdrant.deleteCollection(collName).then(function () {
        json(res, 200, { deleted: true, name: collName });
      }).catch(function (err) { sendError(res, 500, 'qdrant_error', err.message); });

    // ── Mesh Connectivity Routes ──────────────────────────────────
    } else if (req.method === 'GET' && route === '/mesh/status') {
      handleMeshStatus(config.getMeshConnector(), res, config);
    } else if (req.method === 'POST' && route === '/mesh/connect') {
      handleMeshConnect(req, res, config);
    } else if (req.method === 'POST' && route === '/mesh/disconnect') {
      handleMeshDisconnect(res, config);
    } else if (req.method === 'POST' && route === '/mesh/cancel') {
      var mc = config.getMeshConnector();
      if (mc) mc.cancel();
      json(res, 200, { success: true });
    } else if (req.method === 'POST' && route === '/mesh/settings') {
      handleMeshSettings(req, res, config);
    } else if (req.method === 'POST' && route === '/mesh/auto-connect') {
      handleMeshAutoConnect(req, res, config);
    } else if (req.method === 'POST' && route === '/mesh/connect-stored') {
      handleMeshConnectStored(res, config);
    } else if (req.method === 'POST' && route === '/mesh/forget-key') {
      handleMeshForgetKey(res, config);
    } else if (req.method === 'POST' && route === '/mesh/reconnect') {
      handleMeshReconnect(res, config);
    } else if (req.method === 'POST' && route === '/restart') {
      handleRestart(req, res, config);
    } else if (req.method === 'GET' && route === '/mesh/peers') {
      var mc = config.getMeshConnector();
      if (!mc || !mc.peerHandler) {
        json(res, 200, { activeConnections: 0, maxConnections: 0, jobs: [] });
      } else {
        json(res, 200, mc.peerHandler.getStatus());
      }

    } else {
      sendError(res, 404, 'not_found', 'Unknown admin endpoint');
    }

    return true;
  };
}

module.exports = { createAdminRoutes };

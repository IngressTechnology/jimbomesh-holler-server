#!/usr/bin/env node
/**
 * JimboMesh Holler Server — HTTP Health Server
 * Lightweight Node.js health check server replacing the previous socat + bash approach.
 * Runs alongside Ollama on a separate port (default 9090).
 */

const http = require('http');
const { execFileSync } = require('child_process');

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '9090');
const OLLAMA_URL = `http://localhost:${process.env.OLLAMA_INTERNAL_PORT || '11435'}`;
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const HEALTH_WARMUP = process.env.HEALTH_WARMUP === 'true';

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function checkOllamaApi() {
  return new Promise((resolve) => {
    const req = http.get(`${OLLAMA_URL}/api/tags`, { timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function ollamaList() {
  try {
    return execFileSync('ollama', ['list'], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return '';
  }
}

async function ollamaWarmup() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: EMBED_MODEL, input: 'health check warmup' });
    const req = http.request(
      `${OLLAMA_URL}/api/embed`,
      {
        method: 'POST',
        timeout: 10000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve(data.includes('"embeddings"')));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

async function fetchTags() {
  return new Promise((resolve) => {
    const req = http.get(`${OLLAMA_URL}/api/tags`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function respond(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    Connection: 'close',
  });
  res.end(json);
}

async function handleHealthz(res) {
  const start = Date.now();
  const apiOk = await checkOllamaApi();
  const latency = Date.now() - start;
  const status = apiOk ? 'ok' : 'error';
  respond(res, apiOk ? 200 : 503, {
    status,
    check: 'liveness',
    ollama_api: apiOk,
    latency_ms: latency,
    timestamp: timestamp(),
  });
}

async function handleReadyz(res) {
  const start = Date.now();
  let checksPassed = 0;
  let checksTotal = 2;
  let apiOk = false;
  let modelOk = false;
  let warmupStatus = 'skipped';
  let warmupLatency = 0;

  apiOk = await checkOllamaApi();
  if (apiOk) checksPassed++;

  if (apiOk) {
    const list = ollamaList();
    modelOk = list.includes(EMBED_MODEL);
    if (modelOk) checksPassed++;
  }

  if (HEALTH_WARMUP && modelOk) {
    checksTotal = 3;
    const warmupStart = Date.now();
    const ok = await ollamaWarmup();
    warmupLatency = Date.now() - warmupStart;
    warmupStatus = ok ? 'ok' : 'failed';
    if (ok) checksPassed++;
  }

  const latency = Date.now() - start;
  const allOk = checksPassed === checksTotal;
  respond(res, allOk ? 200 : 503, {
    status: allOk ? 'ok' : 'error',
    check: 'readiness',
    checks_passed: checksPassed,
    checks_total: checksTotal,
    ollama_api: apiOk,
    model_available: modelOk,
    model: EMBED_MODEL,
    warmup: warmupStatus,
    warmup_latency_ms: warmupLatency,
    latency_ms: latency,
    timestamp: timestamp(),
  });
}

async function handleStatus(res) {
  const start = Date.now();
  const apiOk = await checkOllamaApi();

  if (apiOk) {
    const tags = await fetchTags();
    const models = tags && tags.models ? tags.models.map((m) => m.name) : [];
    const latency = Date.now() - start;
    respond(res, 200, {
      status: 'ok',
      ollama_api: true,
      models,
      model_count: models.length,
      embed_model: EMBED_MODEL,
      health_warmup: String(HEALTH_WARMUP),
      latency_ms: latency,
      timestamp: timestamp(),
    });
  } else {
    const latency = Date.now() - start;
    respond(res, 503, {
      status: 'error',
      ollama_api: false,
      models: [],
      model_count: 0,
      embed_model: EMBED_MODEL,
      health_warmup: String(HEALTH_WARMUP),
      latency_ms: latency,
      timestamp: timestamp(),
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    respond(res, 405, { error: 'method_not_allowed', message: 'Only GET is supported', allowed: ['GET'] });
    return;
  }

  const pathname = req.url.split('?')[0];

  switch (pathname) {
    case '/healthz':
      await handleHealthz(res);
      break;
    case '/readyz':
      await handleReadyz(res);
      break;
    case '/status':
      await handleStatus(res);
      break;
    default:
      respond(res, 404, {
        error: 'not_found',
        message: 'Unknown endpoint',
        available_endpoints: ['/healthz', '/readyz', '/status'],
      });
  }
});

server.listen(HEALTH_PORT, () => {
  console.log(`[jimbomesh-still] health server starting on :${HEALTH_PORT}`);
});

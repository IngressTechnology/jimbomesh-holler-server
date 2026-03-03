/**
 * SQLite Database Layer for JimboMesh API Gateway and Holler Server
 * Provides persistent storage for request logs, settings, statistics, and rate limits.
 * Uses better-sqlite3 in WAL mode for concurrent reads during writes.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ── Configuration ──────────────────────────────────────────────

// Combined DB_PATH logic. Prioritizing incoming branch's more general path structure.
const DB_PATH = process.env.SQLITE_DB_PATH
  || path.join(__dirname, 'data', 'holler.db');
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '30');

// Ensure data directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// ── Open Database ──────────────────────────────────────────────

const db = new Database(DB_PATH);

// Performance: WAL mode for concurrent reads during writes
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -8000'); // 8MB cache
db.pragma('busy_timeout = 5000');

console.log(`[db] SQLite database opened at ${DB_PATH}`);

// ── Schema Migration ───────────────────────────────────────────

const CURRENT_SCHEMA_VERSION = 4;

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS request_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    status      INTEGER NOT NULL,
    ip          TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    model       TEXT,
    error       TEXT
  );

  CREATE TABLE IF NOT EXISTS stats_hourly (
    hour            TEXT NOT NULL,
    total_requests  INTEGER DEFAULT 0,
    embed_requests  INTEGER DEFAULT 0,
    chat_requests   INTEGER DEFAULT 0,
    error_count     INTEGER DEFAULT 0,
    avg_duration_ms REAL DEFAULT 0,
    p95_duration_ms REAL DEFAULT 0,
    PRIMARY KEY (hour)
  );

  -- Rate Limit Table (from HEAD branch)
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_request_log_timestamp ON request_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_request_log_path ON request_log(path);

  -- Documents table (for Document RAG Pipeline)
  CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_hash     TEXT NOT NULL,
    file_size     INTEGER NOT NULL,
    mime_type     TEXT NOT NULL,
    chunk_count   INTEGER DEFAULT 0,
    collection    TEXT NOT NULL DEFAULT 'documents',
    status        TEXT NOT NULL DEFAULT 'pending',
    error         TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(file_hash);
  CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);

  CREATE TABLE IF NOT EXISTS request_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    model TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    e2e_latency_ms INTEGER,
    ttft_ms INTEGER,
    generation_duration_ms INTEGER,
    tokens_per_second REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    is_tool_call INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_stats_model ON request_stats(model);
  CREATE INDEX IF NOT EXISTS idx_stats_started ON request_stats(started_at);
  CREATE INDEX IF NOT EXISTS idx_stats_status ON request_stats(status);

  CREATE TABLE IF NOT EXISTS model_metadata (
    model TEXT PRIMARY KEY,
    parameters TEXT,
    context_window INTEGER,
    max_output INTEGER,
    quantization TEXT,
    family TEXT,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS model_pricing (
    model TEXT PRIMARY KEY,
    moonshine_input_per_1k REAL NOT NULL,
    moonshine_output_per_1k REAL,
    updated_at INTEGER NOT NULL
  );
`);

// Record schema version if not already present
const versionRow = db.prepare(
  'SELECT version FROM schema_version WHERE version = ?'
).get(CURRENT_SCHEMA_VERSION);

if (!versionRow) {
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
    CURRENT_SCHEMA_VERSION
  );
}

// ── Schema Migration: v1 → v2 ────────────────────────────────
// Add auth_type column to request_log for tiered auth tracking
const v2Check = db.prepare(
  'SELECT version FROM schema_version WHERE version = 2'
).get();
if (!v2Check || CURRENT_SCHEMA_VERSION >= 2) {
  try {
    db.exec('ALTER TABLE request_log ADD COLUMN auth_type TEXT');
  } catch (_) { /* column already exists */ }
  if (!v2Check) {
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(2);
  }
}

const v3Check = db.prepare(
  'SELECT version FROM schema_version WHERE version = 3'
).get();
if (!v3Check && CURRENT_SCHEMA_VERSION >= 3) {
  db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(3);
}

// ── Schema Migration: v3 → v4 ────────────────────────────────
// Add connection_type column to request_stats for WebRTC tracking
const v4Check = db.prepare(
  'SELECT version FROM schema_version WHERE version = 4'
).get();
if (!v4Check && CURRENT_SCHEMA_VERSION >= 4) {
  try {
    db.exec('ALTER TABLE request_stats ADD COLUMN connection_type TEXT');
  } catch (_) { /* column already exists */ }
  db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(4);
}

// Self-heal: some databases may have schema_version=4 without the actual
// request_stats.connection_type column due prior migration ordering.
try {
  const requestStatsColumns = db.prepare("PRAGMA table_info(request_stats)").all();
  const hasConnectionType = requestStatsColumns.some(function (col) {
    return col.name === 'connection_type';
  });
  if (!hasConnectionType) {
    db.exec('ALTER TABLE request_stats ADD COLUMN connection_type TEXT');
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(4);
    console.log('[db] Added missing request_stats.connection_type column');
  }
} catch (err) {
  console.error('[db] Failed to verify request_stats schema:', err.message);
}

console.log(`[db] Schema version ${CURRENT_SCHEMA_VERSION} applied`);

// ── Seed Default Settings ──────────────────────────────────────

const SEED_SETTINGS = {
  server_name: process.env.HOLLER_SERVER_NAME || 'Holler Server',
  gateway_port: process.env.GATEWAY_PORT || '11434',
  ollama_internal_port: process.env.OLLAMA_INTERNAL_PORT || '11435',
  rate_limit_per_min: process.env.RATE_LIMIT_PER_MIN || '60',
  rate_limit_burst: process.env.RATE_LIMIT_BURST || '10',
  admin_enabled: process.env.ADMIN_ENABLED || 'true',
  max_request_body_bytes: process.env.MAX_REQUEST_BODY_BYTES || '1048576',
  max_batch_size: process.env.MAX_BATCH_SIZE || '100',
  ollama_timeout_ms: process.env.OLLAMA_TIMEOUT_MS || '120000',
  max_concurrent_requests: process.env.MAX_CONCURRENT_REQUESTS || '4',
  max_queue_size: process.env.MAX_QUEUE_SIZE || '50',
  shutdown_timeout_ms: process.env.SHUTDOWN_TIMEOUT_MS || '10000',
  ollama_models: process.env.HOLLER_MODELS || 'nomic-embed-text,llama3.1:8b',
  default_embed_model: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
  embed_dimensions: process.env.EMBED_DIMENSIONS || '768',
  ollama_num_parallel: process.env.OLLAMA_NUM_PARALLEL || '4',
  ollama_max_loaded_models: process.env.OLLAMA_MAX_LOADED_MODELS || '2',
  ollama_keep_alive: process.env.OLLAMA_KEEP_ALIVE || '5m',
  health_port: process.env.HEALTH_PORT || '9090',
  health_warmup: process.env.HEALTH_WARMUP || 'false',
  log_retention_days: String(LOG_RETENTION_DAYS),
  enhanced_security_enabled: process.env.ENHANCED_SECURITY_ENABLED || 'false',
};

const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);

const seedTx = db.transaction(() => {
  for (const [key, value] of Object.entries(SEED_SETTINGS)) {
    insertSetting.run(key, value);
  }
});
seedTx();

// ── Prepared Statements ────────────────────────────────────────

const stmts = {
  // Incoming branch statements
  logRequest: db.prepare(`
    INSERT INTO request_log (timestamp, method, path, status, ip, duration_ms, model, error, auth_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getRecentRequests: db.prepare(`
    SELECT id, timestamp, method, path, status, ip, duration_ms, model, error, auth_type
    FROM request_log
    ORDER BY id DESC
    LIMIT ?
    OFFSET ?
  `),

  getRequestCount: db.prepare('SELECT COUNT(*) as count FROM request_log'),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),

  getAllSettings: db.prepare(
    'SELECT key, value, updated_at FROM settings ORDER BY key'
  ),

  setSetting: db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `),

  getStatsHourly: db.prepare(`
    SELECT * FROM stats_hourly
    WHERE hour >= datetime('now', ? || ' hours')
    ORDER BY hour DESC
  `),

  getStatsSummary: db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN path LIKE '%/embed%' THEN 1 ELSE 0 END) as embed_requests,
      SUM(CASE WHEN path LIKE '%/chat%' THEN 1 ELSE 0 END) as chat_requests,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as error_count,
      ROUND(AVG(duration_ms), 1) as avg_duration_ms
    FROM request_log
  `),

  getStatsSummaryToday: db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN path LIKE '%/embed%' THEN 1 ELSE 0 END) as embed_requests,
      SUM(CASE WHEN path LIKE '%/chat%' THEN 1 ELSE 0 END) as chat_requests,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as error_count,
      ROUND(AVG(duration_ms), 1) as avg_duration_ms
    FROM request_log
    WHERE timestamp >= date('now')
  `),

  pruneOldLogs: db.prepare(`
    DELETE FROM request_log
    WHERE timestamp < datetime('now', ? || ' days')
  `),

  rollupHour: db.prepare(`
    INSERT OR REPLACE INTO stats_hourly (hour, total_requests, embed_requests, chat_requests, error_count, avg_duration_ms, p95_duration_ms)
    SELECT
      strftime('%Y-%m-%dT%H', timestamp) as hour,
      COUNT(*) as total_requests,
      SUM(CASE WHEN path LIKE '%/embed%' THEN 1 ELSE 0 END) as embed_requests,
      SUM(CASE WHEN path LIKE '%/chat%' THEN 1 ELSE 0 END) as chat_requests,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as error_count,
      ROUND(AVG(duration_ms), 1) as avg_duration_ms,
      0 as p95_duration_ms
    FROM request_log
    WHERE strftime('%Y-%m-%dT%H', timestamp) = strftime('%Y-%m-%dT%H', 'now')
    GROUP BY hour
  `),

  getDbSize: db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()"),

  // HEAD branch statements (Rate Limit Queries)
  getRate: db.prepare('SELECT window_start, request_count FROM rate_limits WHERE key = ?'),
  upsertRate: db.prepare(`
    INSERT INTO rate_limits (key, window_start, request_count)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, request_count = excluded.request_count
  `),
  purgeExpired: db.prepare('DELETE FROM rate_limits WHERE window_start < ?'),
  clearRequestLog: db.prepare('DELETE FROM request_log'),

  // Document RAG Pipeline
  insertDocument: db.prepare(`
    INSERT INTO documents (id, filename, original_name, file_hash, file_size, mime_type, collection, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getDocument: db.prepare('SELECT * FROM documents WHERE id = ?'),
  getAllDocuments: db.prepare('SELECT * FROM documents ORDER BY created_at DESC'),
  getDocumentsByCollection: db.prepare('SELECT * FROM documents WHERE collection = ? ORDER BY created_at DESC'),
  getDocumentByHash: db.prepare('SELECT * FROM documents WHERE file_hash = ? AND collection = ?'),
  updateDocumentStatus: db.prepare(`
    UPDATE documents SET status = ?, error = ?, chunk_count = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  deleteDocument: db.prepare('DELETE FROM documents WHERE id = ?'),
  getModelMetadata: db.prepare('SELECT * FROM model_metadata WHERE model = ?'),
  upsertModelMetadata: db.prepare(`
    INSERT INTO model_metadata (model, parameters, context_window, max_output, quantization, family, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET
      parameters = excluded.parameters,
      context_window = excluded.context_window,
      max_output = excluded.max_output,
      quantization = excluded.quantization,
      family = excluded.family,
      updated_at = excluded.updated_at
  `),
  getAllModelPricing: db.prepare('SELECT * FROM model_pricing ORDER BY model'),
  getModelPricing: db.prepare('SELECT * FROM model_pricing WHERE model = ?'),
  upsertModelPricing: db.prepare(`
    INSERT INTO model_pricing (model, moonshine_input_per_1k, moonshine_output_per_1k, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET
      moonshine_input_per_1k = excluded.moonshine_input_per_1k,
      moonshine_output_per_1k = excluded.moonshine_output_per_1k,
      updated_at = excluded.updated_at
  `),
  deleteModelPricing: db.prepare('DELETE FROM model_pricing WHERE model = ?'),
};

// ── Exported Functions ─────────────────────────────────────────

// Functions from incoming branch
function logRequest({ method, path, status, ip, duration_ms, model, error, auth_type }) {
  stmts.logRequest.run(
    new Date().toISOString(),
    method,
    path,
    status,
    ip,
    duration_ms,
    model || null,
    error || null,
    auth_type || null
  );
}

function getRecentRequests(limit, offset) {
  limit = limit || 200;
  offset = offset || 0;
  return stmts.getRecentRequests.all(limit, offset);
}

function getRequestCount() {
  return stmts.getRequestCount.get().count;
}

function getSetting(key) {
  const row = stmts.getSetting.get(key);
  return row ? row.value : null;
}

function getAllSettings() {
  return stmts.getAllSettings.all();
}

function setSetting(key, value) {
  stmts.setSetting.run(key, String(value));
}

function getStats(hours) {
  hours = hours || 24;
  return stmts.getStatsHourly.all('-' + hours);
}

function getStatsSummary() {
  const allTime = stmts.getStatsSummary.get();
  const today = stmts.getStatsSummaryToday.get();
  return { all_time: allTime, today: today };
}

function pruneOldLogs(days) {
  days = days || LOG_RETENTION_DAYS;
  const result = stmts.pruneOldLogs.run('-' + days);
  if (result.changes > 0) {
    console.log(`[db] Pruned ${result.changes} log entries older than ${days} days`);
  }
  return result.changes;
}

function rollupHourlyStats() {
  stmts.rollupHour.run();
}

function getDbSize() {
  return stmts.getDbSize.get().size;
}

function clearRequestLog() {
  const result = stmts.clearRequestLog.run();
  console.log(`[db] Cleared ${result.changes} log entries`);
  return result.changes;
}

// Document RAG Pipeline functions
function insertDocument(doc) {
  stmts.insertDocument.run(doc.id, doc.filename, doc.original_name, doc.file_hash, doc.file_size, doc.mime_type, doc.collection, doc.status);
}
function getDocument(id) { return stmts.getDocument.get(id) || null; }
function getAllDocuments() { return stmts.getAllDocuments.all(); }
function getDocumentsByCollection(collection) { return stmts.getDocumentsByCollection.all(collection); }
function getDocumentByHash(hash, collection) { return stmts.getDocumentByHash.get(hash, collection) || null; }
function updateDocumentStatus(id, status, error, chunkCount) {
  stmts.updateDocumentStatus.run(status, error || null, chunkCount || 0, id);
}
function deleteDocument(id) { return stmts.deleteDocument.run(id); }

function getModelMetadata(model) {
  return stmts.getModelMetadata.get(model) || null;
}

function upsertModelMetadata(model, metadata) {
  const now = Date.now();
  stmts.upsertModelMetadata.run(
    model,
    metadata.parameters || null,
    metadata.context_window || null,
    metadata.max_output || null,
    metadata.quantization || null,
    metadata.family || null,
    now
  );
}

function getAllModelPricing() {
  return stmts.getAllModelPricing.all();
}

function getModelPricing(model) {
  return stmts.getModelPricing.get(model) || null;
}

function upsertModelPricing(model, inputPer1k, outputPer1k) {
  stmts.upsertModelPricing.run(model, inputPer1k, outputPer1k == null ? null : outputPer1k, Date.now());
}

function deleteModelPricing(model) {
  return stmts.deleteModelPricing.run(model);
}

function runSql(sql, params) {
  return db.prepare(sql).run(params || []);
}

function getSql(sql, params) {
  return db.prepare(sql).get(params || []);
}

function allSql(sql, params) {
  return db.prepare(sql).all(params || []);
}

// Functions from HEAD branch (Rate Limit)
function getRateLimit(key) {
  return stmts.getRate.get(key) || null;
}

function upsertRateLimit(key, windowStart, requestCount) {
  stmts.upsertRate.run(key, windowStart, requestCount);
}

function purgeExpiredRateLimits(beforeTimestamp) {
  return stmts.purgeExpired.run(beforeTimestamp);
}

// Close function (using incoming branch's version, as it fits eager init)
function close() {
  db.close();
  console.log('[db] Database closed');
}

// ── Module Exports ─────────────────────────────────────────────

module.exports = {
  // Exports from incoming branch
  logRequest,
  getRecentRequests,
  getRequestCount,
  getSetting,
  getAllSettings,
  setSetting,
  getStats,
  getStatsSummary,
  pruneOldLogs,
  rollupHourlyStats,
  getDbSize,
  clearRequestLog,
  // Document RAG Pipeline
  insertDocument,
  getDocument,
  getAllDocuments,
  getDocumentsByCollection,
  getDocumentByHash,
  updateDocumentStatus,
  deleteDocument,
  getModelMetadata,
  upsertModelMetadata,
  getAllModelPricing,
  getModelPricing,
  upsertModelPricing,
  deleteModelPricing,
  runSql,
  getSql,
  allSql,
  // Exports from HEAD branch
  getRateLimit,
  upsertRateLimit,
  purgeExpiredRateLimits,
  close, // Common function, using incoming branch's implementation
};
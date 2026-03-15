/**
 * SQLite Database Layer for JimboMesh API Gateway and Holler Server
 * Provides persistent storage for request logs, settings, statistics, and rate limits.
 * Uses sql.js for zero-native-module portability across Node versions and OSes.
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, 'data', 'holler.db');
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '30', 10);
const CURRENT_SCHEMA_VERSION = 5;

const SEED_SETTINGS = {
  server_name: process.env.HOLLER_SERVER_NAME || 'Holler Server',
  gateway_port: process.env.GATEWAY_PORT || '1920',
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

let SQL = null;
let db = null;
let initPromise = null;

function ensureDbDir() {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

function ensureReady() {
  if (!db) {
    throw new Error('Database not initialized. Call await db.init() before using db.js.');
  }
}

function normalizeValue(value) {
  return value === undefined ? null : value;
}

function normalizeParams(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params.map(normalizeValue);
  if (typeof params === 'object') {
    return Object.fromEntries(
      Object.entries(params).map(function ([key, value]) {
        return [key, normalizeValue(value)];
      })
    );
  }
  return [normalizeValue(params)];
}

function bindStatement(stmt, params) {
  const normalized = normalizeParams(params);
  if (Array.isArray(normalized)) {
    if (normalized.length > 0) stmt.bind(normalized);
    return;
  }
  stmt.bind(normalized);
}

function getRow(sql, params) {
  ensureReady();
  const stmt = db.prepare(sql);
  try {
    bindStatement(stmt, params);
    if (!stmt.step()) return undefined;
    return stmt.getAsObject();
  } finally {
    stmt.free();
  }
}

function getRows(sql, params) {
  ensureReady();
  const stmt = db.prepare(sql);
  try {
    bindStatement(stmt, params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function mutationResult() {
  return {
    changes: (getRow('SELECT changes() AS changes') || {}).changes || 0,
    lastInsertRowid: (getRow('SELECT last_insert_rowid() AS lastInsertRowid') || {}).lastInsertRowid || 0,
  };
}

function save() {
  ensureReady();
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function runMutation(sql, params, options) {
  ensureReady();
  const opts = options || {};
  db.run(sql, normalizeParams(params));
  const result = mutationResult();
  if (opts.saveAfter !== false) save();
  return result;
}

function execSql(sql) {
  ensureReady();
  return db.exec(sql);
}

function runInTransaction(work) {
  ensureReady();
  db.run('BEGIN');
  try {
    work();
    db.run('COMMIT');
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch (_) {
      /* ignore rollback failures */
    }
    throw err;
  }
}

function applySchema() {
  db.run(`
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

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_request_log_timestamp ON request_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_request_log_path ON request_log(path);

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

    CREATE TABLE IF NOT EXISTS hf_imports (
      repo_id    TEXT NOT NULL,
      filename   TEXT NOT NULL,
      model_name TEXT NOT NULL,
      imported_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (repo_id, filename)
    );
  `);

  const versionRow = getRow('SELECT version FROM schema_version WHERE version = ?', [CURRENT_SCHEMA_VERSION]);
  if (!versionRow) {
    runMutation('INSERT INTO schema_version (version) VALUES (?)', [CURRENT_SCHEMA_VERSION], { saveAfter: false });
  }

  const v2Check = getRow('SELECT version FROM schema_version WHERE version = 2');
  if (!v2Check && CURRENT_SCHEMA_VERSION >= 2) {
    try {
      db.run('ALTER TABLE request_log ADD COLUMN auth_type TEXT');
    } catch (_) {
      /* column already exists */
    }
    runMutation('INSERT OR REPLACE INTO schema_version (version) VALUES (?)', [2], { saveAfter: false });
  }

  const v3Check = getRow('SELECT version FROM schema_version WHERE version = 3');
  if (!v3Check && CURRENT_SCHEMA_VERSION >= 3) {
    runMutation('INSERT OR REPLACE INTO schema_version (version) VALUES (?)', [3], { saveAfter: false });
  }

  const v4Check = getRow('SELECT version FROM schema_version WHERE version = 4');
  if (!v4Check && CURRENT_SCHEMA_VERSION >= 4) {
    try {
      db.run('ALTER TABLE request_stats ADD COLUMN connection_type TEXT');
    } catch (_) {
      /* column already exists */
    }
    runMutation('INSERT OR REPLACE INTO schema_version (version) VALUES (?)', [4], { saveAfter: false });
  }

  try {
    const requestStatsColumns = getRows('PRAGMA table_info(request_stats)');
    const hasConnectionType = requestStatsColumns.some(function (col) {
      return col.name === 'connection_type';
    });
    if (!hasConnectionType) {
      db.run('ALTER TABLE request_stats ADD COLUMN connection_type TEXT');
      runMutation('INSERT OR REPLACE INTO schema_version (version) VALUES (?)', [4], { saveAfter: false });
      console.log('[db] Added missing request_stats.connection_type column');
    }
  } catch (err) {
    console.error('[db] Failed to verify request_stats schema:', err.message);
  }

  const v5Check = getRow('SELECT version FROM schema_version WHERE version = 5');
  if (!v5Check && CURRENT_SCHEMA_VERSION >= 5) {
    db.run(`
      CREATE TABLE IF NOT EXISTS hf_imports (
        repo_id    TEXT NOT NULL,
        filename   TEXT NOT NULL,
        model_name TEXT NOT NULL,
        imported_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (repo_id, filename)
      )
    `);
    runMutation('INSERT OR REPLACE INTO schema_version (version) VALUES (?)', [5], { saveAfter: false });
  }

  console.log(`[db] Schema version ${CURRENT_SCHEMA_VERSION} applied`);
}

function seedDefaultSettings() {
  runInTransaction(function () {
    for (const [key, value] of Object.entries(SEED_SETTINGS)) {
      db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
  });
}

async function init() {
  if (db) return module.exports;
  if (initPromise) return initPromise;

  initPromise = (async function () {
    ensureDbDir();

    SQL = await initSqlJs({
      locateFile: function (file) {
        if (file === 'sql-wasm.wasm') {
          return require.resolve('sql.js/dist/sql-wasm.wasm');
        }
        return file;
      },
    });

    const buffer = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
    db = new SQL.Database(buffer || undefined);

    console.log(`[db] SQLite database opened at ${DB_PATH}`);

    applySchema();
    seedDefaultSettings();
    save();

    return module.exports;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

function logRequest({ method, path: requestPath, status, ip, duration_ms, model, error, auth_type }) {
  runMutation(
    `
      INSERT INTO request_log (timestamp, method, path, status, ip, duration_ms, model, error, auth_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      new Date().toISOString(),
      method,
      requestPath,
      status,
      ip,
      duration_ms,
      model || null,
      error || null,
      auth_type || null,
    ]
  );
}

function getRecentRequests(limit, offset) {
  return getRows(
    `
      SELECT id, timestamp, method, path, status, ip, duration_ms, model, error, auth_type
      FROM request_log
      ORDER BY id DESC
      LIMIT ?
      OFFSET ?
    `,
    [limit || 200, offset || 0]
  );
}

function getRequestCount() {
  return (getRow('SELECT COUNT(*) AS count FROM request_log') || {}).count || 0;
}

function getSetting(key) {
  const row = getRow('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

function getAllSettings() {
  return getRows('SELECT key, value, updated_at FROM settings ORDER BY key');
}

function setSetting(key, value) {
  runMutation(
    `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
    [key, String(value)]
  );
}

function getStats(hours) {
  return getRows(
    `
      SELECT * FROM stats_hourly
      WHERE hour >= datetime('now', ? || ' hours')
      ORDER BY hour DESC
    `,
    ['-' + (hours || 24)]
  );
}

function getStatsSummary() {
  const allTime =
    getRow(`
      SELECT
        COUNT(*) AS total_requests,
        SUM(CASE WHEN path LIKE '%/embed%' THEN 1 ELSE 0 END) AS embed_requests,
        SUM(CASE WHEN path LIKE '%/chat%' THEN 1 ELSE 0 END) AS chat_requests,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS error_count,
        ROUND(AVG(duration_ms), 1) AS avg_duration_ms
      FROM request_log
    `) || {};
  const today =
    getRow(`
      SELECT
        COUNT(*) AS total_requests,
        SUM(CASE WHEN path LIKE '%/embed%' THEN 1 ELSE 0 END) AS embed_requests,
        SUM(CASE WHEN path LIKE '%/chat%' THEN 1 ELSE 0 END) AS chat_requests,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS error_count,
        ROUND(AVG(duration_ms), 1) AS avg_duration_ms
      FROM request_log
      WHERE timestamp >= date('now')
    `) || {};
  const moonshineLifetime = parseFloat(getSetting('moonshine_earned_lifetime') || '0');
  return { all_time: allTime, today: today, moonshine_earned_lifetime: moonshineLifetime };
}

function pruneOldLogs(days) {
  const keepDays = days || LOG_RETENTION_DAYS;
  const result = runMutation(
    `
      DELETE FROM request_log
      WHERE timestamp < datetime('now', ? || ' days')
    `,
    ['-' + keepDays]
  );
  if (result.changes > 0) {
    console.log(`[db] Pruned ${result.changes} log entries older than ${keepDays} days`);
  }
  return result.changes;
}

function rollupHourlyStats() {
  runMutation(`
    INSERT OR REPLACE INTO stats_hourly (hour, total_requests, embed_requests, chat_requests, error_count, avg_duration_ms, p95_duration_ms)
    SELECT
      strftime('%Y-%m-%dT%H', timestamp) AS hour,
      COUNT(*) AS total_requests,
      SUM(CASE WHEN path LIKE '%/embed%' THEN 1 ELSE 0 END) AS embed_requests,
      SUM(CASE WHEN path LIKE '%/chat%' THEN 1 ELSE 0 END) AS chat_requests,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS error_count,
      ROUND(AVG(duration_ms), 1) AS avg_duration_ms,
      0 AS p95_duration_ms
    FROM request_log
    WHERE strftime('%Y-%m-%dT%H', timestamp) = strftime('%Y-%m-%dT%H', 'now')
    GROUP BY hour
  `);
}

function getDbSize() {
  if (!fs.existsSync(DB_PATH)) return 0;
  return fs.statSync(DB_PATH).size;
}

function clearRequestLog() {
  const result = runMutation('DELETE FROM request_log');
  console.log(`[db] Cleared ${result.changes} log entries`);
  return result.changes;
}

function insertDocument(doc) {
  runMutation(
    `
      INSERT INTO documents (id, filename, original_name, file_hash, file_size, mime_type, collection, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [doc.id, doc.filename, doc.original_name, doc.file_hash, doc.file_size, doc.mime_type, doc.collection, doc.status]
  );
}

function getDocument(id) {
  return getRow('SELECT * FROM documents WHERE id = ?', [id]) || null;
}

function getAllDocuments() {
  return getRows('SELECT * FROM documents ORDER BY created_at DESC');
}

function getDocumentsByCollection(collection) {
  return getRows('SELECT * FROM documents WHERE collection = ? ORDER BY created_at DESC', [collection]);
}

function getDocumentByHash(hash, collection) {
  return getRow('SELECT * FROM documents WHERE file_hash = ? AND collection = ?', [hash, collection]) || null;
}

function updateDocumentStatus(id, status, error, chunkCount) {
  runMutation(
    `
      UPDATE documents SET status = ?, error = ?, chunk_count = ?, updated_at = datetime('now')
      WHERE id = ?
    `,
    [status, error || null, chunkCount || 0, id]
  );
}

function deleteDocument(id) {
  return runMutation('DELETE FROM documents WHERE id = ?', [id]);
}

function getModelMetadata(model) {
  return getRow('SELECT * FROM model_metadata WHERE model = ?', [model]) || null;
}

function upsertModelMetadata(model, metadata) {
  runMutation(
    `
      INSERT INTO model_metadata (model, parameters, context_window, max_output, quantization, family, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        parameters = excluded.parameters,
        context_window = excluded.context_window,
        max_output = excluded.max_output,
        quantization = excluded.quantization,
        family = excluded.family,
        updated_at = excluded.updated_at
    `,
    [
      model,
      metadata.parameters || null,
      metadata.context_window || null,
      metadata.max_output || null,
      metadata.quantization || null,
      metadata.family || null,
      Date.now(),
    ]
  );
}

function getAllModelPricing() {
  return getRows('SELECT * FROM model_pricing ORDER BY model');
}

function getModelPricing(model) {
  return getRow('SELECT * FROM model_pricing WHERE model = ?', [model]) || null;
}

function upsertModelPricing(model, inputPer1k, outputPer1k) {
  runMutation(
    `
      INSERT INTO model_pricing (model, moonshine_input_per_1k, moonshine_output_per_1k, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        moonshine_input_per_1k = excluded.moonshine_input_per_1k,
        moonshine_output_per_1k = excluded.moonshine_output_per_1k,
        updated_at = excluded.updated_at
    `,
    [model, inputPer1k, outputPer1k == null ? null : outputPer1k, Date.now()]
  );
}

function deleteModelPricing(model) {
  return runMutation('DELETE FROM model_pricing WHERE model = ?', [model]);
}

function upsertHfImport(repoId, filename, modelName) {
  runMutation(
    `
      INSERT INTO hf_imports (repo_id, filename, model_name, imported_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(repo_id, filename) DO UPDATE SET model_name = excluded.model_name, imported_at = excluded.imported_at
    `,
    [repoId, filename, modelName]
  );
}

function getHfImportsByRepo(repoId) {
  return getRows('SELECT * FROM hf_imports WHERE repo_id = ?', [repoId]);
}

function getAllHfImports() {
  return getRows('SELECT * FROM hf_imports ORDER BY imported_at DESC');
}

function deleteHfImport(repoId, filename) {
  return runMutation('DELETE FROM hf_imports WHERE repo_id = ? AND filename = ?', [repoId, filename]);
}

function runSql(sql, params) {
  return runMutation(sql, params);
}

function getSql(sql, params) {
  return getRow(sql, params);
}

function allSql(sql, params) {
  return getRows(sql, params);
}

function getRateLimit(key) {
  return getRow('SELECT window_start, request_count FROM rate_limits WHERE key = ?', [key]) || null;
}

function upsertRateLimit(key, windowStart, requestCount) {
  runMutation(
    `
      INSERT INTO rate_limits (key, window_start, request_count)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, request_count = excluded.request_count
    `,
    [key, windowStart, requestCount]
  );
}

function purgeExpiredRateLimits(beforeTimestamp) {
  return runMutation('DELETE FROM rate_limits WHERE window_start < ?', [beforeTimestamp]);
}

function close() {
  if (!db) return;
  save();
  db.close();
  db = null;
  SQL = null;
  console.log('[db] Database closed');
}

module.exports = {
  init,
  save,
  execSql,
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
  upsertHfImport,
  getHfImportsByRepo,
  getAllHfImports,
  deleteHfImport,
  runSql,
  getSql,
  allSql,
  getRateLimit,
  upsertRateLimit,
  purgeExpiredRateLimits,
  close,
};

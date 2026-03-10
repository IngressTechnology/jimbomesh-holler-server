const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '.test-holler.db');

describe('db', function () {
  let db;

  before(async function () {
    // Point at a throwaway database for testing
    process.env.SQLITE_DB_PATH = TEST_DB_PATH;
    // Prevent default model pulls during test
    process.env.HOLLER_MODELS = '';
    db = require('../db');
    await db.init();
  });

  after(function () {
    db.close();
    try {
      fs.unlinkSync(TEST_DB_PATH);
    } catch (_) {
      /* intentionally empty */
    }
    try {
      fs.unlinkSync(TEST_DB_PATH + '-wal');
    } catch (_) {
      /* intentionally empty */
    }
    try {
      fs.unlinkSync(TEST_DB_PATH + '-shm');
    } catch (_) {
      /* intentionally empty */
    }
  });

  describe('settings', function () {
    it('getSetting returns seeded values', function () {
      const port = db.getSetting('gateway_port');
      assert.equal(port, '1920');
    });

    it('setSetting + getSetting round-trips', function () {
      db.setSetting('test_key', 'test_value');
      assert.equal(db.getSetting('test_key'), 'test_value');
    });

    it('getAllSettings returns an array', function () {
      const all = db.getAllSettings();
      assert.ok(Array.isArray(all));
      assert.ok(all.length > 0);
    });
  });

  describe('request log', function () {
    it('logRequest inserts and getRecentRequests returns it', function () {
      db.logRequest({
        method: 'POST',
        path: '/v1/embeddings',
        status: 200,
        ip: '127.0.0.1',
        duration_ms: 42,
        model: 'nomic-embed-text',
        error: null,
        auth_type: 'api_key',
      });

      const recent = db.getRecentRequests(1, 0);
      assert.equal(recent.length, 1);
      assert.equal(recent[0].method, 'POST');
      assert.equal(recent[0].path, '/v1/embeddings');
      assert.equal(recent[0].status, 200);
      assert.equal(recent[0].auth_type, 'api_key');
    });

    it('getRequestCount returns correct count', function () {
      const count = db.getRequestCount();
      assert.ok(count >= 1);
    });

    it('clearRequestLog empties the log', function () {
      db.clearRequestLog();
      assert.equal(db.getRequestCount(), 0);
    });
  });

  describe('stats', function () {
    it('getStatsSummary returns structured data', function () {
      const summary = db.getStatsSummary();
      assert.ok(summary.all_time);
      assert.ok(summary.today);
      assert.equal(typeof summary.all_time.total_requests, 'number');
    });

    it('rollupHourlyStats runs without error', function () {
      assert.doesNotThrow(function () {
        db.rollupHourlyStats();
      });
    });

    it('getDbSize returns a number', function () {
      const size = db.getDbSize();
      assert.equal(typeof size, 'number');
      assert.ok(size > 0);
    });
  });

  describe('rate limits', function () {
    it('upsertRateLimit + getRateLimit round-trips', function () {
      const now = Date.now();
      db.upsertRateLimit('test-ip', now, 5);
      const rl = db.getRateLimit('test-ip');
      assert.ok(rl);
      assert.equal(rl.request_count, 5);
    });

    it('purgeExpiredRateLimits removes old entries', function () {
      db.upsertRateLimit('old-ip', 1000, 1);
      db.purgeExpiredRateLimits(Date.now());
      const rl = db.getRateLimit('old-ip');
      assert.equal(rl, null);
    });
  });

  describe('documents', function () {
    it('insertDocument + getDocument round-trips', function () {
      db.insertDocument({
        id: 'test-doc-1',
        filename: 'test.txt',
        original_name: 'test.txt',
        file_hash: 'abc123',
        file_size: 100,
        mime_type: 'text/plain',
        collection: 'test-collection',
        status: 'pending',
      });

      const doc = db.getDocument('test-doc-1');
      assert.ok(doc);
      assert.equal(doc.filename, 'test.txt');
      assert.equal(doc.status, 'pending');
    });

    it('updateDocumentStatus changes the status', function () {
      db.updateDocumentStatus('test-doc-1', 'ready', null, 5);
      const doc = db.getDocument('test-doc-1');
      assert.equal(doc.status, 'ready');
      assert.equal(doc.chunk_count, 5);
    });

    it('getDocumentByHash finds by hash+collection', function () {
      const doc = db.getDocumentByHash('abc123', 'test-collection');
      assert.ok(doc);
      assert.equal(doc.id, 'test-doc-1');
    });

    it('deleteDocument removes the document', function () {
      db.deleteDocument('test-doc-1');
      assert.equal(db.getDocument('test-doc-1'), null);
    });
  });

  describe('runSql / getSql / allSql', function () {
    it('runSql executes arbitrary SQL', function () {
      const result = db.runSql(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ['run_sql_test', 'works']
      );
      assert.ok(result);
    });

    it('getSql returns a single row', function () {
      const row = db.getSql('SELECT value FROM settings WHERE key = ?', ['run_sql_test']);
      assert.ok(row);
      assert.equal(row.value, 'works');
    });

    it('allSql returns multiple rows', function () {
      const rows = db.allSql('SELECT key, value FROM settings WHERE key = ?', ['run_sql_test']);
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, 1);
    });
  });
});

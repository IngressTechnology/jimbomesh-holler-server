const http = require('http');
const crypto = require('crypto');
const db = require('./db');

const REQUEST_RETENTION_DAYS = 7;
const OLLAMA_URL = process.env.OLLAMA_INTERNAL_URL || 'http://127.0.0.1:11435';

class StatsCollector {
  constructor(dbLayer) {
    this.db = dbLayer;
    this.modelInfoCache = new Map();
  }

  startRequest(requestId, model) {
    return {
      requestId: requestId || crypto.randomUUID(),
      model: model || 'unknown',
      startTime: Date.now(),
      firstTokenTime: null,
      endTime: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      status: 'pending',
      error: null,
      isToolCall: false,
      connectionType: null,
    };
  }

  onFirstToken(request) {
    if (!request || request.firstTokenTime) return;
    request.firstTokenTime = Date.now();
    request.status = 'streaming';
  }

  async completeRequest(request, result) {
    request.endTime = Date.now();
    request.status = 'complete';
    request.inputTokens = result && result.prompt_eval_count ? result.prompt_eval_count : 0;
    request.outputTokens = result && result.eval_count ? result.eval_count : 0;
    request.totalTokens = request.inputTokens + request.outputTokens;
    request.isToolCall = !!(result && result.isToolCall);
    await this.recordRequest(request);
  }

  async failRequest(request, error) {
    request.endTime = Date.now();
    request.status = 'error';
    request.error = (error && error.message) ? error.message : 'Unknown error';
    await this.recordRequest(request);
  }

  async recordRequest(request) {
    const e2eLatencyMs = request.endTime - request.startTime;
    const ttftMs = request.firstTokenTime ? (request.firstTokenTime - request.startTime) : null;
    const durationMs = request.firstTokenTime ? (request.endTime - request.firstTokenTime) : e2eLatencyMs;
    const tokensPerSecond = request.outputTokens > 0 && durationMs > 0
      ? (request.outputTokens / (durationMs / 1000))
      : 0;

    this.db.runSql(`
      INSERT INTO request_stats (
        request_id, model, started_at, ended_at,
        input_tokens, output_tokens, total_tokens,
        e2e_latency_ms, ttft_ms, generation_duration_ms,
        tokens_per_second, status, error_message, is_tool_call,
        connection_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      request.requestId,
      request.model,
      request.startTime,
      request.endTime,
      request.inputTokens,
      request.outputTokens,
      request.totalTokens,
      e2eLatencyMs,
      ttftMs,
      durationMs,
      tokensPerSecond,
      request.status,
      request.error,
      request.isToolCall ? 1 : 0,
      request.connectionType || null,
    ]);

    if (request.model && request.model !== 'unknown') {
      this.ensureModelMetadata(request.model).catch(function () {});
      this.ensureModelPricing(request.model).catch(function () {});
    }
  }

  async getModelStats(since) {
    const whereClause = since ? 'WHERE rs.started_at >= ?' : '';
    const params = since ? [since] : [];

    return this.db.allSql(`
      SELECT
        rs.model as model,
        COUNT(*) as total_requests,
        COUNT(CASE WHEN rs.status = 'complete' THEN 1 END) as successful_requests,
        COUNT(CASE WHEN rs.status = 'error' THEN 1 END) as failed_requests,
        COUNT(CASE WHEN rs.is_tool_call = 1 THEN 1 END) as tool_call_requests,
        SUM(rs.input_tokens) as total_input_tokens,
        SUM(rs.output_tokens) as total_output_tokens,
        SUM(rs.total_tokens) as total_tokens,
        AVG(CASE WHEN rs.status = 'complete' AND rs.tokens_per_second > 0 THEN rs.tokens_per_second END) as avg_tokens_per_second,
        MIN(CASE WHEN rs.status = 'complete' AND rs.tokens_per_second > 0 THEN rs.tokens_per_second END) as min_tokens_per_second,
        MAX(CASE WHEN rs.status = 'complete' AND rs.tokens_per_second > 0 THEN rs.tokens_per_second END) as max_tokens_per_second,
        AVG(CASE WHEN rs.status = 'complete' THEN rs.e2e_latency_ms END) as avg_e2e_latency_ms,
        MIN(CASE WHEN rs.status = 'complete' THEN rs.e2e_latency_ms END) as min_e2e_latency_ms,
        MAX(CASE WHEN rs.status = 'complete' THEN rs.e2e_latency_ms END) as max_e2e_latency_ms,
        AVG(CASE WHEN rs.status = 'complete' AND rs.ttft_ms IS NOT NULL THEN rs.ttft_ms END) as avg_ttft_ms,
        MIN(CASE WHEN rs.status = 'complete' AND rs.ttft_ms IS NOT NULL THEN rs.ttft_ms END) as min_ttft_ms,
        ROUND(CAST(COUNT(CASE WHEN rs.status = 'error' THEN 1 END) AS REAL) / NULLIF(COUNT(*), 0) * 100, 2) as error_rate_percent,
        ROUND(CAST(COUNT(CASE WHEN rs.is_tool_call = 1 AND rs.status = 'error' THEN 1 END) AS REAL) / NULLIF(COUNT(CASE WHEN rs.is_tool_call = 1 THEN 1 END), 0) * 100, 2) as tool_call_error_rate_percent,
        MIN(rs.started_at) as first_seen,
        MAX(rs.ended_at) as last_seen,
        AVG(CASE WHEN rs.status = 'complete' THEN rs.generation_duration_ms END) as avg_generation_ms,
        mm.parameters as parameters,
        mm.context_window as context_window,
        mm.max_output as max_output,
        mm.quantization as quantization,
        mm.family as family,
        mp.moonshine_input_per_1k as moonshine_input_per_1k,
        mp.moonshine_output_per_1k as moonshine_output_per_1k
      FROM request_stats rs
      LEFT JOIN model_metadata mm ON mm.model = rs.model
      LEFT JOIN model_pricing mp ON mp.model = rs.model
      ${whereClause}
      GROUP BY rs.model
      ORDER BY total_requests DESC
    `, params);
  }

  async getModelDetail(model, since) {
    const stats = await this.getModelStats(since);
    const row = stats.find(function (s) { return s.model === model; }) || null;
    if (row) {
      await this.ensureModelMetadata(model);
      await this.ensureModelPricing(model);
    }
    return row;
  }

  async getRecentRequests(model, limit) {
    const max = Math.max(1, Math.min(parseInt(limit || '50', 10), 500));
    const whereClause = model ? 'WHERE model = ?' : '';
    const params = model ? [model, max] : [max];
    return this.db.allSql(`
      SELECT * FROM request_stats
      ${whereClause}
      ORDER BY started_at DESC
      LIMIT ?
    `, params);
  }

  async getHourlyStats(model) {
    const since = Date.now() - (24 * 60 * 60 * 1000);
    const whereClause = model ? 'WHERE model = ? AND started_at >= ?' : 'WHERE started_at >= ?';
    const params = model ? [model, since] : [since];
    return this.db.allSql(`
      SELECT
        ((started_at / 3600000) * 3600000) as hour_bucket,
        COUNT(*) as requests,
        AVG(CASE WHEN status = 'complete' THEN tokens_per_second END) as avg_tps,
        AVG(CASE WHEN status = 'complete' THEN e2e_latency_ms END) as avg_latency_ms,
        AVG(CASE WHEN status = 'complete' AND ttft_ms IS NOT NULL THEN ttft_ms END) as avg_ttft_ms,
        SUM(total_tokens) as total_tokens,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as errors,
        ROUND(CAST(COUNT(CASE WHEN status = 'error' THEN 1 END) AS REAL) / NULLIF(COUNT(*), 0) * 100, 2) as error_rate,
        COUNT(CASE WHEN is_tool_call = 1 AND status = 'error' THEN 1 END) as tool_call_errors
      FROM request_stats
      ${whereClause}
      GROUP BY hour_bucket
      ORDER BY hour_bucket
    `, params);
  }

  async resetStats(model) {
    if (model) {
      this.db.runSql('DELETE FROM request_stats WHERE model = ?', [model]);
    } else {
      this.db.runSql('DELETE FROM request_stats');
    }
    return { reset: true, model: model || 'all' };
  }

  async getGlobalSummary(since) {
    const whereClause = since ? 'WHERE started_at >= ?' : '';
    const params = since ? [since] : [];
    return this.db.getSql(`
      SELECT
        COUNT(DISTINCT model) as active_models,
        COUNT(*) as total_requests,
        SUM(total_tokens) as total_tokens_processed,
        SUM(output_tokens) as total_output_tokens,
        AVG(CASE WHEN status = 'complete' THEN tokens_per_second END) as avg_tps_global,
        AVG(CASE WHEN status = 'complete' THEN e2e_latency_ms END) as avg_latency_global,
        ROUND(CAST(COUNT(CASE WHEN status = 'error' THEN 1 END) AS REAL) / NULLIF(COUNT(*), 0) * 100, 2) as error_rate_global,
        MIN(started_at) as tracking_since
      FROM request_stats
      ${whereClause}
    `, params) || {};
  }

  async pruneOldRequestStats(days) {
    const keepDays = Number.isFinite(days) ? days : REQUEST_RETENTION_DAYS;
    const cutoff = Date.now() - (keepDays * 24 * 60 * 60 * 1000);
    return this.db.runSql('DELETE FROM request_stats WHERE started_at < ?', [cutoff]).changes;
  }

  async getModelPricing() {
    return this.db.getAllModelPricing();
  }

  async setModelPricing(model, inputPer1k, outputPer1k) {
    this.db.upsertModelPricing(model, inputPer1k, outputPer1k);
    return this.db.getModelPricing(model);
  }

  async ensureModelPricing(model) {
    const existing = this.db.getModelPricing(model);
    if (existing) return existing;

    const metadata = this.db.getModelMetadata(model) || await this.ensureModelMetadata(model);
    const defaults = this.getDefaultMoonshinePricing(model, metadata);
    this.db.upsertModelPricing(model, defaults.input, defaults.output);
    return this.db.getModelPricing(model);
  }

  async ensureModelMetadata(model) {
    if (!model) return null;
    const cached = this.modelInfoCache.get(model);
    if (cached && (Date.now() - cached.cachedAt) < 15 * 60 * 1000) return cached.data;

    const fromDb = this.db.getModelMetadata(model);
    if (fromDb) {
      this.modelInfoCache.set(model, { cachedAt: Date.now(), data: fromDb });
      return fromDb;
    }

    const remote = await this.fetchModelMetadataFromOllama(model).catch(function () { return null; });
    if (!remote) return null;
    this.db.upsertModelMetadata(model, remote);
    const merged = this.db.getModelMetadata(model);
    this.modelInfoCache.set(model, { cachedAt: Date.now(), data: merged });
    return merged;
  }

  getDefaultMoonshinePricing(model, metadata) {
    const lower = String(model || '').toLowerCase();
    if (lower.includes('embed') || lower.includes('nomic')) {
      return { input: 0.1, output: null };
    }

    const paramsText = (metadata && metadata.parameters) ? String(metadata.parameters).toUpperCase() : '';
    const sizeB = this.parseParamBillions(paramsText);
    if (sizeB == null) return { input: 1, output: 1 };
    if (sizeB < 3) return { input: 0.25, output: 0.25 };
    if (sizeB < 8) return { input: 0.5, output: 1.0 };
    if (sizeB < 14) return { input: 1.0, output: 2.0 };
    if (sizeB < 34) return { input: 2.0, output: 4.0 };
    if (sizeB < 70) return { input: 5.0, output: 10.0 };
    return { input: 5.0, output: 10.0 };
  }

  parseParamBillions(paramsText) {
    if (!paramsText) return null;
    const m = paramsText.match(/(\d+(?:\.\d+)?)\s*B/i);
    if (!m) return null;
    return parseFloat(m[1]);
  }

  fetchModelMetadataFromOllama(model) {
    return new Promise(function (resolve, reject) {
      const parsed = new URL(OLLAMA_URL);
      const body = JSON.stringify({ name: model });
      const req = http.request({
        hostname: parsed.hostname,
        port: parseInt(parsed.port, 10) || 11435,
        path: '/api/show',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      }, function (res) {
        let data = '';
        res.on('data', function (chunk) { data += chunk; });
        res.on('end', function () {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error('show failed: ' + res.statusCode));
            return;
          }
          try {
            const parsedBody = JSON.parse(data);
            const details = parsedBody.details || {};
            resolve({
              parameters: details.parameter_size || parsedBody.parameters || null,
              context_window: details.context_length || parsedBody.context_length || null,
              max_output: parsedBody.max_output || 8192,
              quantization: details.quantization_level || parsedBody.quantization || null,
              family: details.family || parsedBody.family || null,
            });
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('timeout', function () {
        req.destroy(new Error('Timeout fetching model metadata'));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

const statsCollector = new StatsCollector(db);
statsCollector.pruneOldRequestStats(REQUEST_RETENTION_DAYS).catch(function () {});

module.exports = statsCollector;

/**
 * Mesh Connector — JimboMesh SaaS Integration
 *
 * Connects this Holler to the JimboMesh mesh network.
 * ALL connections are outbound HTTPS from the Holler.
 * SaaS never connects inbound — works behind any NAT/firewall.
 *
 * Modes:
 *   Off-grid (default)  — standalone, no mesh, no telemetry
 *   Mesh Contributor     — registers, heartbeats, polls for jobs, earns Moonshine
 */

const http = require('http');
const https = require('https');
const os = require('os');
const { execSync } = require('child_process');
const stats = require('./stats-collector');
const db = require('./db');
const { inferMeshRequestPath } = require('./mesh-utils');

// ── Helpers ───────────────────────────────────────────────────────

function maskKey(key) {
  if (!key || key.length < 12) return '****';
  return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
}

function log(msg) {
  console.log('[mesh] ' + msg);
}

function hasToolCallsInMessage(message) {
  return !!(message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
}

/**
 * Extract model family from model name.
 * "llama3.2:1b" -> "llama", "mistral:7b" -> "mistral".
 */
function extractModelFamily(modelName) {
  if (!modelName) return 'unknown';
  const name = String(modelName).toLowerCase();
  const families = [
    'llama',
    'mistral',
    'mixtral',
    'gemma',
    'phi',
    'qwen',
    'codellama',
    'deepseek',
    'nomic',
    'mxbai',
    'snowflake',
    'all-minilm',
    'starcoder',
    'vicuna',
    'orca',
    'neural-chat',
    'stablelm',
    'tinyllama',
    'dolphin',
    'wizardcoder',
    'falcon',
    'yi',
    'solar',
    'command-r',
  ];
  for (const family of families) {
    if (name.startsWith(family) || name.includes(family)) return family;
  }
  return name.split(/[:\-\d]/)[0] || 'unknown';
}

/**
 * Estimate parameter count from model tag.
 * "llama3.2:1b" -> 1000000000, "mistral:7b" -> 7000000000.
 */
function estimateParameters(modelName) {
  if (!modelName) return 0;
  const match = String(modelName).match(/(\d+(?:\.\d+)?)\s*[bB]/);
  if (match) return Math.round(parseFloat(match[1]) * 1e9);
  return 0;
}

function parseParameterCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (!value) return 0;
  const str = String(value).trim();
  const num = parseFloat(str);
  if (!Number.isFinite(num)) return 0;
  if (/[bB]/.test(str)) return Math.round(num * 1e9);
  if (/[mM]/.test(str)) return Math.round(num * 1e6);
  return Math.round(num);
}

function mapModelsForSaas(models) {
  return (models || []).map(function (m) {
    const modelName = m.name || m.model || '';
    return {
      modelName: modelName,
      modelFamily: (m.details && m.details.family) || extractModelFamily(modelName),
      parameterCount:
        parseParameterCount(m.parameter_size || m.parameters || (m.details && m.details.parameter_size)) ||
        estimateParameters(modelName),
      sizeBytes: m.size || 0,
      available: true,
    };
  });
}

const BACKOFF_SCHEDULE = [5000, 10000, 30000, 60000, 300000]; // 5s → 5min

// Cached Ollama model list — shared across all connector instances
let _modelCache = { models: [], timestamp: 0 };
const MODEL_CACHE_TTL = 30000; // 30s
const MGMT_WS_BASE_DELAY_MS = 1000;
const MGMT_WS_MAX_DELAY_MS = 60000;
const MGMT_WS_STABLE_MS = 300000;
const MGMT_WS_HEARTBEAT_STALE_MS = 90000;

// ── MeshConnector ─────────────────────────────────────────────────

class MeshConnector {
  constructor(config) {
    this.meshUrl = (config.meshUrl || 'https://api.jimbomesh.ai').replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.ollamaUrl = config.ollamaUrl || 'http://127.0.0.1:11435';
    this.hollerEndpoint = config.hollerEndpoint || process.env.JIMBOMESH_HOLLER_ENDPOINT || 'http://127.0.0.1:11435';
    this.db = config.db || null;
    this.version = config.version || '0.0.0';
    this.getConcurrencyStats = typeof config.getConcurrencyStats === 'function' ? config.getConcurrencyStats : null;

    this.hollerName = config.hollerName || null;

    // State (memory only — never persisted)
    this._state = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting'
    this.errorMessage = null;
    this.hollerId = null;
    this.lastHeartbeat = null;
    this.jobsProcessed = 0;
    this.moonshineEarned = 0;
    this.moonshineLifetime = parseFloat(db.getSetting('moonshine_earned_lifetime') || '0');
    this.heartbeatFailures = 0;
    this.startedAt = null;

    // Status log — in-memory circular buffer (ephemeral, not persisted)
    this._log = [];
    this._logMax = 50;

    // WebRTC peer handler (lazy-loaded after registration)
    this.peerHandler = null;

    // Expose stats module for WebRTC sessions
    this._stats = stats;

    // Management WebSocket (real-time job push from SaaS)
    this._mgmtWs = null;
    this._mgmtWsRetries = 0;
    this._mgmtReconnectAttempt = 0;
    this._mgmtNextRetryAt = null;
    this._mgmtPingInterval = null;
    this._mgmtPongTimeout = null;
    this._mgmtStableTimer = null;
    this._mgmtWsRetryTimeout = null;
    this._mgmtWsDisconnectedAt = null;
    this._mgmtWsPongReceived = false;
    this._mgmtLastHeartbeatAck = 0;
    this.connectionMode = 'HTTP Polling';

    // Job dedup — prevent double-processing from WS + poll overlap
    this._processedJobs = new Set();

    // Intervals
    this._heartbeatInterval = null;
    this._pollInterval = null;
    this._retryTimeout = null;
    this._retryIndex = 0;
    this._stopped = false;
    this._aborted = false;
    this._processing = false; // guard against overlapping job polls
  }

  // Backward-compat getters so mesh-webrtc.js and other code still works
  get connected() {
    return this._state === 'connected';
  }
  get connecting() {
    return this._state === 'connecting' || this._state === 'reconnecting';
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Start the mesh connector: register, then begin heartbeat + job polling.
   * Non-blocking — errors are logged, not thrown.
   */
  async start() {
    this._stopped = false;
    this._aborted = false;
    this._state = 'connecting';
    this.errorMessage = null;
    this._addLog('info', 'Initializing mesh connection...');
    this._addLog('info', 'Coordinator: ' + this.meshUrl);
    this._addLog('info', 'Authenticating with API key (' + maskKey(this.apiKey) + ')');

    try {
      await this._registerWithRetry();
    } catch (err) {
      if (this._aborted) return;
      this._state = 'error';
      this.errorMessage = err.message;
      this._addLog('error', 'Registration failed: ' + err.message);
      if (err && err.noRetry) {
        return;
      }
      this._scheduleRetry();
    }
  }

  /**
   * Cancel an in-progress connection attempt.
   */
  cancel() {
    this._aborted = true;
    this._clearTimers();
    this._clearMgmtTimers();
    if (this._mgmtWs) {
      try {
        this._mgmtWs.close();
      } catch (_e) {
        /* intentionally empty */
      }
      this._mgmtWs = null;
    }
    this._mgmtReconnectAttempt = 0;
    this._mgmtNextRetryAt = null;
    this.connectionMode = 'HTTP Polling';
    this._state = 'disconnected';
    this.errorMessage = null;
    this._addLog('info', 'Connection cancelled');
  }

  /**
   * Add a timestamped entry to the status log buffer.
   * @param {'info'|'success'|'error'|'warning'} type
   * @param {string} message
   */
  _addLog(type, message) {
    this._log.push({ time: Date.now(), type: type, message: message });
    if (this._log.length > this._logMax) this._log.shift();
    log(message);
  }

  /**
   * Stop the mesh connector: clear intervals, send offline heartbeat.
   * Does NOT call process.exit() — the Holler server keeps running standalone.
   */
  async stop() {
    this._stopped = true;
    this._clearTimers();
    this._clearMgmtTimers();

    // Close management WebSocket gracefully
    if (this._mgmtWs) {
      try {
        this._mgmtWs.close(1000, 'Disconnecting');
      } catch (_e) {
        /* intentionally empty */
      }
      this._mgmtWs = null;
    }
    this._mgmtReconnectAttempt = 0;
    this._mgmtNextRetryAt = null;
    this.connectionMode = 'HTTP Polling';

    // Close all WebRTC peer connections
    if (this.peerHandler) {
      try {
        await this.peerHandler.closeAll();
      } catch (_) {
        /* intentionally empty */
      }
    }

    // Best-effort offline heartbeat
    if (this._state === 'connected' && this.apiKey) {
      try {
        await this._sendHeartbeat();
        this._addLog('info', 'Sent offline heartbeat');
      } catch {
        /* best-effort */
      }
    }

    this._state = 'disconnected';
    this.errorMessage = null;
    this._addLog('info', 'Disconnected from mesh — running standalone');
  }

  /**
   * Return current mesh status for admin UI.
   */
  getStatus() {
    const modeMap = {
      connected: 'mesh-contributor',
      connecting: 'connecting',
      reconnecting: 'connecting',
      error: 'off-grid',
      disconnected: 'off-grid',
    };
    const status = {
      state: this._state,
      connected: this._state === 'connected',
      connecting: this._state === 'connecting' || this._state === 'reconnecting',
      meshUrl: this.meshUrl,
      hollerId: this.hollerId,
      hollerName:
        this.hollerName ||
        (this.db
          ? this.db.getSetting('holler_name') ||
            this.db.getSetting('server_name') ||
            process.env.JIMBOMESH_HOLLER_NAME ||
            process.env.HOLLER_SERVER_NAME ||
            null
          : process.env.JIMBOMESH_HOLLER_NAME || process.env.HOLLER_SERVER_NAME || null) ||
        os.hostname(),
      lastHeartbeat: this.lastHeartbeat,
      jobsProcessed: this.jobsProcessed,
      moonshineEarned: this.moonshineEarned,
      errorMessage: this.errorMessage,
      mode: modeMap[this._state] || 'off-grid',
      connectionMode: this.connectionMode,
      reconnectAttempt: this._mgmtReconnectAttempt || 0,
      nextReconnectAt: this._mgmtNextRetryAt,
      log: this._log.slice(),
    };
    if (this.peerHandler) {
      status.peerConnections = this.peerHandler.getStatus();
    }
    return status;
  }

  // ── WebRTC Peer Handler ────────────────────────────────────────

  _initPeerHandler() {
    if (this.peerHandler) return;
    try {
      const HollerPeerHandler = require('./mesh-webrtc').HollerPeerHandler;
      this.peerHandler = new HollerPeerHandler(this);
      this._addLog('info', 'WebRTC peer handler initialized');
      this._addLog('info', 'WebRTC peer handler ready — will attempt P2P for incoming jobs');
    } catch (err) {
      this._addLog('warning', 'WebRTC not available (wrtc not installed): ' + err.message);
    }
  }

  // ── Management WebSocket ─────────────────────────────────────────

  /**
   * Open a persistent WebSocket to the SaaS for real-time job push.
   * Reconnects with exponential backoff on close (max 60s).
   * If down > 5 min, triggers full re-registration.
   * HTTP polling stays active as belt-and-suspenders fallback.
   */
  _connectManagementWebSocket() {
    if (this._stopped || this._aborted) return;
    this._mgmtNextRetryAt = null;
    if (this._mgmtWs) {
      try {
        this._mgmtWs.close();
      } catch (_e) {
        /* intentionally empty */
      }
    }
    this._clearMgmtTimers();

    const meshUrl = this.meshUrl.replace(/\/+$/, '');
    const wsUrl =
      meshUrl.replace(/^http/, 'ws') +
      '/ws/holler' +
      '?token=' +
      encodeURIComponent(this.apiKey) +
      '&holler_id=' +
      encodeURIComponent(this.hollerId);

    const connectAttempt = Math.max(1, this._mgmtReconnectAttempt || 1);
    this._addLog('info', 'Connecting to ' + wsUrl + ' (attempt ' + connectAttempt + ')');

    try {
      const ws = new WebSocket(wsUrl);

      ws.addEventListener('open', () => {
        this._addLog('success', 'Connected to mesh (attempt ' + connectAttempt + ')');
        this._mgmtWsRetries = 0;
        this._mgmtReconnectAttempt = 0;
        this._mgmtNextRetryAt = null;
        this._mgmtWsDisconnectedAt = null;
        this._mgmtLastHeartbeatAck = Date.now();
        this._mgmtWs = ws;
        if (this._state === 'reconnecting') this._state = 'connected';
        this.errorMessage = null;
        this.connectionMode = 'WebSocket';
        this._startMgmtPing();
        this._mgmtStableTimer = setTimeout(() => {
          if (!this._stopped && !this._aborted && this._mgmtWs && this._mgmtWs.readyState === 1) {
            this._mgmtWsRetries = 0;
            this._mgmtReconnectAttempt = 0;
            this._addLog('info', 'Connection stable for 300s, resetting backoff');
          }
        }, MGMT_WS_STABLE_MS);
      });

      ws.addEventListener('message', (event) => {
        try {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          this._handleMgmtMessage(data).catch((err) => {
            console.error('[mesh-connector] Management WS message handler error:', err);
            try {
              this._addLog('error', 'Message handler error: ' + ((err && err.message) || String(err)));
            } catch (_) {
              /* intentionally empty */
            }
          });
        } catch (err) {
          console.error('[mesh-connector] Management WS message handler sync error:', err);
        }
      });

      ws.addEventListener('close', (event) => {
        const closeReason = event.reason ? String(event.reason) : 'none';
        this._addLog('warning', 'WebSocket closed: code=' + event.code + ', reason=' + closeReason);
        this._mgmtWs = null;
        this.connectionMode = 'HTTP Polling';
        this._clearMgmtTimers();

        if (!this._stopped && !this._aborted && (this._state === 'connected' || this._state === 'reconnecting')) {
          this._state = 'reconnecting';
          if (!this._mgmtWsDisconnectedAt) this._mgmtWsDisconnectedAt = Date.now();

          // If management WS has been down > 5 min, do full re-registration
          if (Date.now() - this._mgmtWsDisconnectedAt > 5 * 60 * 1000) {
            this._addLog('warning', 'Management WebSocket down >5min — full reconnect');
            this._state = 'reconnecting';
            this._clearTimers();
            this._scheduleRetry();
            return;
          }

          this._scheduleMgmtWsReconnect();
        }
      });

      ws.addEventListener('error', (err) => {
        this._addLog('warning', 'WebSocket error: ' + (err.message || 'unknown'));
      });
    } catch (err) {
      this._addLog('error', 'Failed to create management WebSocket: ' + err.message);
    }
  }

  /**
   * Schedule a management WebSocket reconnect with exponential backoff.
   */
  _scheduleMgmtWsReconnect() {
    const baseDelay = Math.min(MGMT_WS_BASE_DELAY_MS * Math.pow(2, this._mgmtWsRetries), MGMT_WS_MAX_DELAY_MS);
    const jitter = Math.random() * baseDelay * 0.3;
    const delay = Math.round(baseDelay + jitter);
    const attempt = this._mgmtWsRetries + 1;
    this._mgmtReconnectAttempt = attempt;
    this._mgmtNextRetryAt = Date.now() + delay;
    this._mgmtWsRetries++;
    this._addLog('info', 'Reconnecting in ' + Math.round(delay / 1000) + 's (attempt ' + attempt + ')');

    this._mgmtWsRetryTimeout = setTimeout(() => {
      if (
        !this._stopped &&
        !this._aborted &&
        (this._state === 'connected' || this._state === 'reconnecting' || this._state === 'connecting')
      ) {
        this._connectManagementWebSocket();
      }
    }, delay);
  }

  /**
   * Start ping/pong keepalive for the management WebSocket.
   * Sends a ping every 25s, expects a pong within 10s.
   */
  _startMgmtPing() {
    this._clearMgmtTimers();

    this._mgmtPingInterval = setInterval(() => {
      if (this._mgmtWs && this._mgmtWs.readyState === 1 /* OPEN */) {
        this._mgmtWsPongReceived = false;
        try {
          this._mgmtWs.send(JSON.stringify({ type: 'ping' }));
        } catch (_e) {
          try {
            this._mgmtWs.close();
          } catch (_) {
            /* intentionally empty */
          }
          return;
        }

        if (this._mgmtPongTimeout) {
          clearTimeout(this._mgmtPongTimeout);
          this._mgmtPongTimeout = null;
        }
        this._mgmtPongTimeout = setTimeout(() => {
          if (!this._mgmtWsPongReceived && this._mgmtWs) {
            this._addLog('warning', 'Pong timeout — reconnecting management WebSocket');
            try {
              this._mgmtWs.close();
            } catch (_e) {
              /* intentionally empty */
            }
          }
        }, 10000);
      }
    }, 25000);
  }

  /**
   * Clear management WebSocket specific timers (ping interval, pong timeout, retry).
   */
  _clearMgmtTimers() {
    if (this._mgmtPingInterval) {
      clearInterval(this._mgmtPingInterval);
      this._mgmtPingInterval = null;
    }
    if (this._mgmtPongTimeout) {
      clearTimeout(this._mgmtPongTimeout);
      this._mgmtPongTimeout = null;
    }
    if (this._mgmtWsRetryTimeout) {
      clearTimeout(this._mgmtWsRetryTimeout);
      this._mgmtWsRetryTimeout = null;
    }
    if (this._mgmtStableTimer) {
      clearTimeout(this._mgmtStableTimer);
      this._mgmtStableTimer = null;
    }
  }

  /**
   * Handle incoming messages on the management WebSocket.
   * Primary channel: job_assignment with signaling + ICE data.
   * Also handles fallback_inference for SSE relay when WebRTC ICE fails.
   */
  async _handleMgmtMessage(data) {
    try {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString());

      if (msg.type === 'job_assignment') {
        const jobId = msg.job_id || msg.jobId;

        // Dedup — may also arrive via HTTP poll
        if (this._processedJobs.has(jobId)) return;
        this._processedJobs.add(jobId);
        this._trimProcessedJobs();

        this._addLog('info', 'Job received via WebSocket: ' + jobId);

        const jobData = {
          job_id: jobId,
          model: msg.model,
          messages: msg.messages || [],
          parameters: {
            temperature: msg.temperature,
            max_tokens: msg.max_tokens,
          },
          signaling_url: msg.signaling_url || this._buildSignalingUrl(jobId),
          ice_servers: msg.ice_servers || [{ urls: 'stun:stun.l.google.com:19302' }],
        };

        await this._handleMeshJob(jobData, 'websocket');
      } else if (msg.type === 'fallback_inference') {
        this._handleFallbackInference(msg).catch((err) => {
          try {
            this._addLog('error', 'Fallback inference error: ' + ((err && err.message) || String(err)));
          } catch (_) {
            /* intentionally empty */
          }
        });
      } else if (msg.type === 'embedding_request') {
        this._handleEmbeddingRequest(msg).catch((err) => {
          try {
            this._addLog('error', 'Embedding request error: ' + ((err && err.message) || String(err)));
          } catch (_) {
            /* intentionally empty */
          }
        });
      } else if (msg.type === 'pong') {
        this._mgmtWsPongReceived = true;
        this._mgmtLastHeartbeatAck = Date.now();
      } else if (msg.type === 'ping') {
        this._mgmtLastHeartbeatAck = Date.now();
        this._sendMgmtMessage({ type: 'pong' });
      } else {
        this._addLog('info', 'Management WS message: ' + msg.type);
      }
    } catch (err) {
      this._addLog('warning', 'Failed to parse management WS message: ' + err.message);
    }
  }

  /**
   * Handle SSE fallback inference — SaaS sends this when WebRTC ICE fails
   * and falls back to streaming tokens through the management WebSocket.
   */
  async _handleFallbackInference(msg) {
    const jobId = msg.job_id || msg.jobId;

    // Only skip fallback if WebRTC has a CONFIRMED open data channel
    // (state is 'connected', 'streaming', or 'complete').
    // activeConnections.has() alone is NOT sufficient — it returns true during
    // signaling/negotiation, which may still fail (100% failure on Windows Tauri).
    // Sending fallback_skipped prematurely kills the SSE channel with no recovery path.
    const hasConfirmedP2P = this.peerHandler && this.peerHandler.isStreamingOrComplete(jobId);

    if (hasConfirmedP2P) {
      this._addLog('info', 'Skipping fallback — WebRTC P2P confirmed for job ' + (jobId || '').slice(0, 8));
      try {
        this._sendMgmtMessage({
          type: 'fallback_skipped',
          job_id: jobId,
          reason: 'webrtc_active',
        });
      } catch (_) {
        /* best effort */
      }
      return;
    }

    this._addLog('info', 'Processing fallback for job ' + (jobId || '').slice(0, 8) + ' (WebRTC not confirmed)');

    const requestStart = Date.now();
    let tracking = null;
    let statsFinalized = false;
    let requestLogged = false;
    const dbClient = this.db && typeof this.db.logRequest === 'function' ? this.db : db;

    const logFallbackRequest = (status, model, errorMessage, path) => {
      if (requestLogged) return;
      requestLogged = true;
      try {
        dbClient.logRequest({
          method: 'POST',
          path: path || '/api/chat',
          status: status,
          ip: 'mesh-saas',
          duration_ms: Date.now() - requestStart,
          model: model || null,
          error: errorMessage || null,
          auth_type: 'mesh-fallback',
        });
      } catch (_) {
        /* intentionally empty */
      }
    };

    try {
      const payload = msg.payload ||
        msg.request || {
          model: msg.model,
          messages: msg.messages,
          stream: msg.stream !== false,
          options: msg.options,
        };
      const dashboardPath = inferMeshRequestPath(payload, '/api/chat');

      if (!jobId || !payload.model || !payload.messages) {
        this._sendMgmtMessage({
          type: 'fallback_error',
          jobId: jobId || 'unknown',
          error: 'Missing jobId, model, or messages',
        });
        this._addLog('warning', 'Fallback inference: missing required fields');
        return;
      }

      this._addLog('info', 'Processing fallback inference for job ' + (jobId || '').slice(0, 8));
      tracking = stats.startRequest(jobId, payload.model);
      tracking.connectionType = 'mesh-fallback';

      const ollamaUrl = this.ollamaUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11435';
      const parsedUrl = new URL(ollamaUrl);
      const httpMod = parsedUrl.protocol === 'https:' ? https : http;

      const reqBody = JSON.stringify(payload);
      let response;
      try {
        response = await new Promise((resolve, reject) => {
          const req = httpMod.request(
            {
              hostname: parsedUrl.hostname,
              port: parseInt(parsedUrl.port) || 11435,
              path: '/api/chat',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(reqBody),
              },
            },
            resolve
          );
          req.setTimeout(120000, () => req.destroy(new Error('Ollama timeout')));
          req.on('error', reject);
          req.write(reqBody);
          req.end();
        });
      } catch (fetchErr) {
        if (tracking && !statsFinalized) {
          statsFinalized = true;
          await stats.failRequest(tracking, fetchErr).catch(function () {});
        }
        logFallbackRequest(502, payload.model, fetchErr.message, dashboardPath);
        this._sendMgmtMessage({
          type: 'fallback_error',
          jobId: jobId,
          error: 'Cannot reach Ollama: ' + fetchErr.message,
        });
        this._addLog('error', 'Fallback: Ollama unreachable — ' + fetchErr.message);
        return;
      }

      if (response.statusCode >= 400) {
        let errData = '';
        await new Promise((resolve) => {
          response.on('data', (chunk) => {
            try {
              errData += chunk.toString();
            } catch (_) {
              /* intentionally empty */
            }
          });
          response.on('end', resolve);
          response.on('error', resolve);
        });
        if (tracking && !statsFinalized) {
          statsFinalized = true;
          await stats.failRequest(tracking, new Error('Ollama returned ' + response.statusCode)).catch(function () {});
        }
        logFallbackRequest(response.statusCode, payload.model, 'Ollama returned ' + response.statusCode, dashboardPath);
        this._sendMgmtMessage({
          type: 'fallback_error',
          jobId: jobId,
          error: 'Ollama returned ' + response.statusCode + ': ' + errData.slice(0, 200),
        });
        this._addLog('error', 'Fallback: Ollama returned ' + response.statusCode);
        return;
      }

      // Stream response tokens back through management WebSocket
      await new Promise((resolve) => {
        let buffer = '';
        let firstTokenSeen = false;
        let promptTokens = 0;
        let completionTokens = 0;
        let sawToolCalls = false;

        const processLine = (line) => {
          if (!line || !line.trim()) return;
          try {
            const parsed = JSON.parse(line);
            this._sendMgmtMessage({ type: 'fallback_token', jobId: jobId, data: line });

            if (!firstTokenSeen && parsed.message && parsed.message.content) {
              stats.onFirstToken(tracking);
              firstTokenSeen = true;
            }

            if (parsed.message && hasToolCallsInMessage(parsed.message)) {
              sawToolCalls = true;
            }

            if (parsed.done) {
              promptTokens = parsed.prompt_eval_count || 0;
              completionTokens = parsed.eval_count || 0;
            }
          } catch (_) {
            /* skip malformed lines */
          }
        };

        response.on('data', (chunk) => {
          try {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              processLine(line);
            }
          } catch (_chunkErr) {
            /* don't crash on individual chunks */
          }
        });

        response.on('end', () => {
          try {
            processLine(buffer && buffer.trim() ? buffer.trim() : '');
          } catch (_) {
            /* safe */
          }

          if (tracking && !statsFinalized) {
            statsFinalized = true;
            stats
              .completeRequest(tracking, {
                prompt_eval_count: promptTokens,
                eval_count: completionTokens,
                isToolCall: sawToolCalls,
                source: 'mesh-fallback',
              })
              .catch(function () {});
          }

          this._sendMgmtMessage({ type: 'fallback_done', jobId: jobId });
          logFallbackRequest(200, payload.model, null, dashboardPath);
          resolve();
        });

        response.on('error', (err) => {
          if (tracking && !statsFinalized) {
            statsFinalized = true;
            stats.failRequest(tracking, err).catch(function () {});
          }
          logFallbackRequest(502, payload.model, (err && err.message) || String(err), dashboardPath);
          try {
            this._sendMgmtMessage({
              type: 'fallback_error',
              jobId: jobId,
              error: 'Stream error: ' + ((err && err.message) || String(err)),
            });
            this._addLog('error', 'Fallback stream error: ' + ((err && err.message) || String(err)));
          } catch (_) {
            /* safe */
          }
          resolve();
        });
      });

      this._addLog('success', 'Fallback inference complete for job ' + (jobId || '').slice(0, 8));
      this.jobsProcessed++;
    } catch (err) {
      if (tracking && !statsFinalized) {
        statsFinalized = true;
        await stats.failRequest(tracking, err).catch(function () {});
      }
      logFallbackRequest(500, (msg && msg.model) || null, (err && err.message) || String(err), '/api/chat');
      // Absolute last resort — nothing escapes this method
      try {
        this._sendMgmtMessage({
          type: 'fallback_error',
          jobId: jobId || 'unknown',
          error: 'Unhandled: ' + ((err && err.message) || String(err)),
        });
        this._addLog('error', 'Fallback inference crashed: ' + ((err && err.message) || String(err)));
      } catch (logErr) {
        console.error('[mesh-connector] CRITICAL: fallback_inference double-fault:', err, logErr);
      }
    }
  }

  /**
   * Handle embedding requests from SaaS Playground via management WebSocket.
   * Calls local Ollama /api/embed, transforms to OpenAI-compatible format.
   */
  async _handleEmbeddingRequest(msg) {
    const requestId = msg.request_id;
    try {
      const model = msg.model || 'nomic-embed-text';
      const input = msg.input;
      if (!input) {
        this._sendMgmtMessage({ type: 'embedding_error', request_id: requestId, error: 'Missing input text' });
        return;
      }

      this._addLog(
        'info',
        'Embedding request: model=' + model + ' len=' + (typeof input === 'string' ? input.length : '?')
      );

      const ollamaUrl = this.ollamaUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11435';
      const parsed = new URL(ollamaUrl);
      const isHttps = parsed.protocol === 'https:';
      const http = require(isHttps ? 'https' : 'http');

      const body = JSON.stringify({ model, input });
      const ollamaResult = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: '/api/embed',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
          },
          (res) => {
            let chunks = '';
            res.on('data', (c) => {
              chunks += c;
            });
            res.on('end', () => {
              if (res.statusCode >= 400) {
                reject(new Error('Ollama returned ' + res.statusCode + ': ' + chunks.slice(0, 200)));
              } else {
                try {
                  resolve(JSON.parse(chunks));
                } catch (_e) {
                  reject(new Error('Invalid JSON from Ollama'));
                }
              }
            });
          }
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Ollama embedding request timed out (30s)'));
        });
        req.write(body);
        req.end();
      });

      if (!ollamaResult.embeddings || !ollamaResult.embeddings.length) {
        this._sendMgmtMessage({
          type: 'embedding_error',
          request_id: requestId,
          error: 'Ollama returned no embeddings',
        });
        return;
      }

      const promptTokens = ollamaResult.prompt_eval_count || 0;
      this._sendMgmtMessage({
        type: 'embedding_response',
        request_id: requestId,
        data: {
          object: 'list',
          data: ollamaResult.embeddings.map((emb, i) => ({
            object: 'embedding',
            embedding: emb,
            index: i,
          })),
          model: ollamaResult.model || model,
          usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
        },
      });

      this._addLog(
        'info',
        'Embedding response sent: ' + ollamaResult.embeddings[0].length + 'd, ' + promptTokens + ' tokens'
      );
    } catch (err) {
      const errorMsg = (err && err.message) || String(err);
      this._addLog('error', 'Embedding request failed: ' + errorMsg);
      try {
        this._sendMgmtMessage({ type: 'embedding_error', request_id: requestId, error: errorMsg });
      } catch (_) {
        console.error('[mesh-connector] CRITICAL: embedding_request double-fault:', err);
      }
    }
  }

  /**
   * Send a message on the management WebSocket (best-effort).
   */
  _sendMgmtMessage(msg) {
    if (this._mgmtWs && this._mgmtWs.readyState === 1 /* OPEN */) {
      try {
        this._mgmtWs.send(JSON.stringify(msg));
      } catch (e) {
        log('Failed to send mgmt WS message: ' + e.message);
      }
    }
  }

  _buildSignalingUrl(jobId) {
    const meshUrl = this.meshUrl.replace(/\/+$/, '');
    return meshUrl.replace(/^http/, 'ws') + '/ws/signal/' + jobId + '?token=' + encodeURIComponent(this.apiKey);
  }

  _trimProcessedJobs() {
    if (this._processedJobs.size > 100) {
      const arr = [...this._processedJobs];
      this._processedJobs = new Set(arr.slice(-50));
    }
  }

  async _handleMeshJob(job, source) {
    const jobId = job.job_id || job.jobId || 'unknown';
    const model = job.model || 'unknown';
    const startTime = Date.now();
    try {
      // Try WebRTC first.
      if (job.signaling_url && job.ice_servers && this.peerHandler) {
        const result = await this.peerHandler.handleJobAssignment(job);
        if (result && result.success) {
          this.jobsProcessed++;
          this._addLog('info', 'Job ' + jobId + ' started via WebRTC P2P');
          return;
        }
        this._addLog(
          'warning',
          'WebRTC failed (' + ((result && result.reason) || 'unknown') + ') — falling back to HTTP processing'
        );
      }

      // Fallback: process via local Ollama HTTP.
      await this._processJob(job);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      const processingTime = Date.now() - startTime;
      console.error('[mesh-connector] Inference error on job ' + jobId + ': ' + msg);
      this._addLog(
        'error',
        'Inference error on job ' + jobId + ' (model: ' + model + ', source: ' + source + '): ' + msg
      );
      // Report failure back to SaaS but never let it crash the management WebSocket.
      try {
        await this._completeJob(jobId, {
          success: false,
          error: msg,
          processing_time_ms: processingTime,
        });
      } catch (reportErr) {
        console.error(
          '[mesh-connector] Failed to report job failure:',
          reportErr && reportErr.message ? reportErr.message : reportErr
        );
        this._addLog(
          'error',
          'Failed to report job failure: ' + ((reportErr && reportErr.message) || String(reportErr))
        );
      }
    }
  }

  // ── Registration ────────────────────────────────────────────────

  async _registerWithRetry() {
    const maxAttempts = BACKOFF_SCHEDULE.length + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this._stopped || this._aborted) return;
      try {
        await this._register();
        return; // success
      } catch (err) {
        if (this._stopped || this._aborted) return;
        if (err && err.noRetry) {
          throw err;
        }
        const delay = BACKOFF_SCHEDULE[Math.min(attempt, BACKOFF_SCHEDULE.length - 1)];
        this._addLog(
          'warning',
          'Attempt ' + (attempt + 1) + ' failed: ' + err.message + ' — retrying in ' + delay / 1000 + 's'
        );
        await this._sleep(delay);
      }
    }
    throw new Error('Registration failed after ' + maxAttempts + ' attempts');
  }

  async _register() {
    // Collect system info for registration
    const [models, gpuInfo] = await Promise.all([this._getAvailableModels(), this._getGpuInfo()]);

    const serverName =
      this.hollerName ||
      (this.db
        ? this.db.getSetting('holler_name') ||
          this.db.getSetting('server_name') ||
          process.env.JIMBOMESH_HOLLER_NAME ||
          process.env.HOLLER_SERVER_NAME ||
          null
        : process.env.JIMBOMESH_HOLLER_NAME || process.env.HOLLER_SERVER_NAME || null) ||
      os.hostname();
    const gpuName = gpuInfo ? gpuInfo.name : 'CPU only';
    const vramMb = gpuInfo ? gpuInfo.vram_total_mb : 0;
    this._addLog(
      'info',
      'Registering "' +
        serverName +
        '" (' +
        gpuName +
        (vramMb ? ', ' + Math.round(vramMb / 1024) + 'GB VRAM' : '') +
        ', ' +
        models.length +
        ' models)'
    );

    const saasModels = mapModelsForSaas(models);
    const body = {
      name: serverName,
      endpoint: this.hollerEndpoint,
      gpuType: gpuInfo ? gpuInfo.name : 'CPU',
      gpuVramMb: gpuInfo ? Math.round(gpuInfo.vram_total_mb || 0) : 0,
      ramMb: Math.round(os.totalmem() / 1048576),
      region: this._detectRegion(),
      models: saasModels,
    };

    const result = await this._meshFetch('POST', '/api/hollers/register', body);

    if (result.status === 409) {
      const conflictMessage =
        result.data && result.data.message ? result.data.message : 'This Holler name is already in use.';
      console.error('═══════════════════════════════════════════════════');
      console.error('❌ REGISTRATION FAILED: Duplicate Holler name');
      console.error('   ' + conflictMessage);
      console.error('');
      console.error('   FIX: Add this to your .env file:');
      console.error('   JIMBOMESH_HOLLER_NAME=your-unique-name');
      console.error('');
      console.error('   Then restart your Holler.');
      console.error('═══════════════════════════════════════════════════');

      const err = new Error('Duplicate Holler name. Set JIMBOMESH_HOLLER_NAME in .env and restart.');
      err.noRetry = true;
      throw err;
    }

    if (result.status === 201 || result.status === 200) {
      this.hollerId = result.data.hollerId || result.data.holler_id;
      // Auth token from registration response is ignored.
      // We continue using the original API key (this.apiKey) for all requests.
      // The SaaS key the user provided is the persistent auth credential.
      this._state = 'connected';
      this.errorMessage = null;
      this.heartbeatFailures = 0;
      this._retryIndex = 0;
      this.startedAt = Date.now();

      this._addLog('success', 'Connected! Holler ID: ' + (this.hollerId || '').slice(0, 8));

      // Initialize WebRTC peer handler (lazy — only if wrtc is installed)
      this._initPeerHandler();

      // Start heartbeat and job polling
      this._startIntervals();

      // Connect management WebSocket for real-time job push
      this._connectManagementWebSocket();
    } else {
      let errMsg = 'Authentication failed (' + result.status + ')';
      if (result.status === 401) errMsg += '. Check your API key.';
      this._addLog('error', errMsg);
      throw new Error('Registration returned HTTP ' + result.status + ': ' + JSON.stringify(result.data));
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────

  async _heartbeatLoop() {
    if (this._stopped || this._state !== 'connected') return;
    try {
      const hbStart = Date.now();
      const gpuInfo = await this._getGpuInfo();
      await this._sendHeartbeat(gpuInfo);
      const latencyMs = Date.now() - hbStart;
      this.lastHeartbeat = Date.now();
      this.heartbeatFailures = 0;

      const models = await this._getAvailableModels();
      const gpuUtil = gpuInfo && gpuInfo.utilization_percent != null ? gpuInfo.utilization_percent + '%' : 'N/A';
      this._addLog(
        'info',
        '\u2665 Heartbeat OK (latency: ' + latencyMs + 'ms, ' + models.length + ' models, GPU ' + gpuUtil + ')'
      );

      // Safety net: if management WebSocket is dead, try to reconnect it
      if (!this._mgmtWs || this._mgmtWs.readyState !== 1 /* OPEN */) {
        this._addLog('warning', 'Management WebSocket dead — reconnecting');
        this._connectManagementWebSocket();
      } else if (this._mgmtLastHeartbeatAck && Date.now() - this._mgmtLastHeartbeatAck > MGMT_WS_HEARTBEAT_STALE_MS) {
        this._addLog('warning', 'Heartbeat stale, forcing reconnect');
        try {
          this._mgmtWs.close();
        } catch (_) {
          /* intentionally empty */
        }
      }
    } catch (err) {
      this.heartbeatFailures++;
      this._addLog('warning', 'Heartbeat failed (' + this.heartbeatFailures + '/3): ' + err.message);

      if (this.heartbeatFailures >= 3) {
        this._addLog('error', 'Too many heartbeat failures — reconnecting');
        this._state = 'reconnecting';
        this.errorMessage = 'Lost connection — heartbeat failures';
        this._clearTimers();
        this._scheduleRetry();
      }
    }
  }

  async _sendHeartbeat(gpuInfo) {
    const models = await this._getAvailableModels();
    const concurrency = this.getConcurrencyStats ? this.getConcurrencyStats() : {};
    const effectiveGpuInfo = gpuInfo === undefined ? await this._getGpuInfo() : gpuInfo;
    const body = {
      hollerId: this.hollerId,
      currentLoad: await this._getCurrentLoad(effectiveGpuInfo),
      models: mapModelsForSaas(models),
      maxConcurrentRequests: concurrency.maxConcurrentRequests != null ? concurrency.maxConcurrentRequests : 1,
      activeRequests: concurrency.activeRequests != null ? concurrency.activeRequests : 0,
      queueDepth: concurrency.queueDepth != null ? concurrency.queueDepth : 0,
      gpuCount: concurrency.gpuCount != null ? concurrency.gpuCount : 0,
      // GPU specs — SaaS updates Holler record if changed
      gpuName: effectiveGpuInfo ? effectiveGpuInfo.name : undefined,
      gpuMemoryTotalMb: effectiveGpuInfo
        ? effectiveGpuInfo.vram_total_mb != null
          ? effectiveGpuInfo.vram_total_mb
          : effectiveGpuInfo.vramTotalMb
        : undefined,
      gpuType: effectiveGpuInfo ? effectiveGpuInfo.type || effectiveGpuInfo.name : undefined,
    };

    // Mac Metal override: heartbeat runs inside Docker where memory can be container-limited.
    // If this is not NVIDIA and setup provided HOST_TOTAL_MEMORY_MB, use host memory for VRAM total.
    const hostMem = process.env.HOST_TOTAL_MEMORY_MB;
    const isNvidia = typeof body.gpuType === 'string' && body.gpuType.toLowerCase() === 'nvidia';
    if (hostMem && !isNvidia) {
      const parsedHostMem = parseInt(hostMem, 10);
      if (Number.isFinite(parsedHostMem)) {
        body.gpuMemoryTotalMb = parsedHostMem;
      }
    }

    const result = await this._meshFetch('POST', '/api/hollers/heartbeat', body);
    if (result.status !== 200) {
      throw new Error('Heartbeat returned HTTP ' + result.status);
    }
    return result.data;
  }

  // ── Job Polling ─────────────────────────────────────────────────

  async _pollLoop() {
    if (this._stopped || this._state !== 'connected' || this._processing) return;
    try {
      await this._pollForJobs();
    } catch (err) {
      // Don't count poll failures as heartbeat failures — just log
      if (err.message && !err.message.includes('204') && !err.message.includes('404')) {
        log('Job poll error: ' + err.message);
      }
    }
  }

  async _pollForJobs() {
    const result = await this._meshFetch('GET', '/api/hollers/' + this.hollerId + '/jobs');

    if (result.status === 204 || result.status === 404) return; // no jobs
    if (result.status !== 200) return;

    const jobs = (result.data && result.data.jobs) || [];
    if (jobs.length === 0) return;

    this._processing = true;
    try {
      for (const job of jobs) {
        if (this._stopped) break;

        const jobId = job.job_id || job.jobId;
        if (this._processedJobs.has(jobId)) continue;
        this._processedJobs.add(jobId);
        this._trimProcessedJobs();

        await this._handleMeshJob(job, 'poll');
      }
    } finally {
      this._processing = false;
    }
  }

  async _processJob(job) {
    const jobId = job.job_id || job.jobId;
    const model = job.model;
    const messages = job.messages || [];
    const params = job.parameters || {};
    const tracking = stats.startRequest(jobId, model);
    tracking.connectionType = 'http';
    const dbClient = this.db && typeof this.db.logRequest === 'function' ? this.db : db;
    const dashboardPath = inferMeshRequestPath(job, '/api/chat');

    log('Job received: ' + jobId + ' (model: ' + model + ', ' + messages.length + ' messages)');

    const startTime = Date.now();
    try {
      await this._assertModelLoaded(model);

      // Call local Ollama for inference
      const ollamaResult = await this._ollamaChat(model, messages, params);
      const processingTime = Date.now() - startTime;
      await stats.completeRequest(tracking, {
        prompt_eval_count: ollamaResult.prompt_eval_count || 0,
        eval_count: ollamaResult.eval_count || 0,
        isToolCall: hasToolCallsInMessage(ollamaResult.message),
      });

      // Report completion to SaaS
      const tokensUsed = (ollamaResult.eval_count || 0) + (ollamaResult.prompt_eval_count || 0);
      await this._completeJob(jobId, {
        success: true,
        response: ollamaResult.message || ollamaResult,
        tokens_used: tokensUsed,
        processing_time_ms: processingTime,
      });

      this.jobsProcessed++;
      // Moonshine earned comes from SaaS response; estimate 1 per job as fallback
      this.moonshineEarned++;
      try {
        dbClient.logRequest({
          method: 'POST',
          path: dashboardPath,
          status: 200,
          ip: 'mesh-saas',
          duration_ms: processingTime,
          model: model || null,
          auth_type: 'mesh-http',
        });
      } catch (_) {
        /* intentionally empty */
      }

      log('Job ' + jobId + ' completed in ' + (processingTime / 1000).toFixed(1) + 's (' + tokensUsed + ' tokens)');
    } catch (err) {
      const processingTime = Date.now() - startTime;
      const isTimeout = /timeout|timed out/i.test(err && err.message ? err.message : '');
      log('Job ' + jobId + ' failed (model: ' + model + '): ' + err.message + (isTimeout ? ' [timeout]' : ''));
      this._addLog(
        'error',
        'Inference failed for model ' + model + ': ' + err.message + (isTimeout ? ' [timeout]' : '')
      );
      await stats.failRequest(tracking, err).catch(function () {});
      try {
        dbClient.logRequest({
          method: 'POST',
          path: dashboardPath,
          status: 500,
          ip: 'mesh-saas',
          duration_ms: processingTime,
          model: model || null,
          error: err.message,
          auth_type: 'mesh-http',
        });
      } catch (_) {
        /* intentionally empty */
      }

      // Report failure to SaaS (don't silently drop)
      try {
        await this._completeJob(jobId, {
          success: false,
          error: err.message,
          processing_time_ms: processingTime,
        });
      } catch (reportErr) {
        log('Failed to report job failure: ' + reportErr.message);
      }
    }
  }

  async _assertModelLoaded(model) {
    if (!model) throw new Error('Job missing model');
    const available = await this._getAvailableModels();
    const modelNames = available
      .map(function (m) {
        return m.name || m.model || '';
      })
      .filter(Boolean);

    if (modelNames.length === 0) {
      throw new Error('No Ollama models available; cannot run model "' + model + '"');
    }

    const target = String(model).toLowerCase();
    const found = modelNames.some(function (name) {
      const n = String(name || '').toLowerCase();
      return n === target || n.startsWith(target + ':') || target.startsWith(n + ':');
    });

    if (!found) {
      throw new Error('Model "' + model + '" is not available in Ollama');
    }
  }

  async _getLoadedOllamaModelNames() {
    const result = await this._ollamaFetch('GET', '/api/ps');
    if (!result || !Array.isArray(result.models)) return [];
    return result.models
      .map(function (m) {
        return m.name || m.model || '';
      })
      .filter(Boolean);
  }

  async _completeJob(jobId, result) {
    const response = await this._meshFetch(
      'POST',
      '/api/hollers/' + this.hollerId + '/jobs/' + jobId + '/complete',
      result
    );

    // Track Moonshine from SaaS response (supports camelCase/snake_case variants)
    const earned = response.data
      ? (response.data.moonshineEarned ?? response.data.moonshine_earned ?? response.data.MoonshineEarned)
      : null;
    if (earned != null) {
      this.moonshineEarned = this.moonshineEarned - 1 + earned;
    }

    return response;
  }

  // ── Ollama Integration ─────────────────────────────────────────

  async _ollamaChat(model, messages, params) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.ollamaUrl);
      const body = JSON.stringify({
        model: model,
        messages: messages,
        stream: false,
        options: params,
      });

      const opts = {
        hostname: parsed.hostname,
        port: parseInt(parsed.port) || 11435,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error('Ollama error ' + res.statusCode + ': ' + (parsed.error || data)));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error('Invalid Ollama response: ' + data.slice(0, 200)));
          }
        });
      });

      req.setTimeout(120000, () => {
        req.destroy(new Error('Ollama request timeout (120s)'));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async _getOllamaModels() {
    try {
      const result = await this._ollamaFetch('GET', '/api/tags');
      if (!result || !result.models) return [];
      return result.models.map(function (m) {
        return {
          name: m.name || m.model || '',
          model: m.model || m.name || '',
          size: m.size || 0,
          parameter_size: m.parameter_size || (m.details && m.details.parameter_size),
          details: m.details || {},
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Get available Ollama models with 30s cache and HOLLER_MODELS env var fallback.
   * Preferred over _getOllamaModels() for mesh registration, heartbeat, and model checks.
   */
  async _getAvailableModels() {
    const now = Date.now();
    if (_modelCache.models.length > 0 && now - _modelCache.timestamp < MODEL_CACHE_TTL) {
      return _modelCache.models;
    }

    try {
      const result = await this._ollamaFetch('GET', '/api/tags');
      if (result && result.models && result.models.length > 0) {
        const models = result.models.map(function (m) {
          return {
            name: m.name || m.model || '',
            model: m.model || m.name || '',
            size: m.size || 0,
            parameter_size: m.parameter_size || (m.details && m.details.parameter_size),
            details: m.details || {},
          };
        });
        _modelCache = { models: models, timestamp: now };
        log('Discovered ' + models.length + ' models from Ollama');
        return models;
      }
    } catch (err) {
      log('Could not query Ollama for models: ' + ((err && err.message) || err));
    }

    // Fallback to HOLLER_MODELS env var
    const envModels = (process.env.HOLLER_MODELS || '')
      .split(',')
      .map(function (m) {
        return m.trim();
      })
      .filter(Boolean);
    if (envModels.length > 0) {
      log('Using HOLLER_MODELS fallback: ' + envModels.join(', '));
      const models = envModels.map(function (name) {
        return { name: name, model: name, size: 0, parameter_size: null, details: {} };
      });
      _modelCache = { models: models, timestamp: now };
      return models;
    }

    return [];
  }

  _ollamaFetch(method, reqPath) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.ollamaUrl);
      const opts = {
        hostname: parsed.hostname,
        port: parseInt(parsed.port) || 11435,
        path: reqPath,
        method: method,
      };

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      });

      req.setTimeout(10000, () => {
        req.destroy(new Error('Ollama timeout'));
      });
      req.on('error', reject);
      req.end();
    });
  }

  // ── System Info Collection ──────────────────────────────────────

  async _getGpuInfo() {
    try {
      const out = execSync(
        'nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits',
        { timeout: 5000, encoding: 'utf8' }
      );
      const parts = out
        .trim()
        .split(',')
        .map(function (s) {
          return s.trim();
        });
      if (parts.length >= 4) {
        return {
          name: parts[0],
          type: 'nvidia',
          vram_total_mb: parseInt(parts[1]) || 0,
          vram_used_mb: parseInt(parts[2]) || 0,
          utilization_percent: parseInt(parts[3]) || 0,
        };
      }
    } catch {
      /* nvidia-smi not available */
    }

    // Check for Apple Metal (Performance Mode — native Ollama, Docker container for Node.js)
    if (process.platform === 'darwin' || process.env.OLLAMA_EXTERNAL_URL) {
      // HOST_TOTAL_MEMORY_MB is set by setup.sh for Mac Performance Mode installs.
      // os.totalmem() returns Docker container memory, NOT the host's actual RAM.
      const hostMemEnv = process.env.HOST_TOTAL_MEMORY_MB;
      const hostTotalMb = hostMemEnv ? parseInt(hostMemEnv, 10) : null;
      const containerTotalMb = Math.round(os.totalmem() / 1048576);
      const totalMb = hostTotalMb && hostTotalMb > containerTotalMb ? hostTotalMb : containerTotalMb;

      return {
        name: 'Apple Silicon (Metal)',
        type: 'metal',
        vram_total_mb: totalMb,
        vram_used_mb: Math.round((os.totalmem() - os.freemem()) / 1048576),
        utilization_percent: null,
      };
    }

    return null;
  }

  async _getSystemInfo() {
    const cpus = os.cpus();
    // Average CPU utilization across all cores
    let cpuPercent = 0;
    if (cpus.length > 0) {
      const totals = cpus.map(function (c) {
        const total = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
        const idle = c.times.idle;
        return { total: total, idle: idle };
      });
      const sumTotal = totals.reduce(function (a, b) {
        return a + b.total;
      }, 0);
      const sumIdle = totals.reduce(function (a, b) {
        return a + b.idle;
      }, 0);
      cpuPercent = sumTotal > 0 ? Math.round((1 - sumIdle / sumTotal) * 100) : 0;
    }

    return {
      cpu_percent: cpuPercent,
      memory_total_mb: Math.round(os.totalmem() / 1048576),
      memory_used_mb: Math.round((os.totalmem() - os.freemem()) / 1048576),
    };
  }

  async _getCurrentLoad(gpuInfo) {
    const [systemInfo, resolvedGpuInfo] = await Promise.all([
      this._getSystemInfo(),
      gpuInfo === undefined ? this._getGpuInfo() : Promise.resolve(gpuInfo),
    ]);
    const memoryLoad =
      systemInfo.memory_total_mb > 0 ? Math.round((systemInfo.memory_used_mb / systemInfo.memory_total_mb) * 100) : 0;
    const gpuLoad =
      resolvedGpuInfo && resolvedGpuInfo.utilization_percent != null ? resolvedGpuInfo.utilization_percent : 0;
    return Math.max(systemInfo.cpu_percent || 0, memoryLoad || 0, gpuLoad || 0);
  }

  /**
   * Best-effort region detection from timezone.
   * Returns a rough region string; SaaS can refine later.
   */
  _detectRegion() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      if (tz.startsWith('America/')) {
        const western = ['Los_Angeles', 'Denver', 'Phoenix', 'Boise'];
        const central = ['Chicago', 'Dallas', 'Houston'];
        const eastern = ['New_York', 'Detroit', 'Atlanta', 'Miami'];
        const city = tz.split('/').pop() || '';
        if (
          western.some(function (c) {
            return city.includes(c);
          })
        )
          return 'us-west';
        if (
          central.some(function (c) {
            return city.includes(c);
          })
        )
          return 'us-central';
        if (
          eastern.some(function (c) {
            return city.includes(c);
          })
        )
          return 'us-east';
        return 'us-east';
      }
      if (tz.startsWith('Europe/')) return 'eu-west';
      if (tz.startsWith('Asia/')) return 'asia-east';
      if (tz.startsWith('Australia/')) return 'au-east';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ── Mesh HTTP Client ────────────────────────────────────────────

  /**
   * Make an HTTPS request to the SaaS API.
   * @param {string} method - HTTP method
   * @param {string} reqPath - API path (e.g. /api/hollers/register)
   * @param {object} [body] - JSON body
   * @returns {Promise<{status: number, data: any}>}
   */
  _meshFetch(method, reqPath, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.meshUrl);
      const isHttps = parsed.protocol === 'https:';
      const mod = isHttps ? https : http;

      const headers = {};
      // Always use API key auth for all mesh requests.
      headers['X-API-Key'] = this.apiKey;

      let bodyStr;
      if (body) {
        bodyStr = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const opts = {
        hostname: parsed.hostname,
        port: parseInt(parsed.port) || (isHttps ? 443 : 80),
        path: reqPath,
        method: method,
        headers: headers,
        // Validate TLS certificates — no rejectUnauthorized: false
      };

      const req = mod.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, data: data });
          }
        });
      });

      req.setTimeout(10000, () => {
        req.destroy(new Error('Mesh API request timeout'));
      });
      req.on('error', reject);

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  // ── Interval Management ─────────────────────────────────────────

  _startIntervals() {
    this._clearTimers();

    // Heartbeat every 30 seconds
    this._heartbeatInterval = setInterval(() => {
      this._heartbeatLoop();
    }, 30000);

    // Poll for jobs every 5 seconds
    this._pollInterval = setInterval(() => {
      this._pollLoop();
    }, 5000);
  }

  _clearTimers() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    if (this._retryTimeout) {
      clearTimeout(this._retryTimeout);
      this._retryTimeout = null;
    }
  }

  _scheduleRetry() {
    if (this._stopped || this._aborted) return;
    const delay = BACKOFF_SCHEDULE[Math.min(this._retryIndex, BACKOFF_SCHEDULE.length - 1)];
    this._retryIndex++;
    if (this._state !== 'error') this._state = 'reconnecting';
    this._addLog('warning', 'Retrying in ' + delay / 1000 + 's...');
    this._retryTimeout = setTimeout(() => {
      if (!this._stopped && !this._aborted) this.start();
    }, delay);
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Check stopped/aborted flag periodically
      const check = setInterval(() => {
        if (this._stopped || this._aborted) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 500);
      setTimeout(() => {
        clearInterval(check);
      }, ms + 100);
    });
  }
}

module.exports = { MeshConnector };

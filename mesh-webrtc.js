/**
 * mesh-webrtc.js — WebRTC Peer-to-Peer Handler for JimboMesh Mesh
 *
 * Manages direct peer connections between the Holler and Buyers.
 * Inference data flows peer-to-peer — SaaS only handles signaling and billing.
 *
 * Lazy-loads the `wrtc` native module so standalone mode is unaffected.
 */

'use strict';

const crypto = require('crypto');
const db = require('./db');
const { inferMeshRequestPath } = require('./mesh-utils');

const MAX_PEER_CONNECTIONS = parseInt(process.env.MAX_PEER_CONNECTIONS || '10', 10);
const SIGNALING_TIMEOUT_MS = 30000;
const NEGOTIATION_TIMEOUT_MS = parseInt(process.env.NEGOTIATION_TIMEOUT_MS || '10000', 10);
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);
const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.WEBRTC_MAX_FAILURES || '3', 10);

// ── Logging ─────────────────────────────────────────────────────

function log(msg) {
  console.log('[webrtc] ' + msg);
}

// ── Module-level diagnostics ────────────────────────────────────
// Probe @roamhq/wrtc at require time so the Holler logs show whether
// the native binary loaded before any job arrives.

let _wrtcProbeResult = null;

(function probeWrtc() {
  try {
    const wrtc = require('@roamhq/wrtc');
    const hasPC = !!wrtc.RTCPeerConnection;
    const hasSDP = !!wrtc.RTCSessionDescription;
    const hasNS = !!wrtc.nonstandard;
    _wrtcProbeResult = { ok: hasPC && hasSDP, hasPC, hasSDP, hasNS, error: null };
    log(
      '@roamhq/wrtc loaded: RTCPeerConnection=' + hasPC + ', RTCSessionDescription=' + hasSDP + ', nonstandard=' + hasNS
    );
  } catch (err) {
    _wrtcProbeResult = { ok: false, hasPC: false, hasSDP: false, hasNS: false, error: err.message };
    console.error('[webrtc] @roamhq/wrtc FAILED TO LOAD: ' + err.message);
    console.error('[webrtc] Platform: ' + process.platform + ', Arch: ' + process.arch + ', Node: ' + process.version);
  }
})();

// ── HollerPeerHandler ───────────────────────────────────────────

class HollerPeerHandler {
  constructor(meshConnector) {
    this.meshConnector = meshConnector;
    this.activeConnections = new Map(); // jobId -> PeerSession
    this._wrtc = null;
    this._initialized = false;
    this.enabled = false;
    this.failureCount = 0;
    this._disabledReason = null;
  }

  /**
   * Lazy-load the wrtc module. Returns true if available.
   */
  _ensureWrtc() {
    if (this._initialized) return !!this._wrtc;
    this._initialized = true;
    try {
      this._wrtc = require('@roamhq/wrtc');
      if (this._wrtc.RTCPeerConnection) {
        this.enabled = true;
        log('Module loaded successfully — WebRTC P2P enabled');
      } else {
        this._disabledReason = 'RTCPeerConnection missing from module';
        log('Module loaded but RTCPeerConnection missing — WebRTC disabled');
      }
      return this.enabled;
    } catch (err) {
      this._disabledReason = err.message;
      log('Native module not available (' + err.message + ') — WebRTC disabled, SSE only');
      return false;
    }
  }

  /**
   * Reset failure state. Called on every registration so stale failures
   * from a previous session don't permanently disable WebRTC.
   */
  resetFailures() {
    const wasDisabled = this.failureCount >= MAX_CONSECUTIVE_FAILURES;
    this.failureCount = 0;
    if (wasDisabled) {
      log('WebRTC re-enabled after failure reset (was disabled at ' + MAX_CONSECUTIVE_FAILURES + ' failures)');
    }
    log('WebRTC state reset: capable=' + this.enabled + ', failures=0');
  }

  /**
   * Check if WebRTC should be attempted for the next job.
   * Returns false if the module didn't load, or too many consecutive failures.
   */
  canAttemptWebRTC() {
    if (!this._ensureWrtc()) return false;
    if (!this.enabled) return false;
    if (this.failureCount >= MAX_CONSECUTIVE_FAILURES) {
      log('Disabled for session after ' + this.failureCount + ' consecutive failures');
      return false;
    }
    return true;
  }

  /**
   * Called when a job assignment includes signaling data.
   * Creates a PeerSession, negotiates WebRTC with the Buyer.
   */
  async handleJobAssignment(assignment) {
    if (!this.canAttemptWebRTC()) {
      const reason = !this.enabled ? 'wrtc_unavailable' : 'disabled_consecutive_failures';
      return { success: false, reason: reason };
    }

    if (this.activeConnections.size >= MAX_PEER_CONNECTIONS) {
      log('At capacity (' + MAX_PEER_CONNECTIONS + ') — rejecting job ' + assignment.job_id);
      return { success: false, reason: 'at_capacity' };
    }

    const { job_id, model, signaling_url, ice_servers } = assignment;
    log('Job ' + job_id + ': connecting for model ' + model);

    const session = new PeerSession(job_id, model, ice_servers, this.meshConnector, this._wrtc);
    this.activeConnections.set(job_id, session);

    try {
      await session.connectSignaling(signaling_url);
      await session.negotiate();
      log('Job ' + job_id + ': peer-to-peer connected');
      this.failureCount = 0;
      return { success: true, jobId: job_id };
    } catch (err) {
      log('Job ' + job_id + ': negotiation failed — ' + err.message);
      this.activeConnections.delete(job_id);
      session.cleanup();
      this.failureCount++;
      if (this.failureCount >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          '[webrtc] ' +
            this.failureCount +
            ' consecutive failures — disabling WebRTC for this session. SSE fallback only.'
        );
      }
      return { success: false, reason: 'negotiation_failed', error: err.message };
    }
  }

  getActiveCount() {
    return this.activeConnections.size;
  }

  getStatus() {
    return {
      activeConnections: this.activeConnections.size,
      maxConnections: MAX_PEER_CONNECTIONS,
      jobs: Array.from(this.activeConnections.entries()).map(function (entry) {
        const id = entry[0];
        const s = entry[1];
        return {
          jobId: id,
          model: s.model,
          state: s.state,
          startedAt: s.startedAt,
        };
      }),
    };
  }

  /**
   * Check if a job has a confirmed, open data channel (not just attempting signaling).
   * Returns true only when the WebRTC session is actively streaming or already complete —
   * NOT during signaling/negotiation where it may still fail.
   */
  isStreamingOrComplete(jobId) {
    const session = this.activeConnections.get(jobId);
    if (!session) return false;
    return session.state === 'streaming' || session.state === 'complete' || session.state === 'connected';
  }

  /**
   * Remove a completed/failed session from the active map.
   */
  _removeSession(jobId) {
    this.activeConnections.delete(jobId);
  }

  /**
   * Close all active peer connections (for graceful shutdown).
   */
  async closeAll() {
    for (const entry of this.activeConnections) {
      entry[1].cleanup();
    }
    this.activeConnections.clear();
    log('All peer sessions closed');
  }
}

// ── PeerSession ─────────────────────────────────────────────────

class PeerSession {
  constructor(jobId, model, iceServers, meshConnector, wrtc) {
    this.jobId = jobId;
    this.model = model;
    this.meshConnector = meshConnector;
    this.state = 'signaling'; // signaling -> connected -> streaming -> complete -> closed
    this.startedAt = Date.now();
    this.signalingWs = null;
    this.dataChannel = null;
    this._wrtc = wrtc;

    const RTCPeerConnection = wrtc.RTCPeerConnection;

    // Normalize ICE server config
    const normalizedIce = (iceServers || []).map(function (s) {
      return {
        urls: s.urls || s.Urls,
        username: s.username || s.Username,
        credential: s.credential || s.Credential,
      };
    });

    const iceConfig = { iceServers: normalizedIce };
    log('Job ' + jobId + ': ICE servers config: ' + JSON.stringify(normalizedIce));
    this.pc = new RTCPeerConnection(iceConfig);

    const self = this;

    // ── Diagnostic: track ICE candidate gathering ──
    this.pc.onicecandidate = function (event) {
      if (!self.pc) return;
      if (event.candidate) {
        const c = event.candidate;
        log(
          'Job ' +
            self.jobId +
            ': ICE candidate: ' +
            (c.type || '?') +
            ' ' +
            (c.protocol || '?') +
            ' ' +
            (c.address || '?') +
            ':' +
            (c.port || '?')
        );
        if (self.signalingWs && self.signalingWs.readyState === WebSocket.OPEN) {
          self.signalingWs.send(
            JSON.stringify({
              type: 'ice-candidate',
              candidate: event.candidate,
            })
          );
        }
      } else {
        log('Job ' + self.jobId + ': ICE gathering complete');
      }
    };

    this.pc.onicegatheringstatechange = function () {
      if (!self.pc) return;
      log('Job ' + self.jobId + ': ICE gathering state: ' + self.pc.iceGatheringState);
    };

    this.pc.oniceconnectionstatechange = function () {
      if (!self.pc) return;
      log('Job ' + self.jobId + ': ICE connection state: ' + self.pc.iceConnectionState);
    };

    this.pc.onsignalingstatechange = function () {
      if (!self.pc) return;
      log('Job ' + self.jobId + ': signaling state: ' + self.pc.signalingState);
    };

    // Handle incoming data channel from buyer
    this.pc.ondatachannel = function (event) {
      self.dataChannel = event.channel;
      self.dataChannel.onmessage = function (msg) {
        try {
          self.handleDataMessage(JSON.parse(msg.data));
        } catch (err) {
          log('Job ' + self.jobId + ': invalid data message — ' + err.message);
        }
      };
      self.dataChannel.onopen = function () {
        self.state = 'connected';
        log('Job ' + self.jobId + ': data channel open');
        if (self.signalingWs && self.signalingWs.readyState === WebSocket.OPEN) {
          self.signalingWs.send(JSON.stringify({ type: 'connected' }));
        }
      };
      self.dataChannel.onclose = function () {
        self.state = 'closed';
        self.cleanup();
      };
    };

    this.pc.onconnectionstatechange = function () {
      if (!self.pc) return;
      const connState = self.pc.connectionState;
      log('Job ' + self.jobId + ': connection state: ' + connState);
      if (connState === 'failed' || connState === 'disconnected') {
        self.cleanup();
      }
    };
  }

  /**
   * Connect to the signaling WebSocket endpoint.
   * Uses Node.js 22 native WebSocket (W3C API).
   */
  connectSignaling(signalingUrl) {
    const self = this;
    return new Promise(function (resolve, reject) {
      // If the SaaS provided a signaling URL with an auth token baked in,
      // use it EXACTLY as-is. Only append token/role for legacy URLs without one.
      var url;
      try {
        var parsed = new URL(signalingUrl);
        if (parsed.searchParams.has('token')) {
          url = signalingUrl;
        } else {
          parsed.searchParams.set('token', self.meshConnector.apiKey);
          parsed.searchParams.set('role', 'holler');
          url = parsed.toString();
        }
      } catch (_e) {
        if (signalingUrl.indexOf('token=') !== -1) {
          url = signalingUrl;
        } else {
          url =
            signalingUrl +
            (signalingUrl.indexOf('?') === -1 ? '?' : '&') +
            'token=' +
            encodeURIComponent(self.meshConnector.apiKey) +
            '&role=holler';
        }
      }
      log('Job ' + self.jobId + ': connecting to signaling relay...');

      self.signalingWs = new WebSocket(url);

      var settled = false;
      var timeout = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error('Signaling connection timeout'));
          try {
            self.signalingWs.close();
          } catch (_) {
            /* */
          }
        }
      }, SIGNALING_TIMEOUT_MS);

      self.signalingWs.addEventListener('open', function () {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        log('Job ' + self.jobId + ': signaling relay connected, sending holler_ready');
        self.signalingWs.send(JSON.stringify({ type: 'holler_ready', job_id: self.jobId }));
        resolve();
      });

      self.signalingWs.addEventListener('message', function (event) {
        var raw = typeof event.data === 'string' ? event.data : String(event.data);
        try {
          var msg = JSON.parse(raw);
          log('Job ' + self.jobId + ': signaling message type=' + msg.type);
          self.handleSignalingMessage(msg).catch(function (err) {
            log('Job ' + self.jobId + ': handleSignalingMessage error — ' + err.message);
          });
        } catch (err) {
          log(
            'Job ' +
              self.jobId +
              ': invalid signaling message — ' +
              err.message +
              ' (data type: ' +
              typeof event.data +
              ', length: ' +
              raw.length +
              ')'
          );
        }
      });

      self.signalingWs.addEventListener('error', function (e) {
        log('Job ' + self.jobId + ': signaling WS error' + (e.message ? ': ' + e.message : ''));
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Signaling WebSocket error'));
        }
      });

      self.signalingWs.addEventListener('close', function (e) {
        log('Job ' + self.jobId + ': signaling WS closed (code=' + e.code + ', reason=' + (e.reason || 'none') + ')');
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Signaling WebSocket closed before open (code=' + e.code + ')'));
        }
      });
    });
  }

  /**
   * Handle messages from the signaling server.
   */
  async handleSignalingMessage(msg) {
    const RTCSessionDescription = this._wrtc.RTCSessionDescription;

    switch (msg.type) {
      case 'offer': {
        // Buyer sent SDP offer — set remote description and create answer
        await this.pc.setRemoteDescription(new RTCSessionDescription(msg));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signalingWs.send(
          JSON.stringify({
            type: 'answer',
            sdp: answer.sdp,
          })
        );
        break;
      }

      case 'ice_candidate':
      case 'ice-candidate':
        if (msg.candidate) {
          await this.pc.addIceCandidate(msg.candidate);
        }
        break;
    }
  }

  /**
   * Wait for the data channel to open (buyer creates it, we receive via ondatachannel).
   */
  negotiate() {
    const self = this;
    return new Promise(function (resolve, reject) {
      const timeout = setTimeout(function () {
        // If already streaming or complete, the negotiation succeeded — just late
        if (self.state === 'streaming' || self.state === 'complete') {
          resolve();
        } else {
          reject(new Error('WebRTC negotiation timeout'));
        }
      }, NEGOTIATION_TIMEOUT_MS);

      const checkInterval = setInterval(function () {
        if (self.state === 'connected' || self.state === 'streaming' || self.state === 'complete') {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Handle messages received over the data channel from the buyer.
   */
  async handleDataMessage(msg) {
    if (msg.type === 'inference_request') {
      await this.processInference(msg);
    } else if (msg.type === 'cancel') {
      this.state = 'cancelled';
      this.cleanup();
    }
  }

  /**
   * Process an inference request from the buyer.
   * Calls local Ollama with streaming, pipes tokens over the data channel.
   */
  async processInference(request) {
    this.state = 'streaming';
    const startTime = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let statsFinalized = false;
    const self = this;
    const statsCollector = this.meshConnector._stats;
    const tracking = statsCollector
      ? statsCollector.startRequest(this.jobId || crypto.randomUUID(), request.model || this.model || 'unknown')
      : null;
    if (tracking) tracking.connectionType = 'webrtc';
    let fetchTimeout;

    log(
      'Job ' +
        this.jobId +
        ': processing ' +
        request.model +
        ' (' +
        (request.messages ? request.messages.length : 0) +
        ' messages)'
    );

    try {
      const ollamaUrl = process.env.OLLAMA_EXTERNAL_URL || process.env.OLLAMA_INTERNAL_URL || 'http://127.0.0.1:11435';

      const abortController = new AbortController();
      fetchTimeout = setTimeout(function () {
        abortController.abort();
      }, OLLAMA_TIMEOUT_MS);

      const response = await fetch(ollamaUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          options: request.parameters || {},
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error('Ollama error: ' + response.status + ' ' + response.statusText);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let tokenIndex = 0;
      let firstTokenSent = false;

      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (self.state === 'cancelled') break;

        const lines = decoder.decode(result.value).split('\n').filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          try {
            const chunk = JSON.parse(lines[i]);

            if (chunk.message && chunk.message.content && self.dataChannel && self.dataChannel.readyState === 'open') {
              self.dataChannel.send(
                JSON.stringify({
                  type: 'token',
                  token: chunk.message.content,
                  index: tokenIndex++,
                })
              );

              if (!firstTokenSent) {
                firstTokenSent = true;
                if (statsCollector && tracking) statsCollector.onFirstToken(tracking);
                log('Job ' + self.jobId + ': first token sent (' + (Date.now() - startTime) + 'ms TTFT)');
              }
            }

            if (chunk.done) {
              inputTokens = chunk.prompt_eval_count || 0;
              outputTokens = chunk.eval_count || 0;
              if (tracking && !statsFinalized) {
                statsFinalized = true;
                statsCollector
                  .completeRequest(tracking, {
                    prompt_eval_count: inputTokens,
                    eval_count: outputTokens,
                    isToolCall: false,
                    source: 'mesh-webrtc',
                  })
                  .catch(function () {});
              }

              if (self.dataChannel && self.dataChannel.readyState === 'open') {
                self.dataChannel.send(
                  JSON.stringify({
                    type: 'complete',
                    usage: {
                      prompt_tokens: inputTokens,
                      completion_tokens: outputTokens,
                      total_tokens: inputTokens + outputTokens,
                    },
                    processing_time_ms: Date.now() - startTime,
                  })
                );
              }
            }
          } catch (_parseErr) {
            // Skip malformed chunks
          }
        }
      }

      clearTimeout(fetchTimeout);
      self.state = 'complete';
      const processingMs = Date.now() - startTime;
      if (tracking && !statsFinalized) {
        statsFinalized = true;
        statsCollector
          .completeRequest(tracking, {
            prompt_eval_count: inputTokens,
            eval_count: outputTokens,
            isToolCall: false,
            source: 'mesh-webrtc',
          })
          .catch(function () {});
      }
      const tokPerSec = processingMs > 0 ? (outputTokens / (processingMs / 1000)).toFixed(1) : '0';
      log(
        'Job ' +
          self.jobId +
          ': complete (' +
          outputTokens +
          ' tokens, ' +
          processingMs +
          'ms, ' +
          tokPerSec +
          ' tok/s)'
      );

      // Report usage to SaaS for billing (ONLY metadata, not content)
      await self.reportUsage(request.model, inputTokens, outputTokens, processingMs);

      // Record request for dashboard counters/activity.
      self.recordLocalRequestLog(request.model, processingMs, null, request);
    } catch (err) {
      clearTimeout(fetchTimeout);
      if (tracking && !statsFinalized) {
        statsFinalized = true; // eslint-disable-line no-useless-assignment
        statsCollector.failRequest(tracking, err).catch(function () {});
      }
      log('Job ' + self.jobId + ': error — ' + err.message);
      self.recordLocalRequestLog(request.model, Date.now() - startTime, err, request);
      if (self.dataChannel && self.dataChannel.readyState === 'open') {
        self.dataChannel.send(
          JSON.stringify({
            type: 'error',
            error: err.message,
            code: 'PROCESSING_ERROR',
          })
        );
      }
    } finally {
      // Notify the handler to remove this session
      if (self.meshConnector && self.meshConnector.peerHandler) {
        self.meshConnector.peerHandler._removeSession(self.jobId);
      }
      self.cleanup();
    }
  }

  /**
   * Report usage to SaaS for billing. Only metadata — no inference content.
   */
  async reportUsage(model, inputTokens, outputTokens, processingMs) {
    try {
      const response = await fetch(this.meshConnector.meshUrl + '/api/usage/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.meshConnector.apiKey,
        },
        body: JSON.stringify({
          jobId: this.jobId,
          model: model,
          inputTokens: inputTokens,
          outputTokens: outputTokens,
          processingTimeMs: processingMs,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        // SaaS returns camelCase (moonshineEarned), handle all casing variants
        const earned = result.moonshineEarned ?? result.moonshine_earned ?? result.MoonshineEarned ?? 0;
        if (earned > 0) {
          this.meshConnector.moonshineEarned += earned;
          log(
            'Job ' +
              this.jobId +
              ': earned ' +
              earned +
              ' Moonshine (total: ' +
              this.meshConnector.moonshineEarned.toFixed(2) +
              ')'
          );
          // Persist lifetime Moonshine to SQLite
          try {
            const currentLifetime = parseFloat(db.getSetting('moonshine_earned_lifetime') || '0');
            db.setSetting('moonshine_earned_lifetime', String(currentLifetime + earned));
          } catch (e) {
            log('Job ' + this.jobId + ': failed to persist Moonshine to SQLite — ' + e.message);
          }
        }
      } else {
        const errText = await response.text().catch(function () {
          return 'unknown';
        });
        log('Job ' + this.jobId + ': usage report failed (HTTP ' + response.status + '): ' + errText);
      }
    } catch (err) {
      log('Job ' + this.jobId + ': usage report failed — ' + err.message);
      // TODO: Queue for retry — billing must eventually be recorded
    }
  }

  /**
   * Record request in local request log/dashboard counters.
   */
  recordLocalRequestLog(model, processingMs, err, request) {
    try {
      const requestPath = inferMeshRequestPath(request, '/api/chat');
      db.logRequest({
        method: 'POST',
        path: requestPath,
        status: err ? 500 : 200,
        ip: 'mesh-saas',
        duration_ms: processingMs,
        model: model || this.model || null,
        error: err ? err.message : null,
        auth_type: 'mesh-webrtc',
      });
    } catch (err) {
      log('Job ' + this.jobId + ': local request log failed — ' + err.message);
    }
  }

  /**
   * Close all connections and free resources.
   */
  cleanup() {
    try {
      if (this.signalingWs) this.signalingWs.close();
    } catch (_) {
      /* expected during teardown */
    }
    try {
      if (this.dataChannel) this.dataChannel.close();
    } catch (_) {
      /* expected during teardown */
    }
    try {
      if (this.pc) this.pc.close();
    } catch (_) {
      /* expected during teardown */
    }
    this.signalingWs = null;
    this.dataChannel = null;
    this.pc = null;
  }
}

module.exports = { HollerPeerHandler, PeerSession };

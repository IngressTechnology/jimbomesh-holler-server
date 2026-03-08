'use strict';

/**
 * Shared utilities for mesh-connector and mesh-webrtc.
 */

function inferMeshRequestPath(request, fallbackPath) {
  if (request && Array.isArray(request.input)) return '/api/embed';
  if (request && typeof request.input === 'string') return '/api/embed';
  if (request && request.endpoint === 'embed') return '/api/embed';
  if (request && request.type === 'embed') return '/api/embed';
  return fallbackPath || '/api/chat';
}

function maskKey(str) {
  if (!str) return '****';
  if (str.length < 8) return '****';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

module.exports = { inferMeshRequestPath, maskKey };

/**
 * Qdrant HTTP Client for JimboMesh Holler Server
 * Reusable client for Qdrant vector database operations.
 * Uses raw HTTP (matching scripts/init-qdrant.sh pattern).
 */

const http = require('http');
const https = require('https');

const QDRANT_URL = process.env.QDRANT_URL || 'http://jimbomesh-holler-qdrant:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const EMBED_DIMENSIONS = parseInt(process.env.EMBED_DIMENSIONS || '768');

function qdrantFetch(method, reqPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(QDRANT_URL);
    const isHttps = parsed.protocol === 'https:';
    const opts = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || (isHttps ? 443 : 6333),
      path: reqPath,
      method,
      headers: {},
    };
    if (QDRANT_API_KEY) opts.headers['api-key'] = QDRANT_API_KEY;
    if (body) opts.headers['Content-Type'] = 'application/json';

    const transport = isHttps ? https : http;
    const req = transport.request(opts, (res) => {
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
    req.setTimeout(timeoutMs || 30000, () => req.destroy(new Error('Qdrant request timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Collection Management ─────────────────────────────────────

function listCollections() {
  return qdrantFetch('GET', '/collections').then(function (r) {
    if (r.status !== 200) throw new Error('Qdrant listCollections: HTTP ' + r.status);
    return (r.data.result && r.data.result.collections) || [];
  });
}

function getCollection(name) {
  return qdrantFetch('GET', '/collections/' + encodeURIComponent(name)).then(function (r) {
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error('Qdrant getCollection: HTTP ' + r.status);
    return r.data.result || r.data;
  });
}

function createCollection(name, size, distance) {
  return qdrantFetch('PUT', '/collections/' + encodeURIComponent(name), {
    vectors: {
      size: size || EMBED_DIMENSIONS,
      distance: distance || 'Cosine',
    },
  }).then(function (r) {
    if (r.status !== 200 && r.status !== 409) {
      throw new Error('Qdrant createCollection: HTTP ' + r.status);
    }
    return r.data;
  });
}

function deleteCollection(name) {
  return qdrantFetch('DELETE', '/collections/' + encodeURIComponent(name)).then(function (r) {
    if (r.status !== 200) throw new Error('Qdrant deleteCollection: HTTP ' + r.status);
    return r.data;
  });
}

// ── Point Operations ──────────────────────────────────────────

function upsertPoints(collection, points) {
  return qdrantFetch(
    'PUT',
    '/collections/' + encodeURIComponent(collection) + '/points?wait=true',
    {
      points: points,
    },
    120000
  ).then(function (r) {
    if (r.status !== 200) throw new Error('Qdrant upsertPoints: HTTP ' + r.status);
    return r.data;
  });
}

function deletePoints(collection, filter) {
  return qdrantFetch('POST', '/collections/' + encodeURIComponent(collection) + '/points/delete?wait=true', {
    filter: filter,
  }).then(function (r) {
    if (r.status !== 200) throw new Error('Qdrant deletePoints: HTTP ' + r.status);
    return r.data;
  });
}

function searchPoints(collection, vector, filter, limit) {
  const body = {
    vector: vector,
    limit: limit || 5,
    with_payload: true,
  };
  if (filter) body.filter = filter;
  return qdrantFetch('POST', '/collections/' + encodeURIComponent(collection) + '/points/search', body).then(
    function (r) {
      if (r.status !== 200) throw new Error('Qdrant searchPoints: HTTP ' + r.status);
      return r.data.result || [];
    }
  );
}

function scrollPoints(collection, filter, limit, offset) {
  const body = {
    limit: limit || 100,
    with_payload: true,
  };
  if (filter) body.filter = filter;
  if (offset) body.offset = offset;
  return qdrantFetch('POST', '/collections/' + encodeURIComponent(collection) + '/points/scroll', body).then(
    function (r) {
      if (r.status !== 200) throw new Error('Qdrant scrollPoints: HTTP ' + r.status);
      return r.data.result || { points: [], next_page_offset: null };
    }
  );
}

function countPoints(collection, filter) {
  const body = { exact: true };
  if (filter) body.filter = filter;
  return qdrantFetch('POST', '/collections/' + encodeURIComponent(collection) + '/points/count', body).then(
    function (r) {
      if (r.status !== 200) throw new Error('Qdrant countPoints: HTTP ' + r.status);
      return (r.data.result && r.data.result.count) || 0;
    }
  );
}

module.exports = {
  listCollections,
  getCollection,
  createCollection,
  deleteCollection,
  upsertPoints,
  deletePoints,
  searchPoints,
  scrollPoints,
  countPoints,
  QDRANT_URL,
  EMBED_DIMENSIONS,
};

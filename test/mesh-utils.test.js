const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { inferMeshRequestPath, maskKey } = require('../mesh-utils');

describe('mesh-utils', function () {
  describe('inferMeshRequestPath', function () {
    it('returns /api/embed for array input', function () {
      assert.equal(inferMeshRequestPath({ input: ['text1', 'text2'] }), '/api/embed');
    });

    it('returns /api/embed for string input', function () {
      assert.equal(inferMeshRequestPath({ input: 'some text' }), '/api/embed');
    });

    it('returns /api/embed for endpoint=embed', function () {
      assert.equal(inferMeshRequestPath({ endpoint: 'embed' }), '/api/embed');
    });

    it('returns /api/embed for type=embed', function () {
      assert.equal(inferMeshRequestPath({ type: 'embed' }), '/api/embed');
    });

    it('returns fallback for chat requests', function () {
      assert.equal(inferMeshRequestPath({ messages: [] }), '/api/chat');
    });

    it('returns custom fallback', function () {
      assert.equal(inferMeshRequestPath({}, '/api/generate'), '/api/generate');
    });

    it('returns /api/chat for null request', function () {
      assert.equal(inferMeshRequestPath(null), '/api/chat');
    });
  });

  describe('maskKey', function () {
    it('masks long keys', function () {
      assert.equal(maskKey('abcdefghijklmnop'), 'abcd****mnop');
    });

    it('returns **** for short keys', function () {
      assert.equal(maskKey('abc'), '****');
    });

    it('returns **** for null', function () {
      assert.equal(maskKey(null), '****');
    });

    it('returns **** for empty string', function () {
      assert.equal(maskKey(''), '****');
    });
  });
});

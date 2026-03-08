const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../admin-routes');

describe('admin-routes redirect hardening', function () {
  describe('isAllowedHfDownloadUrl', function () {
    it('allows HuggingFace primary host over https', function () {
      assert.equal(__test.isAllowedHfDownloadUrl('https://huggingface.co/owner/repo/resolve/main/model.gguf'), true);
    });

    it('allows trusted HuggingFace subdomains over https', function () {
      assert.equal(__test.isAllowedHfDownloadUrl('https://cdn-lfs.hf.co/path/to/model.gguf'), true);
      assert.equal(__test.isAllowedHfDownloadUrl('https://sub.huggingface.co/path/to/model.gguf'), true);
    });

    it('blocks non-https URLs', function () {
      assert.equal(__test.isAllowedHfDownloadUrl('http://huggingface.co/owner/repo/file.gguf'), false);
    });

    it('blocks non-HuggingFace hosts', function () {
      assert.equal(__test.isAllowedHfDownloadUrl('https://evil.example/owner/repo/file.gguf'), false);
      assert.equal(__test.isAllowedHfDownloadUrl('https://127.0.0.1/internal'), false);
      assert.equal(__test.isAllowedHfDownloadUrl('https://localhost/internal'), false);
    });
  });

  describe('resolveRedirectUrl', function () {
    it('resolves relative redirects against base URL', function () {
      const next = __test.resolveRedirectUrl(
        'https://huggingface.co/owner/repo/resolve/main/file.gguf',
        '/owner/repo/resolve/main/other.gguf'
      );
      assert.equal(next, 'https://huggingface.co/owner/repo/resolve/main/other.gguf');
      assert.equal(__test.isAllowedHfDownloadUrl(next), true);
    });

    it('flags absolute redirects to untrusted hosts as blocked', function () {
      const next = __test.resolveRedirectUrl(
        'https://huggingface.co/owner/repo/resolve/main/file.gguf',
        'https://evil.example/payload.gguf'
      );
      assert.equal(next, 'https://evil.example/payload.gguf');
      assert.equal(__test.isAllowedHfDownloadUrl(next), false);
    });

    it('flags protocol-relative redirects to untrusted hosts as blocked', function () {
      const next = __test.resolveRedirectUrl(
        'https://huggingface.co/owner/repo/resolve/main/file.gguf',
        '//evil.example/payload.gguf'
      );
      assert.equal(next, 'https://evil.example/payload.gguf');
      assert.equal(__test.isAllowedHfDownloadUrl(next), false);
    });
  });
});

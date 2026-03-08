const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

describe('document-pipeline', function () {
  let pipeline;

  // Only import — don't call functions that require Ollama/Qdrant
  before(function () {
    process.env.SQLITE_DB_PATH = require('path').join(__dirname, '.test-pipeline.db');
    pipeline = require('../document-pipeline');
  });

  describe('chunkText', function () {
    it('returns a single chunk for short text', function () {
      const chunks = pipeline.chunkText('Hello world');
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].text, 'Hello world');
      assert.equal(chunks[0].chunkIndex, 0);
    });

    it('splits on paragraph boundaries', function () {
      const paragraphs = [];
      for (let i = 0; i < 20; i++) {
        paragraphs.push(
          'Paragraph ' +
            i +
            ' with enough words to take up some space in the chunk budget. ' +
            'This sentence is padding to make the paragraph meaningfully long so that chunking is triggered.'
        );
      }
      const text = paragraphs.join('\n\n');
      const chunks = pipeline.chunkText(text);
      assert.ok(chunks.length > 1, 'Should produce multiple chunks');
      assert.equal(chunks[0].chunkIndex, 0);
      assert.equal(chunks[chunks.length - 1].totalChunks, chunks.length);
    });

    it('force-splits oversized single paragraph', function () {
      const longText = 'word '.repeat(2000);
      const chunks = pipeline.chunkText(longText, { chunkSize: 100 });
      assert.ok(chunks.length > 1, 'Should force-split');
    });

    it('handles empty text', function () {
      const chunks = pipeline.chunkText('');
      assert.equal(chunks.length, 0);
    });

    it('preserves chunk metadata', function () {
      const chunks = pipeline.chunkText('First paragraph\n\nSecond paragraph');
      for (const chunk of chunks) {
        assert.equal(typeof chunk.chunkIndex, 'number');
        assert.equal(typeof chunk.totalChunks, 'number');
        assert.equal(typeof chunk.charOffset, 'number');
        assert.ok(chunk.text.length > 0);
      }
    });
  });

  describe('guessMime', function () {
    it('identifies PDF', function () {
      assert.equal(pipeline.guessMime('file.pdf'), 'application/pdf');
    });

    it('identifies markdown', function () {
      assert.equal(pipeline.guessMime('README.md'), 'text/markdown');
    });

    it('identifies plain text', function () {
      assert.equal(pipeline.guessMime('notes.txt'), 'text/plain');
    });

    it('identifies CSV', function () {
      assert.equal(pipeline.guessMime('data.csv'), 'text/csv');
    });

    it('identifies DOCX', function () {
      assert.equal(
        pipeline.guessMime('report.docx'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
    });

    it('returns octet-stream for unknown', function () {
      assert.equal(pipeline.guessMime('file.xyz'), 'application/octet-stream');
    });
  });

  describe('computeFileHash', function () {
    const fs = require('fs');
    const path = require('path');
    const tmpFile = path.join(__dirname, '.test-hash-file.txt');

    it('computes SHA-256 hash', async function () {
      fs.writeFileSync(tmpFile, 'hello world');
      try {
        const hash = await pipeline.computeFileHash(tmpFile);
        assert.equal(typeof hash, 'string');
        assert.equal(hash.length, 64);
        // Known SHA-256 of "hello world"
        assert.equal(hash, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });
});

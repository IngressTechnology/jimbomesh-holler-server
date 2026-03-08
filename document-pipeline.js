/**
 * Document Processing Pipeline for JimboMesh Holler Server
 * Text extraction, chunking, embedding, and Qdrant storage.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const qdrant = require('./qdrant-client');

// ── Configuration ─────────────────────────────────────────────

const OLLAMA_URL = process.env.OLLAMA_INTERNAL_URL || 'http://127.0.0.1:11435';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const CHUNK_SIZE = parseInt(process.env.DOCUMENT_CHUNK_SIZE || '500');
const CHUNK_OVERLAP = parseInt(process.env.DOCUMENT_CHUNK_OVERLAP || '50');
const EMBED_BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE || '10', 10);
const MAX_UPLOAD_SIZE_MB = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '50', 10);
const CHARS_PER_TOKEN = 4; // heuristic matching api-gateway.js

const DOCUMENTS_DIR = path.join(
  process.env.SQLITE_DB_PATH
    ? path.dirname(process.env.SQLITE_DB_PATH)
    : path.join(__dirname, 'data'),
  'documents'
);

// ── Utilities ─────────────────────────────────────────────────

function ensureDocumentsDir() {
  if (!fs.existsSync(DOCUMENTS_DIR)) {
    fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
  }
}

function computeFileHash(filePath) {
  return new Promise(function (resolve, reject) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', function (chunk) { hash.update(chunk); });
    stream.on('end', function () { resolve(hash.digest('hex')); });
    stream.on('error', reject);
  });
}

function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

// ── Text Extraction ───────────────────────────────────────────

async function extractText(filePath, mimeType) {
  switch (mimeType) {
    case 'application/pdf': {
      const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');
      const data = new Uint8Array(fs.readFileSync(filePath));
      const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
      const pages = doc.numPages;
      const textParts = [];
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        textParts.push(content.items.map(function (item) { return item.str; }).join(' '));
      }
      return { text: textParts.join('\n'), pages: pages };
    }
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      const mammoth = require('mammoth');
      const result2 = await mammoth.extractRawText({ path: filePath });
      return { text: result2.value };
    }
    case 'text/csv': {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return { text: csvToText(raw) };
    }
    case 'text/plain':
    case 'text/markdown':
      return { text: fs.readFileSync(filePath, 'utf-8') };
    default:
      // Try reading as text
      return { text: fs.readFileSync(filePath, 'utf-8') };
  }
}

function csvToText(raw) {
  const lines = raw.split('\n').filter(function (l) { return l.trim(); });
  if (lines.length < 2) return raw;
  const header = lines[0];
  const rows = lines.slice(1).map(function (row) {
    return header + '\n' + row;
  });
  return rows.join('\n\n');
}

// ── Chunking ──────────────────────────────────────────────────

function chunkText(text, options) {
  const targetTokens = (options && options.chunkSize) || CHUNK_SIZE;
  const overlapTokens = (options && options.overlap) || CHUNK_OVERLAP;
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  // Split on paragraph boundaries (double newline) or markdown headers
  const paragraphs = text.split(/\n{2,}|\n(?=#{1,6}\s)/);

  let chunks = [];
  let current = '';
  let charOffset = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const trimmed = paragraphs[i].trim();
    if (!trimmed) continue;

    // If adding this paragraph would exceed target and we already have content, flush
    if (current.length + trimmed.length > targetChars && current.length > 0) {
      chunks.push({ text: current.trim(), charOffset: charOffset });
      // Apply overlap
      const overlapText = current.slice(-overlapChars);
      charOffset += current.length - overlapText.length;
      current = overlapText + '\n\n' + trimmed;
    } else {
      if (current) current += '\n\n';
      current += trimmed;
    }
  }

  // Don't forget the last chunk
  if (current.trim()) {
    chunks.push({ text: current.trim(), charOffset: charOffset });
  }

  // If text didn't have paragraph breaks but is long, force-split
  if (chunks.length === 0 && text.trim()) {
    chunks.push({ text: text.trim(), charOffset: 0 });
  } else if (chunks.length === 1 && chunks[0].text.length > targetChars * 2) {
    // Force-split oversized single chunk
    const bigText = chunks[0].text;
    chunks = [];
    for (let j = 0; j < bigText.length; j += targetChars - overlapChars) {
      chunks.push({
        text: bigText.slice(j, j + targetChars).trim(),
        charOffset: j,
      });
    }
  }

  // Annotate with indices
  return chunks.map(function (c, idx) {
    return {
      text: c.text,
      chunkIndex: idx,
      totalChunks: chunks.length,
      charOffset: c.charOffset,
    };
  });
}

// ── Embedding ─────────────────────────────────────────────────

function ollamaEmbed(texts) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(OLLAMA_URL);
    const body = JSON.stringify({ model: EMBED_MODEL, input: texts });
    const req = http.request({
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || 11435,
      path: '/api/embed',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 120000,
    }, function (res) {
      let data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          const parsed2 = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(parsed2.error || 'Ollama embed failed: HTTP ' + res.statusCode));
            return;
          }
          resolve(parsed2);
        } catch (_e) {
          reject(new Error('Failed to parse Ollama embed response'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('Ollama embed timeout')); });
    req.write(body);
    req.end();
  });
}

async function embedBatch(texts, onProgress) {
  const BATCH_SIZE = EMBED_BATCH_SIZE;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const result = await ollamaEmbed(batch);
    const embeddings = result.embeddings || [];
    for (let j = 0; j < embeddings.length; j++) {
      allEmbeddings.push(embeddings[j]);
    }

    if (onProgress) {
      onProgress({
        phase: 'embedding',
        status: 'Embedding chunks...',
        completed: Math.min(i + BATCH_SIZE, texts.length),
        total: texts.length,
      });
    }
  }

  return allEmbeddings;
}

// ── Full Processing Pipeline ──────────────────────────────────

async function processDocument(docId, filePath, mimeType, collection, onProgress) {
  // Pre-check: reject files exceeding the configured size limit
  const fileStat = fs.statSync(filePath);
  const maxBytes = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
  if (fileStat.size > maxBytes) {
    throw new Error('File exceeds maximum upload size of ' + MAX_UPLOAD_SIZE_MB + ' MB');
  }

  // Phase 1: Extract text
  onProgress({ phase: 'extract', status: 'Extracting text...' });
  const extracted = await extractText(filePath, mimeType);
  const text = extracted.text;
  const pages = extracted.pages || null;

  if (!text || !text.trim()) {
    throw new Error('No text content extracted from file');
  }

  // Phase 2: Chunk
  onProgress({ phase: 'chunk', status: 'Chunking text...' });
  const chunks = chunkText(text);
  onProgress({ phase: 'chunk', status: 'Created ' + chunks.length + ' chunks', count: chunks.length });

  if (chunks.length === 0) {
    throw new Error('No chunks generated from text');
  }

  // Phase 3: Embed
  onProgress({ phase: 'embedding', status: 'Generating embeddings...', completed: 0, total: chunks.length });
  const chunkTexts = chunks.map(function (c) { return c.text; });
  const embeddings = await embedBatch(chunkTexts, onProgress);

  // Phase 4: Ensure collection exists
  onProgress({ phase: 'store', status: 'Preparing collection...' });
  try {
    const existing = await qdrant.getCollection(collection);
    if (!existing) {
      await qdrant.createCollection(collection);
    }
  } catch (_e) {
    // Collection may already exist, continue
  }

  // Phase 5: Upsert to Qdrant
  onProgress({ phase: 'store', status: 'Storing vectors...', completed: 0, total: chunks.length });
  const filename = path.basename(filePath);
  const points = chunks.map(function (chunk, idx) {
    return {
      id: crypto.randomUUID(),
      vector: embeddings[idx],
      payload: {
        text: chunk.text,
        document_id: docId,
        filename: filename,
        chunk_index: chunk.chunkIndex,
        total_chunks: chunk.totalChunks,
        char_offset: chunk.charOffset,
        pages: pages,
        embedded_at: new Date().toISOString(),
        embed_model: EMBED_MODEL,
      },
    };
  });

  // Upsert in batches of 100
  for (let k = 0; k < points.length; k += 100) {
    const batch = points.slice(k, k + 100);
    await qdrant.upsertPoints(collection, batch);
    onProgress({
      phase: 'store',
      status: 'Storing vectors...',
      completed: Math.min(k + 100, points.length),
      total: points.length,
    });
  }

  return { chunkCount: chunks.length };
}

// ── Query & Search ────────────────────────────────────────────

async function searchDocuments(query, collection, limit) {
  const result = await ollamaEmbed([query]);
  const vector = result.embeddings[0];
  const hits = await qdrant.searchPoints(collection, vector, null, limit || 5);
  return hits;
}

async function askDocuments(query, collection, chatModel, limit) {
  // 1. Semantic search
  const hits = await searchDocuments(query, collection, limit || 5);

  if (hits.length === 0) {
    return { messages: null, hits: [] };
  }

  // 2. Build context with trust boundary wrappers (matching embed.sh pattern)
  const context = hits.map(function (h) {
    return '<retrieved_context source="' + (h.payload.filename || 'unknown') +
      '" chunk="' + (h.payload.chunk_index || 0) + '">\n' +
      h.payload.text + '\n</retrieved_context>';
  }).join('\n\n');

  // 3. Create chat messages
  const messages = [
    {
      role: 'system',
      content: 'Answer the user\'s question based on the following document context. ' +
        'Cite the source document and chunk when referencing information. ' +
        'If the answer is not in the provided context, say so clearly.\n\n' + context,
    },
    { role: 'user', content: query },
  ];

  return { messages: messages, hits: hits };
}

// ── Cleanup ───────────────────────────────────────────────────

async function deleteDocumentVectors(docId, collection) {
  await qdrant.deletePoints(collection, {
    must: [{ key: 'document_id', match: { value: docId } }],
  });
}

// ── Module Exports ────────────────────────────────────────────

module.exports = {
  DOCUMENTS_DIR,
  ensureDocumentsDir,
  computeFileHash,
  guessMime,
  extractText,
  chunkText,
  embedBatch,
  processDocument,
  searchDocuments,
  askDocuments,
  deleteDocumentVectors,
};

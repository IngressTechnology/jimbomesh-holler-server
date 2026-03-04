#!/bin/bash
# JimboMesh Holler Server — Embedding Pipeline (Ollama-compatible)
#
# Drop-in embedding pipeline that routes embeddings through a local
# Ollama instance instead of OpenRouter.
#
# Usage:
#   echo "some text" | ./scripts/embed.sh <collection> <point-key> [payload-json]
#
# Environment:
#   OLLAMA_URL          — default: http://jimbomesh-still:1920
#   OLLAMA_EMBED_MODEL  — default: nomic-embed-text
#   EMBED_DIMENSIONS    — default: 768 (nomic-embed-text native dimension)
#   QDRANT_URL          — default: http://jimbomesh-qdrant:6333
#   QDRANT_API_KEY      — required
#
# Differences from the OpenRouter version:
#   - Uses Ollama /api/embed endpoint instead of OpenRouter /api/v1/embeddings
#   - No OPENROUTER_API_KEY needed
#   - Default model is nomic-embed-text (768d) instead of text-embedding-3-small (1536d)
#   - Supports OPENROUTER_API_KEY fallback: if set and OLLAMA_URL is not, uses OpenRouter

set -e

COLLECTION="$1"
POINT_ID="$2"
if [ -n "$3" ]; then
    PAYLOAD_JSON="$3"
else
    PAYLOAD_JSON='{}'
fi

if [ -z "$COLLECTION" ] || [ -z "$POINT_ID" ]; then
    echo "Usage: echo 'text' | embed.sh <collection> <point-id> [payload-json]" >&2
    exit 1
fi

# Whitelist-validate COLLECTION against known Qdrant collection names.
case "$COLLECTION" in
    knowledge_base|memory|client_research) ;;
    *)
        echo "ERROR: unknown collection '${COLLECTION}' — must be one of: knowledge_base, memory, client_research" >&2
        exit 1
        ;;
esac

# Validate POINT_ID against a safe pattern.
case "$POINT_ID" in
    *[!a-z0-9A-Z._-]*)
        echo "ERROR: invalid point-id '${POINT_ID}' — must match [a-zA-Z0-9._-]+" >&2
        exit 1
        ;;
esac

# Source .env if available
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
fi

if [ -z "$QDRANT_API_KEY" ]; then
    echo "ERROR: QDRANT_API_KEY must be set" >&2
    exit 1
fi

# Determine embedding backend
OLLAMA="${OLLAMA_URL:-http://jimbomesh-still:1920}"
QDRANT="${QDRANT_URL:-http://jimbomesh-qdrant:6333}"
EMBED_MODEL="${OLLAMA_EMBED_MODEL:-nomic-embed-text}"
DIMENSIONS="${EMBED_DIMENSIONS:-768}"

# Read input text from stdin
INPUT_TEXT="$(cat)"

if [ -z "$INPUT_TEXT" ]; then
    echo "ERROR: no input text (pipe text via stdin)" >&2
    exit 1
fi

# Truncate to ~8000 tokens (~32000 chars) to stay within model limits
INPUT_TEXT="$(printf '%s' "$INPUT_TEXT" | head -c 32000)"
CHAR_COUNT="${#INPUT_TEXT}"

# Export for Node.js subprocesses
export EMBED_MODEL DIMENSIONS QDRANT_API_KEY INPUT_TEXT POINT_ID CHAR_COUNT PAYLOAD_JSON

# ── Call Ollama Embeddings API ─────────────────────────────────────

# Build the request JSON (Ollama /api/embed format)
EMBED_REQUEST="$(printf '%s' "$INPUT_TEXT" | node -e "$(cat <<'EMBED_JS'
const input = require('fs').readFileSync('/dev/stdin', 'utf8');
const req = {
    model: process.env.EMBED_MODEL,
    input: input
};
process.stdout.write(JSON.stringify(req));
EMBED_JS
)")"

EMBED_RESPONSE="$(curl -sf -X POST \
    "${OLLAMA}/api/embed" \
    -H "Content-Type: application/json" \
    -d "$EMBED_REQUEST")"

# Extract the embedding vector (Ollama returns { embeddings: [[...]] })
VECTOR="$(echo "$EMBED_RESPONSE" | node -e "$(cat <<'EXTRACT_JS'
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  try {
    const r=JSON.parse(d);
    if (r.embeddings && r.embeddings[0]) {
      process.stdout.write(JSON.stringify(r.embeddings[0]));
    } else if (r.embedding) {
      // Fallback for older Ollama versions
      process.stdout.write(JSON.stringify(r.embedding));
    } else {
      process.stderr.write('ERROR: unexpected embedding response: ' + d.substring(0, 200) + '\n');
      process.exit(1);
    }
  } catch(e) {
    process.stderr.write('ERROR: failed to parse embedding response: ' + e.message + '\n');
    process.exit(1);
  }
});
EXTRACT_JS
)")"

if [ -z "$VECTOR" ]; then
    echo "ERROR: embedding API returned no vector" >&2
    exit 1
fi

export VECTOR

# ── Upsert into Qdrant ─────────────────────────────────────────────

# Build upsert payload with trust boundary delimiters
UPSERT_BODY="$(node -e "$(cat <<'UPSERT_JS'
const crypto = require('crypto');
const vector = JSON.parse(process.env.VECTOR);
const payload = JSON.parse(process.env.PAYLOAD_JSON || '{}');
// Wrap text_preview in trust boundary delimiters
const source = payload.source || 'unknown';
const title = payload.title || payload.point_key || '';
payload.text_preview = '<retrieved_context source="' + source + '" title="' + title.replace(/"/g, '\\"') + '">\n' + process.env.INPUT_TEXT.substring(0, 2000) + '\n</retrieved_context>';
payload.embedded_at = new Date().toISOString();
payload.char_count = parseInt(process.env.CHAR_COUNT);
payload.point_key = process.env.POINT_ID;
payload.embed_model = process.env.EMBED_MODEL;
payload.embed_source = 'ollama';
// Derive deterministic UUID from point-id string
const hash = crypto.createHash('sha256').update(process.env.POINT_ID).digest('hex');
const uuid = hash.substring(0,8) + '-' + hash.substring(8,12) + '-4' + hash.substring(13,16) + '-a' + hash.substring(17,20) + '-' + hash.substring(20,32);
const body = {
    points: [{
        id: uuid,
        vector: vector,
        payload: payload
    }]
};
process.stdout.write(JSON.stringify(body));
UPSERT_JS
)")"

# Upsert into Qdrant
HTTP_STATUS="$(curl -sf -o /dev/null -w "%{http_code}" -X PUT \
    "${QDRANT}/collections/${COLLECTION}/points" \
    -H "Content-Type: application/json" \
    -H "api-key: ${QDRANT_API_KEY}" \
    -d "$UPSERT_BODY")"

if [ "$HTTP_STATUS" = "200" ]; then
    echo "[embed] upserted ${POINT_ID} into ${COLLECTION} (${CHAR_COUNT} chars, ${DIMENSIONS}d, model=${EMBED_MODEL})"
else
    echo "ERROR: Qdrant upsert failed (HTTP ${HTTP_STATUS})" >&2
    exit 1
fi

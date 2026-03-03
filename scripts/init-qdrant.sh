#!/bin/sh
# JimboMesh Holler Server — Qdrant Collection Initializer
# Creates the standard Qdrant collections for knowledge base applications, configured
# for the local embedding model's dimensions (default: 768 for nomic-embed-text).
#
# This runs as a one-shot init container in docker-compose.

set -e

QDRANT="${QDRANT_URL:-http://jimbomesh-holler-qdrant:6333}"
DIMENSIONS="${EMBED_DIMENSIONS:-768}"
API_KEY="${QDRANT_API_KEY}"

if [ -z "$API_KEY" ]; then
    echo "[init-qdrant] ERROR: QDRANT_API_KEY must be set" >&2
    exit 1
fi

echo "[init-qdrant] initializing collections (${DIMENSIONS} dimensions)..."

# Create each collection if it doesn't already exist
for COLLECTION in knowledge_base memory client_research; do
    # Check if collection exists (no -f flag so curl doesn't fail on 404)
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "api-key: ${API_KEY}" \
        "${QDRANT}/collections/${COLLECTION}")

    if [ "$HTTP_STATUS" = "200" ]; then
        echo "[init-qdrant] ${COLLECTION} — already exists, skipping"
        continue
    fi

    echo "[init-qdrant] creating collection: ${COLLECTION}"

    CREATE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
        "${QDRANT}/collections/${COLLECTION}" \
        -H "Content-Type: application/json" \
        -H "api-key: ${API_KEY}" \
        -d "{
            \"vectors\": {
                \"size\": ${DIMENSIONS},
                \"distance\": \"Cosine\"
            }
        }")

    if [ "$CREATE_STATUS" = "200" ] || [ "$CREATE_STATUS" = "409" ]; then
        echo "[init-qdrant] ${COLLECTION} — created (HTTP ${CREATE_STATUS})"
    else
        echo "[init-qdrant] WARNING: ${COLLECTION} — unexpected status ${CREATE_STATUS}" >&2
    fi

    # Create payload indexes for common query patterns
    for FIELD in source tags client; do
        curl -s -o /dev/null -X PUT \
            "${QDRANT}/collections/${COLLECTION}/index" \
            -H "Content-Type: application/json" \
            -H "api-key: ${API_KEY}" \
            -d "{
                \"field_name\": \"${FIELD}\",
                \"field_schema\": \"keyword\"
            }" || true
    done

    echo "[init-qdrant] ${COLLECTION} — indexes created"
done

echo "[init-qdrant] done — all collections ready"

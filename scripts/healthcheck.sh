#!/bin/bash
# JimboMesh Holler Server — Health Check
# Verifies Ollama is responsive and the embedding model is loaded.
# Tries the HTTP health endpoint first, falls back to direct checks.

EMBED_MODEL="${OLLAMA_EMBED_MODEL:-nomic-embed-text}"
HEALTH_PORT="${HEALTH_PORT:-9090}"

# Try HTTP health endpoint first (preferred)
if curl -sf "http://localhost:${HEALTH_PORT}/readyz" > /dev/null 2>&1; then
    echo "HEALTHY (via health server)"
    exit 0
fi

# Fall back to direct checks if health server isn't running
# Check if Ollama API is responding
if ! curl -sf "http://localhost:${OLLAMA_INTERNAL_PORT:-11435}/api/tags" > /dev/null 2>&1; then
    echo "UNHEALTHY: Ollama API not responding"
    exit 1
fi

# Check if the embedding model is available
if ! ollama list 2>/dev/null | grep -q "${EMBED_MODEL}"; then
    echo "UNHEALTHY: embedding model ${EMBED_MODEL} not available"
    exit 1
fi

echo "HEALTHY"
exit 0

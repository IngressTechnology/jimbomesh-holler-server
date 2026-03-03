#!/bin/bash
# JimboMesh Holler Server — Entrypoint
# Starts Ollama, waits for readiness, pulls required models, then keeps serving.

set -e

echo "[jimbomesh-still] starting Ollama server..."

# Start Ollama in the background
ollama serve &
OLLAMA_PID=$!

# Wait for Ollama to become ready
echo "[jimbomesh-still] waiting for Ollama to be ready..."
MAX_WAIT=60
WAITED=0
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
    if [ $WAITED -ge $MAX_WAIT ]; then
        echo "[jimbomesh-still] ERROR: Ollama failed to start within ${MAX_WAIT}s"
        exit 1
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

echo "[jimbomesh-still] Ollama is ready (waited ${WAITED}s)"

# Pull required models
/opt/jimbomesh-still/pull-models.sh

echo "[jimbomesh-still] all models ready — serving on :11434"

# Keep the server running
wait $OLLAMA_PID

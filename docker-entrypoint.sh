#!/bin/bash
set -e

# JimboMesh Holler Server — Container Entrypoint
# Starts Ollama on internal port, API gateway with auth, health server,
# pulls models, then keeps serving. Handles graceful shutdown of all processes.

echo "[jimbomesh-still] starting container..."

HEALTH_PORT="${HEALTH_PORT:-9090}"
GATEWAY_PORT="${GATEWAY_PORT:-1920}"
OLLAMA_INTERNAL_PORT="${OLLAMA_INTERNAL_PORT:-11435}"
HEALTH_PID=""
GATEWAY_PID=""
OLLAMA_PID=""

# Ensure SQLite data directory exists
mkdir -p /opt/jimbomesh-still/data
# Named volumes can be created as root-owned; gateway runs as jimbomesh.
# Ensure the runtime DB directory is writable before dropping privileges.
chown -R jimbomesh:jimbomesh /opt/jimbomesh-still/data
chmod 775 /opt/jimbomesh-still/data

# Ensure API key is set — auto-generate on first run if missing
if [ -z "$JIMBOMESH_HOLLER_API_KEY" ]; then
    if [ "$HOLLER_ALLOW_UNAUTHENTICATED" = "true" ]; then
        echo "[jimbomesh-still] WARNING: Running without authentication (HOLLER_ALLOW_UNAUTHENTICATED=true)"
    else
        JIMBOMESH_HOLLER_API_KEY=$(openssl rand -hex 32)
        export JIMBOMESH_HOLLER_API_KEY
        echo "[jimbomesh-still] No API key configured — auto-generated one for this session."
        echo "[jimbomesh-still] Key: ${JIMBOMESH_HOLLER_API_KEY:0:8}...${JIMBOMESH_HOLLER_API_KEY: -4}"
        echo "[jimbomesh-still] Set JIMBOMESH_HOLLER_API_KEY in .env to persist across restarts."
    fi
fi

# Graceful shutdown — kill all child processes on SIGTERM/SIGINT
cleanup() {
    echo "[jimbomesh-still] shutting down..."
    [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null
    [ -n "$HEALTH_PID" ] && kill "$HEALTH_PID" 2>/dev/null
    [ -n "$OLLAMA_PID" ] && kill "$OLLAMA_PID" 2>/dev/null
    wait
    exit 0
}
trap cleanup SIGTERM SIGINT

# --- Ollama Backend -----------------------------------------------------------
# Standard mode: start Ollama internally on localhost:${OLLAMA_INTERNAL_PORT}
# Mac Performance Mode: use native Ollama on host (OLLAMA_EXTERNAL_URL set by
#   docker-compose.mac.yml) — skips internal Ollama, enables Metal GPU via host.

if [ -n "$OLLAMA_EXTERNAL_URL" ]; then
    # Performance Mode — external Ollama (macOS native with Metal GPU)
    echo "[jimbomesh-still] External Ollama mode: ${OLLAMA_EXTERNAL_URL}"

    # Point the Ollama CLI to the external instance (for model pulls)
    _OLLAMA_CLI_HOST="${OLLAMA_EXTERNAL_URL#http://}"
    _OLLAMA_CLI_HOST="${_OLLAMA_CLI_HOST#https://}"
    export OLLAMA_HOST="${_OLLAMA_CLI_HOST}"

    # Point the gateway to the external URL
    export OLLAMA_INTERNAL_URL="${OLLAMA_EXTERNAL_URL}"

    # Wait for external Ollama to be reachable (max 60s)
    echo "[jimbomesh-still] waiting for external Ollama at ${OLLAMA_EXTERNAL_URL}..."
    MAX_WAIT=60
    WAITED=0
    until curl -sf "${OLLAMA_EXTERNAL_URL}/api/tags" > /dev/null 2>&1; do
        if [ $WAITED -ge $MAX_WAIT ]; then
            echo "[jimbomesh-still] WARNING: external Ollama not reachable after ${MAX_WAIT}s — continuing anyway"
            break
        fi
        sleep 1
        WAITED=$((WAITED + 1))
    done
    echo "[jimbomesh-still] external Ollama ready (waited ${WAITED}s)"
else
    # Standard mode: start Ollama on internal port (localhost only)
    export OLLAMA_HOST="127.0.0.1:${OLLAMA_INTERNAL_PORT}"
    ollama serve &
    OLLAMA_PID=$!

    # Wait for Ollama to become ready (check internal port)
    echo "[jimbomesh-still] waiting for Ollama API on :${OLLAMA_INTERNAL_PORT}..."
    MAX_WAIT=120
    WAITED=0
    until curl -sf "http://localhost:${OLLAMA_INTERNAL_PORT}/api/tags" > /dev/null 2>&1; do
        if [ $WAITED -ge $MAX_WAIT ]; then
            echo "[jimbomesh-still] ERROR: Ollama failed to start within ${MAX_WAIT}s"
            exit 1
        fi
        sleep 1
        WAITED=$((WAITED + 1))
    done
    echo "[jimbomesh-still] Ollama API ready on :${OLLAMA_INTERNAL_PORT} (waited ${WAITED}s)"
fi

# Start API gateway (always — auth is enforced unless HOLLER_ALLOW_UNAUTHENTICATED=true)
if [ -n "$JIMBOMESH_HOLLER_API_KEY" ]; then
    echo "[jimbomesh-still] starting API gateway on :${GATEWAY_PORT} (with auth)"
else
    echo "[jimbomesh-still] starting API gateway on :${GATEWAY_PORT} (no auth — unauthenticated mode)"
fi
# In standard mode OLLAMA_INTERNAL_URL is set here; in external mode it was set above
if [ -z "$OLLAMA_EXTERNAL_URL" ]; then
    export OLLAMA_INTERNAL_URL="http://127.0.0.1:${OLLAMA_INTERNAL_PORT}"
fi
su -s /bin/bash -c "node /opt/jimbomesh-still/api-gateway.js" jimbomesh &
GATEWAY_PID=$!

# Start health server in background as non-root user
su -s /bin/bash -c "node /opt/jimbomesh-still/health-server.js" jimbomesh &
HEALTH_PID=$!

# Pull required models (idempotent — skips if already present)
MODELS="${HOLLER_MODELS:-nomic-embed-text,llama3.1:8b}"
echo "[jimbomesh-still] configured models: ${MODELS}"

IFS=','
for MODEL in $MODELS; do
    MODEL=$(echo "$MODEL" | xargs) # trim whitespace
    [ -z "$MODEL" ] && continue

    if ollama list 2>/dev/null | grep -q "^${MODEL}"; then
        echo "[jimbomesh-still] ${MODEL} — already present"
    else
        echo "[jimbomesh-still] pulling ${MODEL}..."
        ollama pull "$MODEL"
        echo "[jimbomesh-still] ${MODEL} — done"
    fi
done
unset IFS

if [ -n "$JIMBOMESH_HOLLER_API_KEY" ]; then
    echo "[jimbomesh-still] all models ready — API gateway on :${GATEWAY_PORT} (auth), health on :${HEALTH_PORT}"
    echo "[jimbomesh-still] API requests require X-API-Key header"
else
    echo "[jimbomesh-still] all models ready — Ollama on :${OLLAMA_INTERNAL_PORT} (no auth), health on :${HEALTH_PORT}"
fi

# Keep the servers running (wait for all child processes)
wait

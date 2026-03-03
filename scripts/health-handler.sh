#!/bin/bash
# JimboMesh Holler Server — HTTP Health Check Handler
# Called by socat for each incoming connection. Reads HTTP request from stdin,
# routes by path, runs checks, writes HTTP response with JSON body to stdout.

OLLAMA_URL="http://localhost:${OLLAMA_INTERNAL_PORT:-11435}"
EMBED_MODEL="${OLLAMA_EMBED_MODEL:-nomic-embed-text}"
HEALTH_WARMUP="${HEALTH_WARMUP:-false}"

# ── Read HTTP request ────────────────────────────────────────────────────────
read -r REQUEST_LINE
METHOD=$(echo "$REQUEST_LINE" | awk '{print $1}')
PATH_INFO=$(echo "$REQUEST_LINE" | awk '{print $2}')

# Consume remaining headers (read until blank line)
while IFS= read -r header; do
    header=$(echo "$header" | tr -d '\r')
    [ -z "$header" ] && break
done

# ── HTTP response helpers ────────────────────────────────────────────────────
respond() {
    local status_code="$1"
    local status_text="$2"
    local body="$3"
    local content_length=${#body}
    printf "HTTP/1.1 %s %s\r\n" "$status_code" "$status_text"
    printf "Content-Type: application/json\r\n"
    printf "Content-Length: %d\r\n" "$content_length"
    printf "Connection: close\r\n"
    printf "\r\n"
    printf "%s" "$body"
}

timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# ── Only allow GET and HEAD ──────────────────────────────────────────────────
if [ "$METHOD" != "GET" ] && [ "$METHOD" != "HEAD" ]; then
    body=$(cat <<EOF
{"error":"method_not_allowed","message":"Only GET is supported","allowed":["GET"]}
EOF
)
    respond 405 "Method Not Allowed" "$body"
    exit 0
fi

# ── Check Ollama API (shared by all health endpoints) ────────────────────────
check_ollama_api() {
    curl -sf --max-time 5 "${OLLAMA_URL}/api/tags" > /dev/null 2>&1
}

# ── /healthz — Liveness probe ───────────────────────────────────────────────
handle_healthz() {
    local start_ms=$(date +%s%3N)

    if check_ollama_api; then
        local end_ms=$(date +%s%3N)
        local latency=$((end_ms - start_ms))
        body=$(cat <<EOF
{"status":"ok","check":"liveness","ollama_api":true,"latency_ms":${latency},"timestamp":"$(timestamp)"}
EOF
)
        respond 200 "OK" "$body"
    else
        local end_ms=$(date +%s%3N)
        local latency=$((end_ms - start_ms))
        body=$(cat <<EOF
{"status":"error","check":"liveness","ollama_api":false,"latency_ms":${latency},"timestamp":"$(timestamp)"}
EOF
)
        respond 503 "Service Unavailable" "$body"
    fi
}

# ── /readyz — Readiness probe ───────────────────────────────────────────────
handle_readyz() {
    local start_ms=$(date +%s%3N)
    local checks_passed=0
    local checks_total=2
    local api_ok=false
    local model_ok=false
    local warmup_status="skipped"
    local warmup_latency=0

    # Check 1: Ollama API responding
    if check_ollama_api; then
        api_ok=true
        checks_passed=$((checks_passed + 1))
    fi

    # Check 2: Embedding model available
    if [ "$api_ok" = true ] && ollama list 2>/dev/null | grep -q "${EMBED_MODEL}"; then
        model_ok=true
        checks_passed=$((checks_passed + 1))
    fi

    # Optional Check 3: Warmup test embedding
    if [ "$HEALTH_WARMUP" = "true" ] && [ "$model_ok" = true ]; then
        checks_total=3
        local warmup_start=$(date +%s%3N)
        local warmup_result
        warmup_result=$(curl -sf --max-time 10 "${OLLAMA_URL}/api/embed" \
            -d "{\"model\":\"${EMBED_MODEL}\",\"input\":\"health check warmup\"}" 2>/dev/null)
        if echo "$warmup_result" | grep -q '"embeddings"'; then
            warmup_status="ok"
            checks_passed=$((checks_passed + 1))
        else
            warmup_status="failed"
        fi
        warmup_latency=$(( $(date +%s%3N) - warmup_start ))
    fi

    local end_ms=$(date +%s%3N)
    local latency=$((end_ms - start_ms))

    if [ "$checks_passed" -eq "$checks_total" ]; then
        body=$(cat <<EOF
{"status":"ok","check":"readiness","checks_passed":${checks_passed},"checks_total":${checks_total},"ollama_api":${api_ok},"model_available":${model_ok},"model":"${EMBED_MODEL}","warmup":"${warmup_status}","warmup_latency_ms":${warmup_latency},"latency_ms":${latency},"timestamp":"$(timestamp)"}
EOF
)
        respond 200 "OK" "$body"
    else
        body=$(cat <<EOF
{"status":"error","check":"readiness","checks_passed":${checks_passed},"checks_total":${checks_total},"ollama_api":${api_ok},"model_available":${model_ok},"model":"${EMBED_MODEL}","warmup":"${warmup_status}","warmup_latency_ms":${warmup_latency},"latency_ms":${latency},"timestamp":"$(timestamp)"}
EOF
)
        respond 503 "Service Unavailable" "$body"
    fi
}

# ── /status — Info/debug endpoint ───────────────────────────────────────────
handle_status() {
    local start_ms=$(date +%s%3N)

    if check_ollama_api; then
        local tags_json
        tags_json=$(curl -sf --max-time 5 "${OLLAMA_URL}/api/tags" 2>/dev/null)
        local model_list
        model_list=$(echo "$tags_json" | jq -c '[.models[].name]' 2>/dev/null || echo '[]')
        local model_count
        model_count=$(echo "$tags_json" | jq '.models | length' 2>/dev/null || echo 0)

        local end_ms=$(date +%s%3N)
        local latency=$((end_ms - start_ms))
        body=$(cat <<EOF
{"status":"ok","ollama_api":true,"models":${model_list},"model_count":${model_count},"embed_model":"${EMBED_MODEL}","health_warmup":"${HEALTH_WARMUP}","latency_ms":${latency},"timestamp":"$(timestamp)"}
EOF
)
        respond 200 "OK" "$body"
    else
        local end_ms=$(date +%s%3N)
        local latency=$((end_ms - start_ms))
        body=$(cat <<EOF
{"status":"error","ollama_api":false,"models":[],"model_count":0,"embed_model":"${EMBED_MODEL}","health_warmup":"${HEALTH_WARMUP}","latency_ms":${latency},"timestamp":"$(timestamp)"}
EOF
)
        respond 503 "Service Unavailable" "$body"
    fi
}

# ── Route by path ────────────────────────────────────────────────────────────
case "$PATH_INFO" in
    /healthz)
        handle_healthz
        ;;
    /readyz)
        handle_readyz
        ;;
    /status)
        handle_status
        ;;
    *)
        body=$(cat <<EOF
{"error":"not_found","message":"Unknown endpoint","available_endpoints":["/healthz","/readyz","/status"]}
EOF
)
        respond 404 "Not Found" "$body"
        ;;
esac

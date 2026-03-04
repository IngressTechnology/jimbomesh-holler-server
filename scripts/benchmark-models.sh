#!/bin/bash
# JimboMesh Holler Server — Embedding Model Benchmark
#
# Benchmarks embedding models for quality and speed comparison.
# Pulls each model (if not present), runs embedding latency tests,
# and outputs a comparison table.
#
# Usage:
#   ./scripts/benchmark-models.sh                    # Benchmark all default models
#   ./scripts/benchmark-models.sh nomic-embed-text   # Benchmark a single model
#   ./scripts/benchmark-models.sh --help             # Show help
#
# Environment:
#   OLLAMA_URL       — Ollama API endpoint (default: http://localhost:1920)
#   JIMBOMESH_HOLLER_API_KEY   — API key for authentication (required if gateway is enabled)
#   BENCH_ROUNDS     — Number of rounds per test (default: 5)
#   BENCH_WARMUP     — Number of warmup rounds (default: 1)
#
# Output:
#   Prints a markdown-formatted comparison table to stdout.
#   Raw results are saved to benchmark-results.json.

set -e

# ── Configuration ──────────────────────────────────────────────────

OLLAMA_URL="${OLLAMA_URL:-http://localhost:1920}"
API_KEY="${JIMBOMESH_HOLLER_API_KEY:-}"
ROUNDS="${BENCH_ROUNDS:-5}"
WARMUP="${BENCH_WARMUP:-1}"
RESULTS_FILE="benchmark-results.json"

# Default models to benchmark
DEFAULT_MODELS=(
    "nomic-embed-text"
    "mxbai-embed-large"
    "snowflake-arctic-embed"
    "all-minilm"
)

# Model metadata (dimensions, approximate size)
declare -A MODEL_DIMS=(
    ["nomic-embed-text"]="768"
    ["mxbai-embed-large"]="1024"
    ["snowflake-arctic-embed"]="1024"
    ["all-minilm"]="384"
    ["bge-large"]="1024"
)

declare -A MODEL_SIZES=(
    ["nomic-embed-text"]="274 MB"
    ["mxbai-embed-large"]="670 MB"
    ["snowflake-arctic-embed"]="670 MB"
    ["all-minilm"]="45 MB"
    ["bge-large"]="670 MB"
)

# ── Test Data ──────────────────────────────────────────────────────

# Short text (~50 tokens)
TEXT_SHORT="The quick brown fox jumps over the lazy dog. This is a simple test sentence for embedding models."

# Medium text (~200 tokens)
TEXT_MEDIUM="Artificial intelligence has transformed how businesses operate. Machine learning models can process vast amounts of data, identify patterns, and make predictions with remarkable accuracy. Natural language processing enables computers to understand and generate human language, powering applications from chatbots to document analysis. Vector embeddings represent text as high-dimensional numerical arrays, enabling semantic search and retrieval. The quality of these embeddings directly impacts the relevance of search results and the effectiveness of retrieval-augmented generation systems."

# Long text (~500 tokens)
TEXT_LONG="In the rapidly evolving landscape of enterprise software, the integration of AI-powered knowledge management systems has become a critical competitive advantage. Organizations generate enormous volumes of unstructured data across multiple platforms: Notion pages, Confluence wikis, Slack conversations, email threads, CRM notes, and internal documentation. The challenge lies not just in storing this information, but in making it instantly retrievable and contextually relevant when needed.

Vector embedding models play a central role in this retrieval pipeline. When a user queries the system, their question is embedded into the same vector space as the stored documents, and a similarity search finds the most relevant context. The quality of these embeddings determines whether the system returns truly helpful information or irrelevant noise.

Several factors influence embedding model selection for production use: embedding quality (measured by retrieval accuracy on domain-specific data), inference latency (critical for real-time applications), model size (affects deployment resources and cold-start times), and dimension count (higher dimensions capture more nuance but increase storage and compute costs). For on-premises deployments running Ollama, the trade-offs become even more pronounced since all computation happens on local hardware without cloud GPU acceleration.

This benchmark evaluates the embedding models available through Ollama that are most relevant to knowledge management and RAG applications, measuring both speed and quality metrics to help teams make informed decisions about which model best fits their specific requirements and hardware constraints."

# Batch of 5 texts for batch latency testing
BATCH_TEXTS='["The quick brown fox jumps over the lazy dog.", "Machine learning transforms business operations daily.", "Vector embeddings enable semantic search and retrieval.", "Natural language processing powers modern AI applications.", "Knowledge management systems organize enterprise data."]'

# ── Helper Functions ───────────────────────────────────────────────

usage() {
    echo "Usage: $0 [model1] [model2] ..."
    echo ""
    echo "Benchmarks embedding models for speed comparison."
    echo ""
    echo "Arguments:"
    echo "  model1, model2, ...   Models to benchmark (default: all)"
    echo "  --help                Show this help"
    echo ""
    echo "Environment:"
    echo "  OLLAMA_URL       Ollama endpoint (default: http://localhost:1920)"
    echo "  JIMBOMESH_HOLLER_API_KEY   API key for authentication"
    echo "  BENCH_ROUNDS     Rounds per test (default: 5)"
    echo "  BENCH_WARMUP     Warmup rounds (default: 1)"
    echo ""
    echo "Default models: ${DEFAULT_MODELS[*]}"
    exit 0
}

auth_header() {
    if [ -n "$API_KEY" ]; then
        echo "-H \"X-API-Key: ${API_KEY}\""
    fi
}

# Check if Ollama is reachable
check_ollama() {
    local status
    if [ -n "$API_KEY" ]; then
        status=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "X-API-Key: ${API_KEY}" \
            "${OLLAMA_URL}/api/tags" 2>/dev/null)
    else
        status=$(curl -s -o /dev/null -w "%{http_code}" \
            "${OLLAMA_URL}/api/tags" 2>/dev/null)
    fi
    if [ "$status" != "200" ]; then
        echo "ERROR: Cannot reach Ollama at ${OLLAMA_URL} (HTTP ${status})" >&2
        echo "  Make sure the server is running and JIMBOMESH_HOLLER_API_KEY is set correctly." >&2
        exit 1
    fi
}

# Pull a model if not already present
ensure_model() {
    local model="$1"
    echo "  Checking ${model}..."

    local response
    if [ -n "$API_KEY" ]; then
        response=$(curl -s -H "X-API-Key: ${API_KEY}" "${OLLAMA_URL}/api/tags")
    else
        response=$(curl -s "${OLLAMA_URL}/api/tags")
    fi

    if echo "$response" | grep -q "\"${model}\""; then
        echo "  ${model} — already pulled"
        return 0
    fi

    echo "  ${model} — pulling (this may take a few minutes)..."
    if [ -n "$API_KEY" ]; then
        curl -s -H "X-API-Key: ${API_KEY}" \
            -X POST "${OLLAMA_URL}/api/pull" \
            -d "{\"name\": \"${model}\"}" > /dev/null
    else
        curl -s -X POST "${OLLAMA_URL}/api/pull" \
            -d "{\"name\": \"${model}\"}" > /dev/null
    fi
    echo "  ${model} — pulled"
}

# Run a single embedding and return latency in milliseconds
embed_latency() {
    local model="$1"
    local text="$2"
    local start end elapsed

    start=$(date +%s%N)

    if [ -n "$API_KEY" ]; then
        curl -s -o /dev/null \
            -H "X-API-Key: ${API_KEY}" \
            -H "Content-Type: application/json" \
            -X POST "${OLLAMA_URL}/api/embed" \
            -d "{\"model\": \"${model}\", \"input\": $(printf '%s' "$text" | jq -Rs .)}"
    else
        curl -s -o /dev/null \
            -H "Content-Type: application/json" \
            -X POST "${OLLAMA_URL}/api/embed" \
            -d "{\"model\": \"${model}\", \"input\": $(printf '%s' "$text" | jq -Rs .)}"
    fi

    end=$(date +%s%N)
    elapsed=$(( (end - start) / 1000000 ))
    echo "$elapsed"
}

# Run a batch embedding and return latency in milliseconds
embed_batch_latency() {
    local model="$1"
    local batch="$2"
    local start end elapsed

    start=$(date +%s%N)

    if [ -n "$API_KEY" ]; then
        curl -s -o /dev/null \
            -H "X-API-Key: ${API_KEY}" \
            -H "Content-Type: application/json" \
            -X POST "${OLLAMA_URL}/api/embed" \
            -d "{\"model\": \"${model}\", \"input\": ${batch}}"
    else
        curl -s -o /dev/null \
            -H "Content-Type: application/json" \
            -X POST "${OLLAMA_URL}/api/embed" \
            -d "{\"model\": \"${model}\", \"input\": ${batch}}"
    fi

    end=$(date +%s%N)
    elapsed=$(( (end - start) / 1000000 ))
    echo "$elapsed"
}

# Get actual embedding dimensions from a model
get_dimensions() {
    local model="$1"
    local response

    if [ -n "$API_KEY" ]; then
        response=$(curl -s \
            -H "X-API-Key: ${API_KEY}" \
            -H "Content-Type: application/json" \
            -X POST "${OLLAMA_URL}/api/embed" \
            -d "{\"model\": \"${model}\", \"input\": \"test\"}")
    else
        response=$(curl -s \
            -H "Content-Type: application/json" \
            -X POST "${OLLAMA_URL}/api/embed" \
            -d "{\"model\": \"${model}\", \"input\": \"test\"}")
    fi

    echo "$response" | jq '.embeddings[0] | length'
}

# Calculate median from a list of numbers
median() {
    local sorted
    sorted=$(echo "$@" | tr ' ' '\n' | sort -n)
    local count
    count=$(echo "$sorted" | wc -l)
    local mid=$(( (count + 1) / 2 ))
    echo "$sorted" | sed -n "${mid}p"
}

# Calculate mean from a list of numbers
mean() {
    local sum=0
    local count=0
    for val in $@; do
        sum=$((sum + val))
        count=$((count + 1))
    done
    echo $((sum / count))
}

# ── Main ───────────────────────────────────────────────────────────

# Parse arguments
MODELS=()
for arg in "$@"; do
    case "$arg" in
        --help|-h) usage ;;
        *) MODELS+=("$arg") ;;
    esac
done

if [ ${#MODELS[@]} -eq 0 ]; then
    MODELS=("${DEFAULT_MODELS[@]}")
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         JimboMesh Embedding Model Benchmark                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Server:    ${OLLAMA_URL}"
echo "Rounds:    ${ROUNDS} (+ ${WARMUP} warmup)"
echo "Models:    ${MODELS[*]}"
echo "Output:    ${RESULTS_FILE}"
echo ""

# Check connectivity
echo "── Connectivity Check ──"
check_ollama
echo "  Ollama is reachable"
echo ""

# Ensure all models are available
echo "── Model Setup ──"
for model in "${MODELS[@]}"; do
    ensure_model "$model"
done
echo ""

# Initialize results JSON
echo '{"benchmark": {"server": "'"${OLLAMA_URL}"'", "rounds": '"${ROUNDS}"', "warmup": '"${WARMUP}"', "date": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}, "results": []}' > "$RESULTS_FILE"

# Run benchmarks
echo "── Running Benchmarks ──"
echo ""

# Collect results for the summary table
declare -A RESULT_DIMS
declare -A RESULT_SHORT
declare -A RESULT_MEDIUM
declare -A RESULT_LONG
declare -A RESULT_BATCH

for model in "${MODELS[@]}"; do
    echo "  Model: ${model}"
    echo "  ─────────────────────────────"

    # Get actual dimensions
    dims=$(get_dimensions "$model")
    RESULT_DIMS["$model"]="$dims"
    echo "    Dimensions: ${dims}"

    # Warmup
    echo -n "    Warmup: "
    for ((i=0; i<WARMUP; i++)); do
        embed_latency "$model" "$TEXT_SHORT" > /dev/null
        echo -n "."
    done
    echo " done"

    # Short text benchmark
    echo -n "    Short text (~50 tokens): "
    latencies_short=()
    for ((i=0; i<ROUNDS; i++)); do
        lat=$(embed_latency "$model" "$TEXT_SHORT")
        latencies_short+=("$lat")
        echo -n "${lat}ms "
    done
    median_short=$(median "${latencies_short[@]}")
    mean_short=$(mean "${latencies_short[@]}")
    RESULT_SHORT["$model"]="$median_short"
    echo "→ median ${median_short}ms"

    # Medium text benchmark
    echo -n "    Medium text (~200 tokens): "
    latencies_medium=()
    for ((i=0; i<ROUNDS; i++)); do
        lat=$(embed_latency "$model" "$TEXT_MEDIUM")
        latencies_medium+=("$lat")
        echo -n "${lat}ms "
    done
    median_medium=$(median "${latencies_medium[@]}")
    mean_medium=$(mean "${latencies_medium[@]}")
    RESULT_MEDIUM["$model"]="$median_medium"
    echo "→ median ${median_medium}ms"

    # Long text benchmark
    echo -n "    Long text (~500 tokens): "
    latencies_long=()
    for ((i=0; i<ROUNDS; i++)); do
        lat=$(embed_latency "$model" "$TEXT_LONG")
        latencies_long+=("$lat")
        echo -n "${lat}ms "
    done
    median_long=$(median "${latencies_long[@]}")
    mean_long=$(mean "${latencies_long[@]}")
    RESULT_LONG["$model"]="$median_long"
    echo "→ median ${median_long}ms"

    # Batch embedding benchmark (5 texts)
    echo -n "    Batch (5 texts): "
    latencies_batch=()
    for ((i=0; i<ROUNDS; i++)); do
        lat=$(embed_batch_latency "$model" "$BATCH_TEXTS")
        latencies_batch+=("$lat")
        echo -n "${lat}ms "
    done
    median_batch=$(median "${latencies_batch[@]}")
    mean_batch=$(mean "${latencies_batch[@]}")
    RESULT_BATCH["$model"]="$median_batch"
    echo "→ median ${median_batch}ms"

    # Append to results JSON
    model_json=$(jq -n \
        --arg model "$model" \
        --argjson dims "$dims" \
        --arg size "${MODEL_SIZES[$model]:-unknown}" \
        --argjson short_median "$median_short" \
        --argjson short_mean "$mean_short" \
        --argjson medium_median "$median_medium" \
        --argjson medium_mean "$mean_medium" \
        --argjson long_median "$median_long" \
        --argjson long_mean "$mean_long" \
        --argjson batch_median "$median_batch" \
        --argjson batch_mean "$mean_batch" \
        '{model: $model, dimensions: $dims, size: $size, latency: {short: {median_ms: $short_median, mean_ms: $short_mean}, medium: {median_ms: $medium_median, mean_ms: $medium_mean}, long: {median_ms: $long_median, mean_ms: $long_mean}, batch_5: {median_ms: $batch_median, mean_ms: $batch_mean}}}')

    # Update results file
    jq --argjson result "$model_json" '.results += [$result]' "$RESULTS_FILE" > "${RESULTS_FILE}.tmp" \
        && mv "${RESULTS_FILE}.tmp" "$RESULTS_FILE"

    echo ""
done

# ── Summary Table ──────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════════════════════════════════════╗"
echo "║                              Benchmark Results                                  ║"
echo "╚══════════════════════════════════════════════════════════════════════════════════╝"
echo ""
echo "All latencies are median values in milliseconds (lower is better)."
echo ""
printf "| %-24s | %4s | %8s | %8s | %9s | %10s | %8s |\n" \
    "Model" "Dims" "Size" "Short" "Medium" "Long" "Batch(5)"
printf "|%-26s|%6s|%10s|%10s|%11s|%12s|%10s|\n" \
    "--------------------------" "------" "----------" "----------" "-----------" "------------" "----------"

for model in "${MODELS[@]}"; do
    printf "| %-24s | %4s | %8s | %5s ms | %6s ms | %7s ms | %5s ms |\n" \
        "$model" \
        "${RESULT_DIMS[$model]}" \
        "${MODEL_SIZES[$model]:-?}" \
        "${RESULT_SHORT[$model]}" \
        "${RESULT_MEDIUM[$model]}" \
        "${RESULT_LONG[$model]}" \
        "${RESULT_BATCH[$model]}"
done

echo ""
echo "Results saved to ${RESULTS_FILE}"
echo ""
echo "Notes:"
echo "  - Short: ~50 tokens, Medium: ~200 tokens, Long: ~500 tokens"
echo "  - Batch: 5 short texts in a single API call"
echo "  - Results vary by hardware. Run on your deployment target for accurate numbers."
echo "  - First run after model pull may be slower (cold start)."

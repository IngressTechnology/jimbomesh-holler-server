#!/bin/bash
# JimboMesh Holler Server — Model Puller
# Pulls all models specified in HOLLER_MODELS (comma-separated).
# Skips models that are already present.

set -e

# Default models: embedding model + a general-purpose LLM
# HOLLER_MODELS can be overridden via environment variable
MODELS="${HOLLER_MODELS:-nomic-embed-text,llama3.1:8b}"

echo "[pull-models] configured models: ${MODELS}"

IFS=',' read -ra MODEL_LIST <<< "$MODELS"

for MODEL in "${MODEL_LIST[@]}"; do
    MODEL="$(echo "$MODEL" | xargs)" # trim whitespace

    if [ -z "$MODEL" ]; then
        continue
    fi

    # Check if model is already pulled
    if ollama list 2>/dev/null | grep -q "^${MODEL}"; then
        echo "[pull-models] ${MODEL} — already present, skipping"
    else
        echo "[pull-models] pulling ${MODEL}..."
        ollama pull "$MODEL"
        echo "[pull-models] ${MODEL} — done"
    fi
done

echo "[pull-models] all models ready"

# JimboMesh Integration Guide

How to connect the JimboMesh Holler Server to the [JimboMesh](https://github.com/IngressTechnology/JimboMesh) agent stack so that embedding operations route through local Ollama instead of cloud APIs.

## Current Architecture (Cloud)

```
JimboMesh Stack:
  ingest-notion.js → embed.sh → OpenRouter API (text-embedding-3-small, 1536d) → Qdrant
  ingest-hubspot.js → embed.sh → OpenRouter API (text-embedding-3-small, 1536d) → Qdrant
```

## Target Architecture (On-Prem)

```
JimboMesh Stack:
  ingest-notion.js → embed.sh → Ollama (nomic-embed-text, 768d) → Qdrant
  ingest-hubspot.js → embed.sh → Ollama (nomic-embed-text, 768d) → Qdrant
```

## Integration Options

### Option A: Replace embed.sh (Simplest)

Copy the Ollama-compatible `embed.sh` from this project into JimboMesh, replacing the OpenRouter version.

1. **Copy the script:**

```bash
cp jimbomesh-holler-server/scripts/embed.sh JimboMesh/scripts/embed.sh
```

2. **Add Ollama environment variables to JimboMesh `.env`:**

```bash
# Local Ollama (add to JimboMesh .env)
OLLAMA_URL=http://jimbomesh-still:1920
JIMBOMESH_HOLLER_API_KEY=your_generated_api_key_here  # Must match Ollama server
OLLAMA_EMBED_MODEL=nomic-embed-text
EMBED_DIMENSIONS=768
```

Generate the API key with:

```bash
openssl rand -hex 32
```

This key must match the `JIMBOMESH_HOLLER_API_KEY` set in the jimbomesh-holler-server `.env` file.

3. **Add Ollama to the Docker network** (see Option B or C below for networking).

4. **Re-create Qdrant collections** with 768 dimensions and re-embed all content:

```bash
# Inside JimboMesh gateway container
/opt/jimbomesh/scripts/ingest-notion.sh --full
/opt/jimbomesh/scripts/ingest-hubspot.sh --full
```

### Option B: Docker Network Bridge

Add the Ollama server to JimboMesh's Docker network so containers can communicate by hostname.

**In JimboMesh `docker-compose.yml`**, add the Ollama service:

```yaml
services:
  jimbomesh-gateway:
    environment:
      - OLLAMA_URL=http://jimbomesh-still:1920
      - JIMBOMESH_HOLLER_API_KEY=${JIMBOMESH_HOLLER_API_KEY}  # Must match Ollama server
      - OLLAMA_EMBED_MODEL=nomic-embed-text
      - EMBED_DIMENSIONS=768

  jimbomesh-still:
    image: jimbomesh-still:latest
    container_name: jimbomesh-still
    restart: unless-stopped
    volumes:
      - ollama_models:/root/.ollama
    ports:
      - "1920:1920"
      - "9090:9090"
    environment:
      - JIMBOMESH_HOLLER_API_KEY=${JIMBOMESH_HOLLER_API_KEY}  # Required for authentication
      - HOLLER_MODELS=nomic-embed-text,llama3.1:8b
      - OLLAMA_EMBED_MODEL=nomic-embed-text
      - GATEWAY_PORT=1920
      - OLLAMA_INTERNAL_PORT=11435
      - RATE_LIMIT_PER_MIN=60
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:9090/readyz"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 120s

volumes:
  ollama_models:
```

**Or use an external network** to keep the stacks separate:

```bash
# Create shared network
docker network create jimbomesh-net
```

In both `docker-compose.yml` files:

```yaml
networks:
  default:
    name: jimbomesh-net
    external: true
```

### Option C: Host Network (Same Machine)

If both stacks run on the same host machine, use `host.docker.internal`:

```bash
# In JimboMesh .env
OLLAMA_URL=http://host.docker.internal:1920
JIMBOMESH_HOLLER_API_KEY=your_api_key_here
```

This works on Docker Desktop (Windows/macOS). On Linux, add `--add-host=host.docker.internal:host-gateway` to the gateway service.

> **macOS Performance Mode note:** Option C works identically whether Holler Server runs in Secure Mode (Docker CPU) or Performance Mode (native Ollama). From JimboMesh's container, `host.docker.internal:1920` always reaches the **Holler Server API gateway** (the Docker container), which then proxies internally to native Ollama. Authentication, rate limiting, and the admin UI are preserved. JimboMesh does not need to know which mode the Holler Server is using.

### Option D: Remote Server

If Ollama runs on a different machine (e.g., a GPU server or separate Windows PC):

```bash
# In JimboMesh .env
OLLAMA_URL=http://192.168.1.100:1920  # Replace with actual IP
JIMBOMESH_HOLLER_API_KEY=your_api_key_here        # Must match server
```

Ensure:
1. Port 1920 is accessible from the JimboMesh host
2. The API key matches the `JIMBOMESH_HOLLER_API_KEY` on the Ollama server
3. Firewall allows incoming connections on port 1920

## Dimension Migration

### The Problem

JimboMesh production uses `text-embedding-3-small` (1536 dimensions). Ollama's `nomic-embed-text` produces 768 dimensions. **You cannot mix dimensions in the same Qdrant collection.**

### Migration Steps

1. **Stop ingestion** — prevent new embeddings during migration:

```bash
docker exec jimbomesh-gateway crontab -r -u node  # remove cron schedule
```

2. **Swap embed.sh** — replace with the Ollama version:

```bash
cp jimbomesh-holler-server/scripts/embed.sh JimboMesh/scripts/embed.sh
```

3. **Update environment** — add Ollama config to JimboMesh `.env`

4. **Delete and re-create Qdrant collections** — with new dimensions:

```bash
# Delete existing collections (destructive!)
for c in knowledge_base memory client_research; do
  curl -X DELETE -H "api-key: $QDRANT_API_KEY" \
    http://jimbomesh-qdrant:6333/collections/$c
done

# Re-create with 768 dimensions
for c in knowledge_base memory client_research; do
  curl -X PUT -H "api-key: $QDRANT_API_KEY" \
    -H "Content-Type: application/json" \
    http://jimbomesh-qdrant:6333/collections/$c \
    -d '{"vectors":{"size":768,"distance":"Cosine"}}'
done
```

5. **Re-embed all content**:

```bash
docker exec jimbomesh-gateway /opt/jimbomesh/scripts/ingest-notion.sh --full
docker exec jimbomesh-gateway /opt/jimbomesh/scripts/ingest-hubspot.sh --full
```

6. **Restore cron** — restart the container to re-install the crontab:

```bash
docker compose restart jimbomesh-gateway
```

### Rollback

To revert to cloud embeddings:

1. Restore the original `embed.sh` from the JimboMesh repo
2. Remove Ollama env vars from `.env`
3. Re-create Qdrant collections with 1536 dimensions
4. Re-run `--full` ingestion

## API Compatibility

### OpenAI-Compatible Endpoint (Recommended)

The simplest integration path. The gateway provides `/v1/embeddings` which speaks the OpenAI format natively — no `embed.sh` changes needed, just swap the base URL:

```
POST /v1/embeddings
{
  "model": "nomic-embed-text",
  "input": "text to embed"
}

Response:
{
  "object": "list",
  "data": [{"object": "embedding", "embedding": [0.123, -0.456, ...], "index": 0}],
  "model": "nomic-embed-text",
  "usage": {"prompt_tokens": 4, "total_tokens": 4}
}
```

Supports batch embedding (array of strings as `input`). Authentication via `X-API-Key` header.

### Ollama Native API

```
POST /api/embed
{
  "model": "nomic-embed-text",
  "input": "text to embed"
}

Response:
{
  "embeddings": [[0.123, -0.456, ...]]
}
```

### OpenRouter Embedding API (original)

```
POST /api/v1/embeddings
{
  "model": "openai/text-embedding-3-small",
  "input": "text to embed",
  "dimensions": 1536
}

Response:
{
  "data": [{"embedding": [0.123, -0.456, ...]}]
}
```

The `embed.sh` script in this project handles the API format difference — it calls Ollama's `/api/embed` and parses the `embeddings` array instead of OpenRouter's `data[0].embedding`. Alternatively, applications can use the `/v1/embeddings` endpoint directly without modifying any scripts.

## Verification

After integration, verify the pipeline end-to-end:

```bash
# 1. Test Ollama API gateway authentication
curl -H "X-API-Key: $JIMBOMESH_HOLLER_API_KEY" \
  http://localhost:1920/api/tags

# 2. Test embedding generation
curl -H "X-API-Key: $JIMBOMESH_HOLLER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"nomic-embed-text","input":"test embedding"}' \
  http://localhost:1920/api/embed

# 3. Test embed.sh (should use API key from environment)
echo "test embedding" | ./scripts/embed.sh knowledge_base test-001 '{"source":"test"}'

# 4. Verify Qdrant has the point
curl -H "api-key: $QDRANT_API_KEY" \
  http://jimbomesh-qdrant:6333/collections/knowledge_base/points/scroll \
  -d '{"limit":1,"with_payload":true}'

# 5. Run a small ingestion
docker exec jimbomesh-gateway /opt/jimbomesh/scripts/ingest-notion.sh --full
```

**Authentication Errors:**

- `401 Unauthorized` — Missing `X-API-Key` header
- `403 Forbidden` — Invalid API key
- `429 Too Many Requests` — Rate limit exceeded (60 req/min default)

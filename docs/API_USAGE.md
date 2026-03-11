# API Usage Guide — curl & Postman

How to interact with the JimboMesh Holler Server API using curl, Postman, and the built-in Swagger UI.

## Base URL

| Environment | URL |
|---|---|
| Windows Server (LAN) | `http://your-server-ip:1920` |
| Local / same machine | `http://localhost:1920` |

All examples below use `$BASE_URL` — set it once:

```bash
export BASE_URL="http://your-server-ip:1920"
export API_KEY="your_ollama_api_key_here"
```

## Authentication

Inference endpoints require authentication via `X-API-Key` (or `Authorization: Bearer ...`). Admin API endpoints require `X-API-Key`. Unauthenticated endpoints include `/health`, `/readyz`, `/docs`, `/healthz`, `/status`, and `/admin/api/branding`.

| Key | Env var | Access |
|---|---|---|
| Inference key | `JIMBOMESH_HOLLER_API_KEY` | All inference + admin endpoints |
| Admin key | `ADMIN_API_KEY` | Admin endpoints only (optional, falls back to inference key) |

```bash
# Header format
-H "X-API-Key: $API_KEY"
```

## Swagger UI (Interactive Docs)

Open in a browser — no auth needed:

```
http://your-server-ip:1920/docs
```

The Swagger UI loads the full OpenAPI spec and lets you try every endpoint interactively. Click **Authorize** in the top-right and enter your API key.

---

## Health Checks

Gateway health endpoints run on port `1920`. The dedicated health server runs on port `9090`.

### Liveness probe (gateway)

OpenAPI response schema: `HealthOk`.

```bash
curl $BASE_URL/health
```

```json
{"status":"ok","timestamp":"2026-02-25T12:00:00.000Z"}
```

### Readiness probe (gateway)

OpenAPI response schemas: `HealthOk` (`200`) and `ReadyzShuttingDown` (`503`).

```bash
curl $BASE_URL/readyz
```

Returns `200` when ready, `503` with `Retry-After` header during shutdown.

### Health server probes (port 9090)

```bash
curl http://localhost:9090/healthz
curl http://localhost:9090/readyz
curl http://localhost:9090/status
```

---

## Embeddings

### OpenAI-compatible (recommended)

OpenAPI schemas: request `OpenAIEmbeddingsRequest`, response `OpenAIEmbeddingsResponse`.

**Single input:**

```bash
curl -X POST $BASE_URL/v1/embeddings \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nomic-embed-text",
    "input": "The quick brown fox jumps over the lazy dog"
  }'
```

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [0.123, -0.456, 0.789, "...768 floats total"],
      "index": 0
    }
  ],
  "model": "nomic-embed-text",
  "usage": {"prompt_tokens": 10, "total_tokens": 10}
}
```

**Batch input** (up to 100 strings):

```bash
curl -X POST $BASE_URL/v1/embeddings \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nomic-embed-text",
    "input": [
      "First document to embed",
      "Second document to embed",
      "Third document to embed"
    ]
  }'
```

Response `data` array contains one embedding per input, in order.

### Ollama native format

OpenAPI schemas: request `OllamaEmbedRequest`, response `OllamaEmbedResponse`.

```bash
curl -X POST $BASE_URL/api/embed \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nomic-embed-text",
    "input": "The quick brown fox jumps over the lazy dog"
  }'
```

```json
{
  "model": "nomic-embed-text",
  "embeddings": [[0.123, -0.456, 0.789, "..."]]
}
```

---

## Chat Completion

### Non-streaming

OpenAPI request schema: `OllamaChatRequest`.

```bash
curl -X POST $BASE_URL/api/chat \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:1b",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is the capital of France?"}
    ],
    "stream": false
  }'
```

```json
{
  "model": "llama3.2:1b",
  "message": {"role": "assistant", "content": "The capital of France is Paris."},
  "done": true,
  "total_duration": 1234567890,
  "eval_count": 12
}
```

### Streaming (default)

OpenAPI request schema: `OllamaChatRequest` (`stream=true` returns NDJSON).

```bash
curl -X POST $BASE_URL/api/chat \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:1b",
    "messages": [
      {"role": "user", "content": "What is the capital of France?"}
    ]
  }'
```

Streams NDJSON — one JSON object per line, each containing a partial `message.content`. The final line has `"done": true`.

### Multi-turn conversation

OpenAPI request schema: `OllamaChatRequest`.

```bash
curl -X POST $BASE_URL/api/chat \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:1b",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is the capital of France?"},
      {"role": "assistant", "content": "The capital of France is Paris."},
      {"role": "user", "content": "What is its population?"}
    ],
    "stream": false
  }'
```

---

## Text Generation

### Non-streaming

OpenAPI request schema: `OllamaGenerateRequest`.

```bash
curl -X POST $BASE_URL/api/generate \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:1b",
    "prompt": "Explain quantum computing in one paragraph.",
    "stream": false
  }'
```

### With model parameters

OpenAPI request schema: `OllamaGenerateRequest` (`options` allows additional keys).

```bash
curl -X POST $BASE_URL/api/generate \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:1b",
    "prompt": "Write a haiku about programming.",
    "stream": false,
    "options": {
      "temperature": 0.9,
      "top_p": 0.95
    }
  }'
```

---

## Model Management

### List installed models

OpenAPI response schema: `TagsResponse`.

```bash
curl $BASE_URL/api/tags \
  -H "X-API-Key: $API_KEY"
```

### List running (loaded) models

OpenAPI response schema: `PsResponse`.

```bash
curl $BASE_URL/api/ps \
  -H "X-API-Key: $API_KEY"
```

### Show model details (admin)

OpenAPI request schema: `ShowRequest`.

```bash
curl -X POST $BASE_URL/admin/api/models/show \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "llama3.2:1b"}'
```

### Pull a model (admin)

OpenAPI request schema: `PullRequest` (response is `text/event-stream`).

Returns a Server-Sent Events stream with download progress:

```bash
curl -X POST $BASE_URL/admin/api/models/pull \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "llama3.2:1b"}'
```

### Delete a model (admin)

URL-encode colons (`%3A`) in the model name:

```bash
curl -X DELETE "$BASE_URL/admin/api/models/llama3.1%3A8b" \
  -H "X-API-Key: $API_KEY"
```

---

## Admin API

### Server status

OpenAPI response schema: `AdminStatusResponse`.

```bash
curl $BASE_URL/admin/api/status \
  -H "X-API-Key: $API_KEY"
```

```json
{
  "healthy": true,
  "ollama_latency_ms": 12,
  "model_count": 2,
  "running_models": 1,
  "uptime_seconds": 3600,
  "recent_requests": 42,
  "total_requests": 420,
  "db_size_bytes": 1048576,
  "error": null
}
```

### Server configuration

OpenAPI response schema: `AdminConfigResponse`.

```bash
curl $BASE_URL/admin/api/config \
  -H "X-API-Key: $API_KEY"
```

Returns current config (no secret values — only booleans for key presence).

### Recent activity

OpenAPI response schema: `AdminActivityResponse`.

```bash
curl $BASE_URL/admin/api/activity \
  -H "X-API-Key: $API_KEY"
```

Returns the last 200 requests (newest first). Supports pagination: `?limit=50&offset=100`.

### API key (masked)

OpenAPI response schema: `AdminApiKeyMaskedResponse`.

```bash
curl $BASE_URL/admin/api/apikey \
  -H "X-API-Key: $API_KEY"
```

Returns the current API key with middle characters masked (e.g., `cbc1...c4f1`).

### Regenerate API key

OpenAPI schemas: request `AdminApiKeyRegenerateRequest`, response `AdminApiKeyRegenerateResponse`.

```bash
curl -X POST $BASE_URL/admin/api/apikey/regenerate \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"confirm": "hellyeah"}'
```

Generates a new 64-character hex API key. The `confirm` field must be exactly `"hellyeah"`. Returns the new key (masked and full). The new key takes effect immediately; the previous key is invalidated.

### Qdrant key (masked)

OpenAPI response schema: `AdminQdrantKeyResponse`.

```bash
curl $BASE_URL/admin/api/qdrantkey \
  -H "X-API-Key: $API_KEY"
```

Returns `{ "set": true, "masked": "cbc1...c4f1" }` when Qdrant API key is configured. Copy button in Admin UI copies `QDRANT_API_KEY=<key>` for `.env` paste.

### GPU / hardware info

OpenAPI response schema: `AdminGpuInfoResponse`.

```bash
curl $BASE_URL/admin/api/gpu-info \
  -H "X-API-Key: $API_KEY"
```

```json
{
  "mode": "metal",
  "gpu": {
    "name": "Apple M3 Pro",
    "type": "metal",
    "vram_total_mb": null,
    "vram_used_mb": null,
    "vram_free_mb": null,
    "offload_pct": 100
  },
  "system": {
    "total_mb": 36864,
    "free_mb": 21000
  },
  "ollama_gpu": {
    "running_models": 1,
    "total_size_bytes": 4900000000,
    "total_vram_bytes": 4900000000,
    "gpu_offload_pct": 100
  }
}
```

`mode` is one of `"metal"` (macOS Performance Mode), `"nvidia"` (NVIDIA GPU), `"metal-native"` (macOS without overlay), or `"cpu"`. Response is cached for 30 seconds.

---

## Mesh Connectivity (Admin)

Use these endpoints to connect the Holler to the JimboMesh coordinator, monitor state, and inspect active WebRTC peers.
JimboMesh SaaS keys must start with `jmsh_` (local Holler keys are rejected for mesh connect).

### Get Mesh status

```bash
curl $BASE_URL/admin/api/mesh/status \
  -H "X-API-Key: $API_KEY"
```

```json
{
  "state": "connected",
  "connected": true,
  "connecting": false,
  "mode": "mesh-contributor",
  "meshUrl": "https://api.jimbomesh.ai",
  "hollerName": "warehouse-holler-1",
  "hollerId": "holler-abc123",
  "autoConnect": true,
  "hasStoredMeshKey": true,
  "lastHeartbeat": 1709312400114,
  "jobsProcessed": 42,
  "moonshineEarned": 1.5,
  "errorMessage": null,
  "log": [],
  "peerConnections": {
    "activeConnections": 1,
    "maxConnections": 10,
    "jobs": []
  }
}
```

`state` is one of `disconnected`, `connecting`, `connected`, `error`, `reconnecting`. `meshUrl` resolves from `JIMBOMESH_COORDINATOR_URL` (preferred) or falls back to `JIMBOMESH_MESH_URL` in `.env`. `hasStoredMeshKey` indicates whether an API key is persisted in SQLite for one-click reconnect.

### Get latest published Mesh version

```bash
curl $BASE_URL/admin/api/mesh/latest-version \
  -H "X-API-Key: $API_KEY"
```

```json
{
  "connected": true,
  "currentVersion": "0.3.14",
  "latestVersion": "0.3.14",
  "updateAvailable": false,
  "source": "https://api.jimbomesh.ai/api/holler/version"
}
```

When not connected, returns `connected: false` with `latestVersion: null`.

### Connect to Mesh

```bash
curl -X POST $BASE_URL/admin/api/mesh/connect \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "jmsh_abc123_example",
    "meshUrl": "https://api.jimbomesh.ai",
    "hollerName": "warehouse-holler-1",
    "autoConnect": true
  }'
```

### Cancel in-progress connect

```bash
curl -X POST $BASE_URL/admin/api/mesh/cancel \
  -H "X-API-Key: $API_KEY"
```

### Save Mesh settings without reconnecting

```bash
curl -X POST $BASE_URL/admin/api/mesh/settings \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "meshUrl": "https://api.jimbomesh.ai",
    "hollerName": "warehouse-holler-1",
    "autoConnect": true
  }'
```

### Toggle auto-connect only

```bash
curl -X POST $BASE_URL/admin/api/mesh/auto-connect \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

### Disconnect from Mesh

```bash
curl -X POST $BASE_URL/admin/api/mesh/disconnect \
  -H "X-API-Key: $API_KEY"
```

Disconnect keeps the API key stored in SQLite so the user can reconnect with one click. Only `mesh_auto_connect` is cleared.

### Reconnect to Mesh (using stored key)

```bash
curl -X POST $BASE_URL/admin/api/mesh/reconnect \
  -H "X-API-Key: $API_KEY"
```

Stops the current connection and reconnects using the key stored in SQLite.

### Quick connect (stored key)

```bash
curl -X POST $BASE_URL/admin/api/mesh/connect-stored \
  -H "X-API-Key: $API_KEY"
```

Connects using the API key already stored in SQLite. Returns `400` with code `no_key` if no key is stored.

### Forget stored Mesh key

```bash
curl -X POST $BASE_URL/admin/api/mesh/forget-key \
  -H "X-API-Key: $API_KEY"
```

Clears the stored mesh API key from SQLite. The user will need to re-enter the key to connect again.

### List active WebRTC peer sessions

```bash
curl $BASE_URL/admin/api/mesh/peers \
  -H "X-API-Key: $API_KEY"
```

```json
{
  "activeConnections": 1,
  "maxConnections": 10,
  "jobs": [
    {
      "jobId": "job_a1b2c3d4",
      "model": "llama3.2:1b",
      "state": "streaming",
      "startedAt": 1709312400000
    }
  ]
}
```

WebRTC job state is one of `signaling`, `connected`, `streaming`, `complete`, `closed`.

---

## Server Management (Admin)

### Restart Holler or Ollama

```bash
curl -X POST $BASE_URL/admin/api/restart \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"target": "holler"}'
```

`target` is `"holler"` (default) or `"ollama"`.

- **`holler`**: Calls `process.exit(0)` — Docker or the process manager restarts the container/service.
- **`ollama`**: On macOS Performance Mode, sends `pkill -f "ollama serve"` (launchctl/brew auto-restarts). Inside Docker, logs a message to restart the container manually.

The response is sent before the restart takes effect.

---

## Document Management (Admin)

Requires Qdrant (`--profile qdrant`) and an embedding model (e.g., `nomic-embed-text`).

### Upload a document

OpenAPI request: multipart `file` with optional `collection` query param (response is `text/event-stream`).

Multipart form upload. Returns a Server-Sent Events stream with processing progress:

```bash
curl -X POST "$BASE_URL/admin/api/documents/upload?collection=documents" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@/path/to/document.pdf"
```

SSE events show progress through phases: `extract` → `chunk` → `embedding` → `store` → `complete`.

Supported file types: `.pdf`, `.md`, `.txt`, `.csv`, `.docx`

### List documents

OpenAPI response schema: `AdminDocumentListResponse`.

```bash
curl "$BASE_URL/admin/api/documents?collection=documents" \
  -H "X-API-Key: $API_KEY"
```

### Get document metadata

```bash
curl $BASE_URL/admin/api/documents/DOC_ID \
  -H "X-API-Key: $API_KEY"
```

### View document chunks

```bash
curl $BASE_URL/admin/api/documents/DOC_ID/chunks \
  -H "X-API-Key: $API_KEY"
```

Returns the stored chunks from Qdrant with text content and metadata.

### Delete a document

Removes the file from disk, vectors from Qdrant, and metadata from SQLite:

```bash
curl -X DELETE $BASE_URL/admin/api/documents/DOC_ID \
  -H "X-API-Key: $API_KEY"
```

### Reindex a document

Deletes existing vectors and re-processes the file (SSE streaming):

```bash
curl -X POST $BASE_URL/admin/api/documents/DOC_ID/reindex \
  -H "X-API-Key: $API_KEY"
```

---

## Document RAG (Admin)

### Semantic search

OpenAPI schemas: request `AdminDocumentQueryRequest`, response `AdminDocumentQueryResponse`.

Embed a query and search Qdrant for matching document chunks:

```bash
curl -X POST $BASE_URL/admin/api/documents/query \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is the refund policy?",
    "collection": "documents",
    "limit": 5
  }'
```

```json
{
  "results": [
    {
      "score": 0.87,
      "payload": {
        "text": "Our refund policy allows...",
        "filename": "policies.pdf",
        "chunk_index": 3,
        "total_chunks": 12,
        "document_id": "doc-uuid"
      }
    }
  ]
}
```

### RAG Q&A (streaming)

OpenAPI request schema: `AdminDocumentQueryRequest` (response is `text/event-stream`).

Ask a question with context from your documents. Returns SSE with source citations followed by a streamed LLM answer:

```bash
curl -X POST $BASE_URL/admin/api/documents/ask \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is the refund policy?",
    "collection": "documents",
    "model": "llama3.2:1b",
    "limit": 5
  }'
```

Optional `model` defaults to `llama3.2:1b`. SSE events stream in phases (for example `phase: "sources"` and `phase: "answer"`) until `done: true`.

---

## Collection Management (Admin)

### List collections

```bash
curl $BASE_URL/admin/api/collections \
  -H "X-API-Key: $API_KEY"
```

### Create a collection

OpenAPI request schema: `CreateCollectionRequest`.

```bash
curl -X POST $BASE_URL/admin/api/collections \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-docs"}'
```

### Delete a collection

```bash
curl -X DELETE $BASE_URL/admin/api/collections/my-docs \
  -H "X-API-Key: $API_KEY"
```

---

## Postman Setup

### Option A: Import OpenAPI spec (recommended)

1. Open Postman and click **Import**
2. Select **File** and choose `openapi.yaml` from the project root
3. Postman generates a collection with every endpoint pre-configured
4. Set up environment variables:
   - Click **Environments** → **New Environment**
   - Add variable `baseUrl` = `http://your-server-ip:1920`
   - Add variable `apiKey` = your API key
5. In the collection settings, set the **Base URL** to `{{baseUrl}}`
6. Under **Authorization**, set type **API Key**, key name `X-API-Key`, value `{{apiKey}}`, add to **Header**

### Option B: Manual setup

1. Create a new collection named "JimboMesh Holler Server"
2. Set collection-level authorization:
   - Type: **API Key**
   - Key: `X-API-Key`
   - Value: `{{apiKey}}`
   - Add to: **Header**
3. Create environment variables:
   - `baseUrl` = `http://your-server-ip:1920`
   - `apiKey` = your API key
4. Add requests:

| Method | URL | Body |
|---|---|---|
| GET | `{{baseUrl}}/health` | — |
| GET | `{{baseUrl}}/readyz` | — |
| GET | `http://localhost:9090/healthz` | — |
| POST | `{{baseUrl}}/v1/embeddings` | `{"model":"nomic-embed-text","input":"test text"}` |
| GET | `{{baseUrl}}/v1/models` | — |
| POST | `{{baseUrl}}/v1/chat/completions` | `{"model":"llama3.2:1b","messages":[{"role":"user","content":"Hello"}],"stream":false}` |
| POST | `{{baseUrl}}/api/chat` | `{"model":"llama3.2:1b","messages":[{"role":"user","content":"Hello"}],"stream":false}` |
| POST | `{{baseUrl}}/api/generate` | `{"model":"llama3.2:1b","prompt":"Hello","stream":false}` |
| GET | `{{baseUrl}}/api/tags` | — |
| GET | `{{baseUrl}}/api/ps` | — |
| POST | `{{baseUrl}}/v1/documents/search` | `{"query":"search text","collection":"documents"}` |
| POST | `{{baseUrl}}/v1/documents/ask` | `{"query":"question","collection":"documents","model":"llama3.2:1b"}` |
| GET | `{{baseUrl}}/admin/api/status` | — |
| GET | `{{baseUrl}}/admin/api/config` | — |
| GET | `{{baseUrl}}/admin/api/activity` | — |
| GET | `{{baseUrl}}/admin/api/apikey` | — |
| POST | `{{baseUrl}}/admin/api/apikey/regenerate` | `{"confirm":"hellyeah"}` |
| GET | `{{baseUrl}}/admin/api/qdrantkey` | — |
| GET | `{{baseUrl}}/admin/api/gpu-info` | — |
| GET | `{{baseUrl}}/admin/api/mesh/status` | — |
| GET | `{{baseUrl}}/admin/api/mesh/latest-version` | — |
| POST | `{{baseUrl}}/admin/api/mesh/connect` | `{"apiKey":"jmsh_...","meshUrl":"https://api.jimbomesh.ai","hollerName":"my-holler","autoConnect":true}` |
| POST | `{{baseUrl}}/admin/api/mesh/cancel` | — |
| POST | `{{baseUrl}}/admin/api/mesh/settings` | `{"meshUrl":"...","hollerName":"...","autoConnect":true}` |
| POST | `{{baseUrl}}/admin/api/mesh/auto-connect` | `{"enabled":true}` |
| POST | `{{baseUrl}}/admin/api/mesh/disconnect` | — |
| POST | `{{baseUrl}}/admin/api/mesh/reconnect` | — |
| POST | `{{baseUrl}}/admin/api/mesh/connect-stored` | — |
| POST | `{{baseUrl}}/admin/api/mesh/forget-key` | — |
| GET | `{{baseUrl}}/admin/api/mesh/peers` | — |
| POST | `{{baseUrl}}/admin/api/restart` | `{"target":"holler"}` |
| POST | `{{baseUrl}}/admin/api/models/pull` | `{"name":"llama3.2:1b"}` |
| POST | `{{baseUrl}}/admin/api/models/show` | `{"name":"llama3.2:1b"}` |
| GET | `{{baseUrl}}/admin/api/documents` | — |
| POST | `{{baseUrl}}/admin/api/documents/query` | `{"query":"search text","collection":"documents"}` |
| POST | `{{baseUrl}}/admin/api/documents/ask` | `{"query":"question","collection":"documents","model":"llama3.2:1b"}` |
| GET | `{{baseUrl}}/admin/api/collections` | — |

---

## Error Reference

All errors use a structured format:

```json
{
  "error": {
    "code": "error_code",
    "message": "Human-readable message",
    "type": "client_error"
  }
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Bad JSON, missing required fields |
| 400 | `batch_too_large` | Batch size exceeds `MAX_BATCH_SIZE` (default 100) |
| 401 | `auth_required` | Missing `X-API-Key` header |
| 403 | `auth_invalid` | Wrong API key |
| 413 | `payload_too_large` | Body exceeds `MAX_REQUEST_BODY_BYTES` (default 1 MB) |
| 429 | `rate_limited` | Rate limit exceeded (includes `Retry-After` header) |
| 429 | `queue_full` | All concurrency slots and queue full |
| 502 | `model_error` | Ollama unreachable or returned invalid data |
| 503 | `shutting_down` | Server is draining connections (includes `Retry-After`) |
| 504 | `request_timeout` | Ollama did not respond within `OLLAMA_TIMEOUT_MS` |

---

## PowerShell (Windows)

On Windows without WSL, use `Invoke-RestMethod`:

```powershell
$headers = @{ "X-API-Key" = "your_api_key_here"; "Content-Type" = "application/json" }

# Health check
Invoke-RestMethod -Uri "http://localhost:1920/health"

# Embeddings
Invoke-RestMethod -Uri "http://localhost:1920/v1/embeddings" `
  -Method Post -Headers $headers `
  -Body '{"model":"nomic-embed-text","input":"test text"}'

# Chat (non-streaming)
Invoke-RestMethod -Uri "http://localhost:1920/api/chat" `
  -Method Post -Headers $headers `
  -Body '{"model":"llama3.2:1b","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

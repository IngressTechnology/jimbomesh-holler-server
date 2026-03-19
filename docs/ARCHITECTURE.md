# Architecture Guide

## Overview

JimboMesh Holler Server is an on-prem embedding and LLM inference service for [JimboMesh](https://github.com/IngressTechnology/JimboMesh). It replaces cloud-based embedding API calls (OpenRouter/OpenAI) with a local Ollama instance, keeping all data on-premises.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Network                           │
│                                                                 │
│  ┌─────────────────────┐   ┌─────────────────────┐             │
│  │  jimbomesh-still     │   │  jimbomesh-qdrant    │             │
│  │                      │   │  (optional profile) │             │
│  │  ┌───────────────┐   │   │                     │             │
│  │  │ API Gateway   │   │   │  Qdrant v1.13.2     │             │
│  │  │ :1920 (ext)   │   │   │  :6333 REST         │             │
│  │  │ X-API-Key auth│   │   │  :6334 gRPC         │             │
│  │  │ Rate limiting │   │   │                     │             │
│  │  │ /admin (UI)   │   │   │                     │             │
│  │  └───────┬───────┘   │   │  Collections:       │             │
│  │          ▼           │   │  - knowledge_base   │             │
│  │  Ollama Server       │   │  - memory           │             │
│  │  :11435 (internal)   │   │  - client_research  │             │
│  │  :9090 (health)      │   │                     │             │
│  │  Models:             │   │  Indexes:           │             │
│  │  - nomic-embed-text  │   │  - source (keyword) │             │
│  │  - llama3.2:1b       │   │  - tags (keyword)   │             │
│  │                      │   │  - client (keyword) │             │
│  │  API:                │   │                     │             │
│  │  /api/embed          │   │                     │             │
│  │  /api/chat           │   │                     │             │
│  │  /api/generate       │   │                     │             │
│  │  /api/tags           │   │                     │             │
│  │  /v1/embeddings      │   │                     │             │
│  │  /admin (web UI)     │   │                     │             │
│  └──────────────────────┘   └─────────────────────┘             │
│                                       ▲                          │
│  ┌─────────────────────┐              │                          │
│  │  init-qdrant         │──────────────┘                          │
│  │  (one-shot)          │                                         │
│  │  Creates collections │                                         │
│  └─────────────────────┘                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
              │                          │
              ▼                          ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│    Host / LAN Clients   │  │  JimboMesh Gateway       │
│                         │  │  (separate stack)       │
│  http://localhost:1920 │  │  embed.sh → Ollama      │
│  http://localhost:6333  │  │  ingest-*.js → Qdrant   │
└─────────────────────────┘  └─────────────────────────┘
```

## Data Flow

### Embedding Pipeline

```
                    JimboMesh Stack                          Ollama Stack
┌─────────────────────────────┐         ┌─────────────────────────────┐
│                              │         │                             │
│  Notion API ──→ ingest-*.js  │         │   ┌─────────────────────┐   │
│       │                      │         │   │  API Gateway        │   │
│       ▼                      │         │   │  :1920              │   │
│  classify() → sanitize()     │         │   │  • Validate API key │   │
│       │                      │  HTTP   │   │  • Rate limit       │   │
│       ▼                      │ +Header │   │  • Forward request  │   │
│  embed.sh ───────────────────┼────────►│   └────────┬────────────┘   │
│       │ (X-API-Key)          │         │            ▼                │
│       │                      │         │   Ollama /api/embed         │
│       │◄─────────────────────┼─────────│   nomic-embed-text (768d)   │
│       │                      │         │   :11435 (internal only)    │
│       ▼                      │         │   returns: {embeddings:[]}  │
│  Qdrant upsert               │         │                             │
│  (trust boundary delimiters) │         └─────────────────────────────┘
│                              │
└─────────────────────────────┘
```

### Document RAG Pipeline

```
                        Admin UI                              jimbomesh-still
┌─────────────────────────────────┐         ┌─────────────────────────────────────┐
│                                  │         │                                     │
│  Documents Tab                   │  POST   │  admin-routes.js                    │
│  ┌───────────────────────┐       │ upload  │  handleDocumentUpload()             │
│  │ Drag & Drop Upload    │───────┼────────►│       │                             │
│  │ (.pdf .md .txt .csv   │       │   SSE   │       ▼                             │
│  │  .docx)               │◄──────┼─────────│  document-pipeline.js               │
│  └───────────────────────┘       │ progress│  ┌─────────────────────────────┐    │
│                                  │         │  │ 1. extractText()            │    │
│  ┌───────────────────────┐       │         │  │    pdfjs-dist / mammoth /   │    │
│  │ Ask (RAG Q&A)         │───────┼────────►│  │    fs.readFileSync          │    │
│  │ Type a question       │       │  POST   │  │ 2. chunkText()              │    │
│  │                       │◄──────┼─────────│  │    ~500 tokens, 50 overlap  │    │
│  └───────────────────────┘       │   SSE   │  │ 3. embedBatch()             │──┐ │
│                                  │ stream  │  │    Ollama /api/embed        │  │ │
│  ┌───────────────────────┐       │         │  │ 4. upsertPoints()           │  │ │
│  │ Browse / Search       │───────┼────────►│  │    → Qdrant collection      │  │ │
│  └───────────────────────┘       │         │  └─────────────────────────────┘  │ │
│                                  │         │       │                            │ │
└─────────────────────────────────┘         │       │    qdrant-client.js         │ │
                                             │       ▼         │                  │ │
                                             │  SQLite         │                  │ │
                                             │  documents      │                  │ │
                                             │  table          ▼                  │ │
                                             │            ┌──────────┐            │ │
                                             │            │ Qdrant   │◄───────────┘ │
                                             │            │ :6333    │              │
                                             │            └──────────┘              │
                                             └─────────────────────────────────────┘
```

### Mesh + WebRTC Job Flow (Optional)

```
             Holler (this server)                        JimboMesh SaaS
┌───────────────────────────────────────┐        ┌──────────────────────────┐
│ mesh-connector.js                     │  HTTPS │ Coordinator API          │
│ - register()                          │◄──────►│ - Holler registration    │
│ - heartbeat() (safety-net WS check)  │        │ - Job assignment         │
│ - poll jobs                           │        │ - Signaling + billing    │
│ - reconnect backoff (5/10/30/60/300s)│        └──────────────────────────┘
│ - state/log buffer                    │
│ - mgmt WS: ping/pong (15s/10s)      │
│ - full re-register if WS down >5min │
│ - unstable WS escalation + HTTP fallback │
│ - model list cache (30s) + env fallback │
│        │                              │
│        ├─ 1. if signaling_url + ice_servers:
│        │     mesh-webrtc.js (PeerSession)
│        │     RTCPeerConnection / RTCDataChannel
│        │     direct Buyer <-> Holler P2P stream
│        │     bounded by MAX_PEER_CONNECTIONS
│        │
│        ├─ 2. if ICE fails → SSE fallback:
│        │     SaaS sends fallback_inference via mgmt WS
│        │     Holler streams Ollama → fallback_token/done
│        │     if P2P already active for same job, fallback is
│        │     skipped and fallback_complete is sent with
│        │     { skipped: true, reason: "webrtc_active" }
│        │
│        └─ 3. HTTP polling execution (belt-and-suspenders)
└───────────────────────────────────────┘
```

Connection state machine: `disconnected -> connecting -> connected -> reconnecting/error -> disconnected`.

Management WebSocket resilience:
- Ping every 15s with 10s pong timeout; missed pong tears down and reconnects.
- Stepped backoff on close: 5s → 10s → 30s → 60s → 300s.
- If WS disconnected >5 minutes, triggers full re-registration (not just WS reconnect).
- Escalation chain for unstable reconnect loops:
  - Level 1: standard reconnect with backoff.
  - Level 2: after 5 "opened then closed quickly" cycles, force full teardown/re-registration.
  - Level 3: after 3 failed full teardowns, enter HTTP polling fallback and periodically attempt WS promotion.
- Each heartbeat checks WS health and reconnects if dead.
- Mesh model metadata comes from `GET /api/tags` with a shared 30s cache; if unavailable, `HOLLER_MODELS` is used as a fallback source.

Mesh auth model:
- All coordinator requests use `X-API-Key` with the configured `JIMBOMESH_API_KEY`.
- No runtime auth-token swap occurs after registration.
- Local gateway/admin key `JIMBOMESH_HOLLER_API_KEY` is independent and never modified by mesh operations.

### Before / After

```
Before (cloud):   ingest-*.js → embed.sh → OpenRouter API (internet) → Qdrant
After  (on-prem): ingest-*.js → embed.sh → Ollama (local network)    → Qdrant
```

## Docker Services

### jimbomesh-still

The primary service. Runs Ollama with automatic model management.

| Property | Value |
|----------|-------|
| Image | `jimbomesh-still:latest` (built from Dockerfile) |
| Base | `ollama/ollama:0.17.4` + Node.js 22.x LTS |
| Container | `jimbomesh-still` |
| Ports | 1920 (API gateway + admin UI), 9090 (health endpoints) |
| Internal | Ollama on 127.0.0.1:11435 (not exposed) |
| Volume | `ollama_models` (named volume at `/root/.ollama`) |
| Entrypoint | `docker-entrypoint.sh` (start → wait → API gateway → health → pull → serve) |
| API Gateway | `api-gateway.js` (Node.js HTTP proxy with auth, rate limiting, admin UI) |
| Admin UI | `/admin` on gateway port — dashboard, models, marketplace, Mesh, playground, config (incl. restart controls), activity, documents, feedback |
| GPU info API | `GET /admin/api/gpu-info` — detects NVIDIA/Metal/CPU; returns VRAM, offload %, system RAM; 30s cache |
| Health check | HTTP `/readyz` on :9090 (falls back to `healthcheck.sh`) |
| Health server | `health-server.js` (Node.js HTTP server, `/healthz`, `/readyz`, `/status`) |
| Restart | `unless-stopped` |

**Standard startup sequence (Linux / Windows):**

1. Start Ollama server on internal port 127.0.0.1:11435
2. Poll `/api/tags` until API is ready (120s timeout)
3. Start API gateway on 0.0.0.0:1920 (validates X-API-Key header)
4. Start health server on :9090
5. Pull each model in `HOLLER_MODELS` if not already present
6. Log readiness and wait on all processes

**macOS Performance Mode startup sequence** (when `OLLAMA_EXTERNAL_URL` is set):

1. Skip `ollama serve` — external Ollama is already running on the host
2. Wait for `OLLAMA_EXTERNAL_URL` (host.docker.internal:11434) to respond (60s timeout)
3. Set `OLLAMA_INTERNAL_URL=$OLLAMA_EXTERNAL_URL` — gateway routes to host Ollama
4. Start API gateway on 0.0.0.0:1920
5. Start health server on :9090
6. Pull each model in `HOLLER_MODELS` via `OLLAMA_HOST=host.docker.internal:11434` (host CLI)
7. Log readiness and wait on all processes

### NVIDIA GPU Acceleration

GPU support is added via `docker-compose.gpu.yml` overlay (loaded by setting `COMPOSE_FILE` in `.env`).

| Property | Value |
|----------|-------|
| Override File | `docker-compose.gpu.yml` |
| GPU | NVIDIA (all GPUs, via Container Toolkit) |
| Everything else | Same as `jimbomesh-still` |

### macOS Performance Mode (Native Ollama)

On macOS, Docker cannot pass Metal GPU access to containers. Performance Mode runs Ollama natively on the host and routes the container's API gateway to it.

| Property | Value |
|----------|-------|
| Override File | `docker-compose.mac.yml` (committed; overwritten by `setup.sh` during Performance Mode setup) |
| New env var | `OLLAMA_EXTERNAL_URL=http://host.docker.internal:11434` |
| Ollama process | Native macOS process (Homebrew `brew services`) |
| Gateway routes to | `host.docker.internal:11434` (host Ollama) |
| GPU | Apple Metal (full acceleration) |
| Model storage | `~/.ollama/` on host (not a Docker volume) |
| Everything else | Same as `jimbomesh-still` (gateway, admin, health, Qdrant) |

**Network diagram (macOS Performance Mode):**

```
┌─────────────────────────────────────────────────────────┐
│  macOS Host                                              │
│                                                          │
│  ┌────────────────────────────────────┐                  │
│  │  Docker Network                    │                  │
│  │                                    │                  │
│  │  jimbomesh-still                   │                  │
│  │  API Gateway :1920 (external)      │                  │
│  │  OLLAMA_INTERNAL_URL=              │                  │
│  │    http://host.docker.internal:11434│                 │
│  └──────────────────┬─────────────────┘                  │
│                     │ host.docker.internal               │
│                     ▼                                    │
│  ┌────────────────────────────────────┐                  │
│  │  Ollama (native, launchd/brew)     │                  │
│  │  localhost:11434                   │                  │
│  │  Metal GPU (full acceleration)     │                  │
│  └────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────┘
```

### jimbomesh-qdrant

Optional Qdrant vector database. Activated with `--profile qdrant`. Mirrors the JimboMesh production Qdrant schema.

| Property | Value |
|----------|-------|
| Profile | `qdrant` |
| Image | `qdrant/qdrant:v1.13.2` |
| Container | `jimbomesh-holler-qdrant` |
| Ports | 6333 (REST), 6334 (gRPC) |
| Volume | `qdrant_storage` (named volume) |
| Auth | API key (`QDRANT__SERVICE__API_KEY`) |
| Health check | TCP on 6333 (10s interval) |

### init-qdrant

One-shot initialization container. Creates Qdrant collections with correct dimensions.

| Property | Value |
|----------|-------|
| Profile | `qdrant` |
| Image | `curlimages/curl:8.12.1` |
| Depends on | `jimbomesh-qdrant` (healthy) |
| Restart | `no` (runs once) |
| Collections | `knowledge_base`, `memory`, `client_research` |
| Dimensions | Configurable via `EMBED_DIMENSIONS` (default: 768) |
| Distance | Cosine |
| Indexes | `source`, `tags`, `client` (keyword) |

## Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| `ollama_models` | `/root/.ollama` | Persisted model weights (~2-5 GB) |
| `holler_data` | `/opt/jimbomesh-still/data` | SQLite database, uploaded documents (`/data/documents/`) |
| `qdrant_storage` | `/qdrant/storage` | Qdrant vector data (with `--profile qdrant`) |

All are Docker named volumes. They survive container rebuilds and `docker compose down`. Only `docker compose down -v` removes them.

## SQLite Storage

The API gateway uses an embedded SQLite database (`holler.db`) for persistent state that was previously held in memory.

| Table | Purpose | Retention |
|-------|---------|-----------|
| `request_log` | Every proxied request (method, path, status, IP, duration, model, error) | 30 days (configurable) |
| `settings` | Runtime-mutable key-value pairs (rate limit, admin toggle, etc.) | Permanent |
| `stats_hourly` | Aggregated hourly rollups (request counts, error rates, latencies) | Permanent |
| `documents` | Uploaded document metadata (filename, hash, size, mime, chunk count, status) | Permanent |
| `request_stats` | Inference metrics (model, tokens, latency). `connection_type` tracks `webrtc` or `http` for Mesh jobs | 7 days |
| `schema_version` | Migration tracking | Permanent |

**Performance features:**
- WAL mode for concurrent reads during writes
- Prepared statements compiled once, executed many times
- Synchronous writes are ~5μs — negligible vs embedding latency
- Background rollup every 5 minutes, log pruning every hour
- ~100 bytes per log entry; 300MB max at 30-day retention with 100K req/day

## Network

All services run on the default Docker Compose network. Service-to-service communication uses container hostnames:

| From | To | URL | Auth Required |
|------|----|-----|---------------|
| Host | Admin UI | `http://localhost:1920/admin` | ❌ Static (API key entered in browser) |
| Host | Admin API | `http://localhost:1920/admin/api/*` | ✅ X-API-Key |
| Host | API Gateway | `http://localhost:1920` | ✅ X-API-Key |
| Host | Health | `http://localhost:9090` | ❌ Public |
| Host | Qdrant | `http://localhost:6333` | ✅ api-key |
| API Gateway | Ollama (internal, standard) | `http://127.0.0.1:11435` | ❌ Internal |
| API Gateway | Ollama (host, Performance Mode) | `http://host.docker.internal:11434` | ❌ Internal |
| Mesh Connector | Coordinator API | `https://api.jimbomesh.ai` (or `JIMBOMESH_COORDINATOR_URL`) | ✅ Mesh API key |
| Document Pipeline | Ollama (internal, standard) | `http://127.0.0.1:11435` | ❌ Internal |
| Document Pipeline | Ollama (host, Performance Mode) | `http://host.docker.internal:11434` | ❌ Internal |
| Document Pipeline | Qdrant | `http://jimbomesh-holler-qdrant:6333` | ✅ api-key |
| JimboMesh gateway | API Gateway | `http://jimbomesh-still:1920` | ✅ X-API-Key |
| embed.sh | Qdrant | `http://jimbomesh-holler-qdrant:6333` | ✅ api-key |
| init-qdrant | Qdrant | `http://jimbomesh-holler-qdrant:6333` | ✅ api-key |

**Port Architecture:**

- **1920** — API Gateway (external, authenticated)
- **11435** — Ollama server (internal only, localhost)
- **9090** — Health endpoints (external, public)
- **6333** — Qdrant REST API (external, authenticated)

## Security

### Ollama API Authentication

The Ollama server is protected by a Node.js API gateway that validates all incoming requests:

- **Three-tier auth** — Tier 1: `X-API-Key` header; Tier 2: Bearer tokens (`jmh_*` via `token-manager.js`); Tier 3: JWT (Auth0 via `jwt-validator.js`)
- **Rate limiting** — 60 requests/minute per IP address (configurable via `RATE_LIMIT_PER_MIN`); per-token rate limits for Tier 2
- **Internal isolation** — Ollama runs on 127.0.0.1:11435, only accessible via the gateway
- **External access** — API gateway listens on 0.0.0.0:1920, validates all requests
- **Admin UI** — Static assets served without auth (contain no secrets); admin API endpoints require `X-API-Key`
- **Admin kill switch** — `ADMIN_ENABLED=false` returns 404 for all `/admin` routes
- **Path traversal protection** — `path.resolve()` + prefix check prevents directory escape
- **CSP headers** — `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`
- **Health endpoint** — `/health` endpoint bypasses auth for monitoring

Generate an API key:

```bash
openssl rand -hex 32
```

Set in `.env`:

```bash
JIMBOMESH_HOLLER_API_KEY=your_generated_key_here
```

All requests to the Ollama server must include the API key:

```bash
curl -H "X-API-Key: your_api_key" http://localhost:1920/api/tags
```

### Qdrant Authentication

- API key required for all Qdrant access (`QDRANT_API_KEY`)
- All scripts pass `api-key` header on every request
- Generate with: `openssl rand -hex 32`

### Embedding Pipeline Security

The `embed.sh` script inherits all security features from the JimboMesh version:

- **Collection whitelist** — only `knowledge_base`, `memory`, `client_research`
- **Point ID validation** — `[a-zA-Z0-9._-]+` pattern, rejects shell metacharacters
- **Trust boundary delimiters** — `<retrieved_context>` XML tags on all stored text
- **Input truncation** — 32,000 character limit per embedding

### No Secrets in the Image

API keys are passed via `.env` file and environment variables at runtime. Nothing sensitive is baked into the Docker image.

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Profile-based Qdrant | Not everyone needs a local Qdrant — JimboMesh has its own |
| `nomic-embed-text` default | 768d, fast, good quality-to-size ratio, MIT licensed |
| Named volumes | Survive rebuilds; models are expensive to re-download |
| Separate GPU overlay (`docker-compose.gpu.yml`) | Avoids deploy block errors on machines without NVIDIA toolkit; `docker compose down` always works |
| `OLLAMA_EXTERNAL_URL` for macOS Performance Mode | New env var instead of overriding `OLLAMA_INTERNAL_URL` — entrypoint sets internal URL from external URL, preventing override conflicts |
| `docker-compose.mac.yml` committed (overwritten by `setup.sh`) | Same overlay pattern as GPU; keeps base `docker-compose.yml` unchanged; `COMPOSE_FILE` in `.env` is idempotent |
| `curlimages/curl` for init | Minimal image for HTTP-only Qdrant setup, no Node.js needed |
| Entrypoint model pulling | Models download on first run, not at build time (keeps image small) |
| OpenRouter fallback in embed.sh | Allows gradual migration without breaking existing pipelines |
| Admin UI on existing port | No new port, no new process — reuses API gateway on :1920 |
| Vanilla JS for admin UI | No build step, works in air-gapped deployments |
| SQLite via `sql.js` | Pure JavaScript/WASM, no native modules or ABI rebuilds, single-file persistence |
| Explicit DB saves after mutations | Keeps the on-disk SQLite file current without relying on native WAL support |
| Separate `holler_data` volume | Different lifecycle than model weights — DB is small, models are large |
| In-memory rate limiting | SQLite per-request writes for rate limits would be slower than in-memory Map |
| `ADMIN_ENABLED` env var | Kill switch for security-sensitive deployments |
| `/v1/embeddings` in gateway | OpenAI-compatible endpoint avoids client code changes |
| Node.js 22.x LTS pinned | Prevents version drift from base image apt updates |
| Streaming multipart via busboy | Handles large file uploads without buffering entire file in memory |
| Lazy-require pdfjs-dist/mammoth | Only loaded when needed — keeps startup fast for non-document workloads |
| ~500 token chunks with overlap | Balances context quality vs embedding precision; overlap prevents information loss at boundaries |
| SHA-256 file dedup | Prevents re-ingesting identical files, saving compute and storage |
| Separate qdrant-client.js | Reusable HTTP client keeps document-pipeline.js and admin-routes.js focused |

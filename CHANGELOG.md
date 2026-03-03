# Changelog

All notable changes to jimbomesh-holler-server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (2026-03-02) — Mesh Resilience, SSE Fallback & Admin Restart

- **Management WebSocket ping/pong**: Keepalive ping every 25s with 10s pong timeout. Missed pong tears down the socket and reconnects automatically
- **Stepped exponential backoff**: WS reconnect delays are now `[2s, 5s, 10s, 30s, 60s]` instead of `2^n` capped at 30s
- **Full re-registration on prolonged disconnect**: If management WS has been down >5 minutes, triggers full `register()` instead of just reconnecting the WebSocket
- **Heartbeat safety net**: Each heartbeat checks management WebSocket health and reconnects if dead
- **Timer cleanup**: New `_clearMgmtTimers()` method properly cleans up ping interval, pong timeout, and WS retry timeout
- **Reusable connector instances**: `start()` resets `_stopped` flag — stopped connectors can restart without creating a new instance
- **SSE fallback inference**: When WebRTC ICE negotiation fails, SaaS sends `fallback_inference` via management WebSocket. Holler streams Ollama response back as `fallback_token` / `fallback_done` messages
- **Mesh key persistence**: Disconnect preserves `mesh_api_key` in SQLite (only clears `mesh_auto_connect`) for one-click reconnect
- **`POST /mesh/connect-stored`**: Reconnect using the stored API key from SQLite
- **`POST /mesh/forget-key`**: Explicitly clear the stored mesh API key
- **`POST /mesh/reconnect`**: Stop current connection and reconnect using stored key
- **`hasStoredMeshKey` in mesh status**: New boolean field indicating whether an API key is persisted
- **Admin UI: one-click reconnect**: Mesh card shows simplified "Connect" button when a key is stored, "Forget Key" to clear it, "Reconnect" when connected. Config form hidden when key exists
- **`POST /admin/api/restart`**: New endpoint to restart Holler (`process.exit(0)` for container manager restart) or Ollama (`pkill` on macOS Performance Mode)
- **Admin UI: Utilities section**: New section in Configuration tab with Restart Holler and Restart Ollama buttons with confirmation dialogs
- **i18n**: New `mesh.reconnect`, `mesh.reconnecting`, `mesh.forgetKey`, `mesh.quickConnect`, `admin.utilities`, `admin.restartHoller`, `admin.restartOllama`, `admin.restarting`, `admin.restartConfirm`, `admin.restartOllamaConfirm` keys in all three locales

### Added (2026-03-01) — WebRTC Peer-to-Peer Connections
- **WebRTC data channels**: Holler can now establish direct peer-to-peer connections with Buyers via WebRTC when connected to the JimboMesh mesh. Inference data streams directly Holler ↔ Buyer — SaaS only handles signaling metadata and billing reports
- **New file `mesh-webrtc.js`**: Contains `HollerPeerHandler` (connection manager with capacity limits) and `PeerSession` (per-job WebRTC lifecycle — signaling, SDP/ICE negotiation, streaming inference over RTCDataChannel, usage reporting)
- **Lazy-loaded `wrtc` module**: WebRTC native bindings are only loaded when Mesh is active — standalone mode is completely unaffected
- **Fallback chain**: Jobs with `signaling_url` and `ice_servers` attempt WebRTC first; on failure, fall back to existing HTTP polling path
- **`GET /admin/api/mesh/peers`**: New admin endpoint returning active peer connection details
- **Admin UI**: Mesh card now shows "Connection Mode" badge (WebRTC P2P / HTTP Polling) and an active peer connections table with job ID, model, state, and duration
- **Schema migration v3→v4**: New `connection_type` column on `request_stats` table — tracks whether each request was served via `webrtc`, `http`, or legacy (NULL)
- **New dependency**: `wrtc` ^0.4.7
- **New env var**: `MAX_PEER_CONNECTIONS` (default 10) — maximum concurrent WebRTC peer connections per Holler
- **i18n**: 12 new `mesh.*` locale keys in all three locales (en, hillbilly, es)
- **Docker**: `mesh-webrtc.js` added to Dockerfile COPY, `MAX_PEER_CONNECTIONS` added to docker-compose.yml

### Changed
- **OpenAPI 0.5.0**: Added `model` to AdminDocumentQueryRequest (documents/ask), coordinator URL descriptions for mesh endpoints, `connection_type` in stats/requests example
- **Documentation**: Updated API_USAGE.md with Qdrant key section, mesh status response fields, Postman table (mesh, qdrantkey), documents/ask model param. Updated ARCHITECTURE.md with request_stats table
- Renamed `install.ps1` to `setup.ps1` for naming consistency with `setup.sh`
- `setup.sh` now auto-repairs legacy SQLite stats schema (`request_stats.connection_type`) during restart/update/startup, preventing blank Statistics pages after Docker ↔ macOS Performance Mode switches
- Mesh auth now consistently uses `X-API-Key` with the original `JIMBOMESH_API_KEY` for register/heartbeat/job polling/WebRTC metadata calls; registration response tokens are ignored and `JIMBOMESH_HOLLER_API_KEY` is never overwritten by mesh operations

### Added — OpenAI-Compatible Chat Completions & OpenClaw Integration
- **`POST /v1/chat/completions`**: OpenAI-compatible chat completions endpoint with full streaming and non-streaming support
  - Parameter mapping: OpenAI format → Ollama format (max_tokens → num_predict, etc.)
  - Streaming: Server-Sent Events (SSE) with OpenAI-format chunks (`chat.completion.chunk`)
  - Non-streaming: Full OpenAI-format response with usage stats (prompt_tokens, completion_tokens)
  - Model validation: Checks model availability before proxying, returns 404 with available models list
  - Finish reasons: `stop` (normal completion) or `length` (hit max_tokens limit)
  - UUID-based completion IDs: `chatcmpl-holler-<uuid>`
  - Supports: temperature, top_p, max_tokens, stop sequences, presence_penalty, frequency_penalty
- **`GET /v1/models`**: OpenAI-compatible model list endpoint
  - Returns all Ollama models in OpenAI format (`object: "model"`, `owned_by: "jimbomesh-holler"`)
  - 30-second response cache (shared with chat completions validation)
  - Timestamps from Ollama's `modified_at` field
- **Model list caching**: 30-second TTL in-memory cache for `/api/tags` responses (reduces Ollama load)
- **`HOLLER_DEFAULT_CHAT_MODEL` env var**: Default model when client doesn't specify one (auto-detects first non-embedding model if unset)
- **[OPENCLAW_INTEGRATION.md](docs/OPENCLAW_INTEGRATION.md)**: Full integration guide for using Holler as OpenClaw's local LLM backend
  - Network setup: localhost, LAN, Docker-to-Docker, remote/cloud
  - Recommended models: llama3.1:8b, codestral:22b, qwen2.5-coder:7b, etc.
  - Troubleshooting: connection, auth, model not found, slow responses
  - Advanced: multiple Hollers, rate limiting, bearer tokens
- **[scripts/test-openclaw-connection.sh](scripts/test-openclaw-connection.sh)**: Automated test suite for OpenAI API compatibility
  - Tests: health, model list, chat (streaming/non-streaming), embeddings, invalid model, missing auth
  - Exit codes: 0 (all pass), 1 (any fail) — CI-friendly
- **Scope mapping**: `/v1/chat/completions` now maps to `chat` scope for bearer token permissions
- **Activity logging**: Chat completion requests logged with `request_type: 'chat'` for analytics

### Added — IDE Integration Guides
- **[IDE_INTEGRATIONS.md](docs/IDE_INTEGRATIONS.md)**: Comprehensive integration guides for using the Holler as a local AI backend in popular developer tools
  - **Supported IDEs**: Cursor, VS Code (Continue + Cody extensions), JetBrains (all IDEs), Neovim, Zed, Aider CLI, Windsurf
  - **Features covered**: Chat, autocomplete, inline edit, embeddings (where supported)
  - **Copy-paste configs**: Ready-to-use configuration snippets for each IDE/tool
  - **Model recommendations**: Specific model suggestions for autocomplete vs chat vs refactoring tasks
  - **Cost comparison**: Replace $79-108/month in cloud AI subscriptions with your own hardware
  - **Troubleshooting**: Common issues and solutions for all IDEs
  - README.md updated with quick-link table to IDE setup guides

### Added (2026-02-27) — macOS Metal GPU Support (Performance Mode)
- **Performance Mode for macOS**: `setup.sh` now offers a **[P] Performance Mode** on macOS that runs Ollama natively via Homebrew, giving full Apple Metal GPU access on Apple Silicon
  - Docker Desktop on macOS cannot pass Metal GPU through to containers; this is the recommended workaround
  - Installer detects macOS, shows [P] Performance / [S] Secure / [?] Docs mode selection prompt
  - `--cpu` flag selects Secure Mode automatically (no prompt), unchanged behavior for CI/scripted installs
- **Secure Mode preserved**: macOS `--cpu` / [S] option continues fully Docker-based CPU operation, unchanged from prior releases
- **`docker-compose.mac.yml` overlay**: Auto-generated by the installer
  - Sets `OLLAMA_EXTERNAL_URL=http://host.docker.internal:11434`
  - Activates via `COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml` written to `.env`
- **`docker-entrypoint.sh` branching**: When `OLLAMA_EXTERNAL_URL` is set, skips internal `ollama serve` and routes the gateway to the native host Ollama
- **Security hardening**: Performance Mode setup applies `chmod 700 ~/.ollama`, verifies localhost-only binding via `lsof`, shows mandatory security warning
- **New docs**: [MAC_WINDOWS_SETUP.md](docs/MAC_WINDOWS_SETUP.md) expanded with full Performance Mode guide, security comparison table, Apple Silicon benchmarks, model management, and mode-switching instructions
- **New files**: `UNINSTALL-OLLAMA.md` (uninstall guide for native Ollama), `docs/SECURITY.md` (security model and recommendations)
- **Env var**: `OLLAMA_EXTERNAL_URL` — when set, routes API gateway to an external Ollama instance instead of starting internal Ollama

### Added (2026-02-27) — GPU Detection and Admin Display

- **`GET /admin/api/gpu-info`**: New admin endpoint returning GPU type, VRAM usage, and Ollama offload stats
  - Detects NVIDIA GPUs via `nvidia-smi` (name, total/used/free VRAM in MB)
  - Detects Apple Metal via `OLLAMA_EXTERNAL_URL` presence (Performance Mode) or Darwin platform
  - Queries Ollama `/api/ps` for running models; computes GPU offload percentage
  - 30-second response cache — safe to poll on every tab visit
  - Response shape: `{ gpu: { name, type, vram_total_mb, vram_used_mb, vram_free_mb }, system: { total_mb, free_mb }, mode: 'metal'|'nvidia'|'metal-native'|'cpu', ollama_gpu: { running_models, gpu_offload_pct } }`
- **Marketplace tab — VRAM bar**: Color-coded VRAM / memory usage bar in the admin UI
  - NVIDIA: shows VRAM used vs total (green < 60%, yellow 60–85%, red > 85%)
  - Apple Metal (Performance Mode): shows GPU offload % and unified memory total — no discrete VRAM ceiling
  - CPU-only: shows system RAM indicator
- **Marketplace tab — model fit badges**: Each model card shows "Will fit", "Tight fit", or "Won't fit" based on available VRAM or RAM
- **`.setup-config.json`**: New file written by `setup.sh` recording installation metadata (`ollamaMode`, `installedAt`, `securityWarningAccepted`, `platform`, `arch`) — enables future tooling to detect installation mode without parsing `.env`
- **`docker-compose.mac.yml`**: Now committed to the repository (previously described as generated-only at runtime); serves as the reference template for the Performance Mode compose overlay
- **i18n**: New `marketplace.*` locale keys in all three locales: `vramGpu`, `vramMetal`, `vramMetalIdle`, `vramCpuOnly`, `gpuDetected`, `metalDetected`, `cpuOnly`, `willFit`, `willFitTight`, `wontFit`

### Added (2026-02-27) — Document RAG Pipeline
- **Documents tab**: New admin panel tab with three sub-tabs: Upload, Browse, Ask
- **File upload**: Drag-and-drop multipart upload with SSE progress streaming
  - Supported formats: `.pdf`, `.md`, `.txt`, `.csv`, `.docx`
  - SHA-256 content hashing for deduplication (rejects identical files)
  - Configurable max size via `MAX_UPLOAD_SIZE_BYTES` (default 50 MB)
- **Text extraction**: PDF via `pdf-parse`, DOCX via `mammoth`, CSV/MD/TXT via `fs.readFileSync()`
- **Smart chunking**: Paragraph-boundary splitting (~500 tokens, 50-token overlap, ~4 chars/token heuristic)
- **Embedding**: Batch embedding via Ollama `/api/embed` (batches of 10 with progress tracking)
- **Vector storage**: Qdrant upsert with rich metadata (document ID, filename, chunk index, char offset, page count)
- **Browse sub-tab**: Document table with name, size, chunks, status, date columns; View Chunks modal, Reindex, Delete actions
- **Semantic search**: `POST /admin/api/documents/query` — embed query → Qdrant search → ranked results with scores
- **RAG Q&A**: `POST /admin/api/documents/ask` — semantic search → `<retrieved_context>` XML context → streaming Ollama chat with source citations
- **Collection management**: List, create, delete Qdrant collections via dropdown selector and admin API
- **Prerequisite checks**: Documents tab shows warning banners if no embedding model found or Qdrant is unreachable
- **New files**: `qdrant-client.js` (Qdrant HTTP client), `document-pipeline.js` (processing engine)
- **New dependencies**: `busboy` ^1.6.0 (multipart), `pdf-parse` ^1.1.1 (PDF), `mammoth` ^1.8.0 (DOCX)
- **SQLite**: New `documents` table with status tracking (pending/processing/ready/error), indexed by file hash and collection
- **11 new admin API endpoints**: document upload, list, get, chunks, delete, reindex, query, ask; collection list, create, delete
- **Env vars**: `QDRANT_URL`, `DOCUMENTS_COLLECTION`, `MAX_UPLOAD_SIZE_BYTES`, `DOCUMENT_CHUNK_SIZE`, `DOCUMENT_CHUNK_OVERLAP`
- **i18n**: Full `documents.*` namespace (~55 keys) in all three locales (en, es, hillbilly)
- **Docker**: `QDRANT_URL` and document env vars added to `docker-compose.yml`; new COPY lines in `Dockerfile`

### Added (2026-02-27) — Activity Log Management
- **Clear log button**: New "Clear Log" button in Activity tab with confirmation dialog
- **Backend**: `DELETE /admin/api/activity` clears all request log entries from SQLite
- **i18n**: `activity.clearLog`, `clearConfirmTitle`, `clearConfirmMessage`, `clearSuccess`, `clearError` in all locales

### Added (2026-02-27) — Admin UI API Key Management
- **View masked key**: Configuration > Security shows current API key (first 4 + last 4 chars)
- **Copy to clipboard**: One-click copy of the full session API key
- **Regenerate key**: New 64-char hex key via `crypto.randomBytes(32)`, requires "hellyeah" confirmation
- **Runtime rotation**: New key takes effect immediately (saved to SQLite `api_key_override`), no restart needed
- **New endpoints**: `GET /admin/api/apikey` (masked), `POST /admin/api/apikey/regenerate`
- **i18n**: Full `apiKey.*` translation strings in all three locales

### Added (2026-02-27) — Auto-Login URL
- **Hash-based login**: Admin UI reads `#key=` from URL, auto-logs in, strips hash from browser URL bar
- **Installer output**: Both installers read API key from `.env` and display `http://localhost:11434/admin#key=<KEY>`
- **Secure**: Hash fragments are client-side only, never sent as HTTP requests

### Added (2026-02-27) — Interactive Installer Prompts
- **GPU detection**: Installers detect NVIDIA GPU via `nvidia-smi`, default to GPU if found, CPU if not
  - macOS shows [P] Performance Mode / [S] Secure Mode / [?] Docs prompt (see macOS Metal GPU entry above)
  - New flags: `-CpuOnly` / `--cpu` to skip the prompt and select Secure Mode / CPU automatically
- **Qdrant prompt**: Asks user if they want Qdrant vector database (default: Yes)
  - Auto-generates `QDRANT_API_KEY` when Qdrant is enabled
- **Auto-generated API keys**: Both `JIMBOMESH_HOLLER_API_KEY` and `QDRANT_API_KEY` generated on first install
  - PowerShell: `System.Security.Cryptography.RandomNumberGenerator`
  - Bash: `openssl rand -hex 32` with `/dev/urandom` fallback
- **Existing install detection**: If container/image/.env exists, shows interactive menu:
  - Update (rebuild + restart, preserves models), Restart, Fresh install, Stop, Cancel
  - Eliminates concern about re-downloading large models

### Fixed (2026-02-27) — Installer Health Check
- Installer wait loops now poll `http://localhost:9090/healthz` (unauthenticated) instead of `http://localhost:11434/api/tags` (requires API key)
- Prevents flood of `401 Missing API key` messages in container logs during install

### Fixed (2026-02-27) — PowerShell Installer Syntax
- Replaced bash-style `fprint_banner()` function with valid PowerShell `Write-Banner` function

### Changed (2026-02-27) — HOLLER_MODELS Rename
- **BREAKING**: Renamed `OLLAMA_MODELS` to `HOLLER_MODELS` in all code, config, and docs
  - Fixes naming collision with Ollama's native `OLLAMA_MODELS` env var (model storage directory path)
  - Host-level `OLLAMA_MODELS` was leaking into the container and treated as a model name to pull
- **Migration**: Update `.env`: change `OLLAMA_MODELS=` to `HOLLER_MODELS=`

### Added (2026-02-27) — Developer Tooling
- **Deploy Code launch config**: New "Docker: Deploy Code" VS Code run configuration — rebuilds image and force-recreates container without touching volumes
- **CURSOR_VS_CODE.md**: IDE run configurations, Cursor rules, developer workflow, terminal commands

### Changed (2026-02-25) — Docker Compose Refactor
- **BREAKING**: Removed `cpu` and `gpu` Docker Compose profiles — replaced with compose override file
  - Merged `jimbomesh-still` (cpu) and `jimbomesh-still-gpu` into a single `jimbomesh-still` service
  - GPU support now via `docker-compose.gpu.yml` overlay, loaded by setting `COMPOSE_FILE` in `.env`
  - Eliminates container name conflict when running `docker compose down` after GPU mode
  - `docker compose down` now always works — no profile flags needed
- **Setup scripts updated**: `setup.sh` and `setup.ps1` write `COMPOSE_FILE` to `.env` when `--gpu` / `-WithGpu` is passed
- **Migration**: Users with `--profile gpu` in their workflow should add to `.env`:
  - Linux/macOS: `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml`
  - Windows: `COMPOSE_FILE=docker-compose.yml;docker-compose.gpu.yml`

### Added (2026-02-25) — Admin UI Branding Kit
- **JimboMesh brand theme**: Teal `#0d9488` accent, dark navy `#0f172a` backgrounds, new CSS variables (`--accent-glow`, `--secondary`, `--secondary-hover`)
- **Brand assets**: New `admin/assets/` directory
  - `logo.svg` — Whiskey glass icon + "HOLLER" text (login page)
  - `favicon.svg` — Whiskey glass icon (browser tab + header)
  - `theme.css` — User-overridable theme file loaded after `style.css`
  - `README.md` — Quick customization guide
- **Login page upgrade**: Radial gradient background, centered logo, accent glow shadow, polished button hover
- **Header upgrade**: 56px height, brand icon in header, accent-colored "Admin" label, backdrop blur
- **Branding API**: `GET /admin/api/branding` (unauthenticated) returns `serverName` and `adminTitle` from env vars
- **Dynamic server name**: `HOLLER_SERVER_NAME` env var shown in login title and header without code editing
- **Dynamic tab title**: `HOLLER_ADMIN_TITLE` env var sets the browser tab title
- **Customization guide**: `docs/CUSTOMIZATION.md` with full CSS variable reference, logo replacement, four theme examples

### Added (2026-02-25) — Production Hardening
- **Graceful Shutdown**: SIGTERM/SIGINT with configurable drain timeout (`SHUTDOWN_TIMEOUT_MS`, default 10s)
  - Track and drain active connections before exit
  - `/readyz` endpoint returns 503 during shutdown drain
  - `docker-entrypoint.sh` uses `exec` for node process (PID 1 receives signals directly)
  - Kill child processes (Ollama, health server) on exit
- **Persistent Rate Limiting**: SQLite-backed rate limits survive container restarts
  - In-memory Map as hot cache in front of SQLite (write-through, zero-disk-hit on most requests)
  - `RATE_LIMIT_BURST` env var (default: 10) allows short bursts above per-minute rate
  - Expired entries purged from SQLite and cache every 5 minutes
  - `Retry-After` header on 429 responses
- **Admin Role Separation**: New `ADMIN_API_KEY` env var
  - Admin routes (`/admin/api/*`) require `ADMIN_API_KEY` when set
  - Inference routes (`/v1/*`, `/api/*`) continue using `JIMBOMESH_HOLLER_API_KEY`
  - Falls back to `JIMBOMESH_HOLLER_API_KEY` when `ADMIN_API_KEY` not set (backward compatible)
  - Logs which key type was used: `(inference-key)` vs `(admin-key)`
- **Request Validation & Resource Limits**:
  - `MAX_REQUEST_BODY_BYTES` (default 1MB) — returns 413 with early Content-Length check
  - `MAX_BATCH_SIZE` (default 100) — limits `/v1/embeddings` array input
  - `OLLAMA_TIMEOUT_MS` (default 2min) — returns 504 on backend timeout
  - `MAX_CONCURRENT_REQUESTS` (default 4) — queues excess requests
  - `MAX_QUEUE_SIZE` (default 50) — returns 429 when queue is full
- **Structured Error Responses**: All errors use `{ error: { code, message, type } }` format
  - `sendError()` helper as single source of truth
  - Error codes: `auth_required`, `auth_invalid`, `rate_limited`, `payload_too_large`, `batch_too_large`, `request_timeout`, `queue_full`, `model_not_found`, `model_error`, `shutting_down`
  - `Retry-After` header on 429 and 503 responses
  - Admin API routes use same error format
- **Optional TLS Support**: `TLS_CERT_PATH` + `TLS_KEY_PATH` env vars
  - If both set, starts HTTPS; if neither set, starts HTTP (default)
  - If only one set, logs error and exits (no silent fallback)
  - `TLS_PASSPHRASE` for encrypted private keys

### Added (2026-02-24)
- **NEW**: SQLite persistent storage via `better-sqlite3`
  - Request logs survive container restarts (replaces in-memory ring buffer)
  - Runtime-mutable settings stored in `settings` table (editable from admin UI)
  - Hourly aggregated statistics in `stats_hourly` table
  - Schema versioning for future migrations
  - WAL mode and prepared statements for high performance
  - New `db.js` module with full CRUD helpers
  - New `package.json` with `better-sqlite3` dependency
  - New `holler_data` Docker volume at `/opt/jimbomesh-still/data/`
  - Database path configurable via `SQLITE_DB_PATH` env var
  - Log retention configurable via `LOG_RETENTION_DAYS` env var (default: 30 days)
  - Automatic hourly stats rollup (every 5 minutes)
  - Automatic log pruning (every hour)
  - Graceful database close on shutdown

- **NEW**: Admin API endpoints for settings and statistics
  - `GET /admin/api/settings` — list all runtime settings
  - `POST /admin/api/settings` — update a runtime setting
  - `GET /admin/api/stats` — hourly stats and summary (all-time + today)
  - `GET /admin/api/activity` now supports `?limit=N&offset=N` pagination
  - `GET /admin/api/status` now includes `total_requests` and `db_size_bytes`

- **NEW**: Admin UI enhancements
  - Dashboard: persistent stats (today's requests, embed/chat counts, errors, avg duration, DB size)
  - Activity tab: pagination controls with page navigation
  - Configuration tab: editable runtime settings section with save buttons
  - Activity log description updated to reflect SQLite persistence

### Changed (2026-02-24)
- Dockerfile now installs `build-essential`, `python3` for native module compilation
- Dockerfile runs `npm install --production` to build `better-sqlite3`
- Docker Compose adds `holler_data` volume for SQLite persistence
- Activity ring buffer replaced with SQLite-backed logging
### Added (2026-02-23)
- **NEW**: Model benchmark script (`scripts/benchmark-models.sh`) and guide (`docs/MODEL_BENCHMARKS.md`)
  - Benchmarks embedding latency across models: nomic-embed-text, mxbai-embed-large, snowflake-arctic-embed, all-minilm
  - Tests short/medium/long text and batch embedding latency
  - Outputs markdown table and JSON results file
  - Includes model recommendations, storage impact analysis, MTEB scores
- **NEW**: ARM64 deployment documentation (`docs/ARM_SUPPORT.md`)
  - Apple Silicon (M1/M2/M3/M4), Raspberry Pi 4/5, AWS Graviton
  - Memory requirements, recommended configurations, performance expectations
  - GPU acceleration limitations (no Metal passthrough in Docker)
  - Troubleshooting for common ARM issues
- **NEW**: Multi-stage Dockerfile evaluation in `docs/DOCKERBUILD.md`
  - Analyzed image size breakdown: base ~1.5 GB, Node.js ~100 MB, deps ~30 MB, build artifacts ~15 MB
  - Not adopted: <1.2% savings vs added complexity
  - Documented effective size reduction strategies
- **NEW**: OpenAI-compatible `/v1/embeddings` endpoint in API gateway
  - Drop-in replacement: just change the base URL from OpenAI to this server
  - Translates between OpenAI and Ollama embedding formats automatically
  - Supports batch embedding: pass an array of strings for multiple embeddings in one request
  - Returns OpenAI-format response with `object`, `data`, `model`, and `usage` fields
  - Defaults to `OLLAMA_EMBED_MODEL` env var when model is not specified in the request

### Changed (2026-02-23)
- **Pin Node.js 22.x LTS** in Dockerfile via NodeSource instead of floating apt version
- **Remove orphaned `nginx.conf`** — dead code from before the Node.js gateway

### Fixed (2026-02-23)
- **CRITICAL**: Fix health-handler.sh hitting gateway port 11434 (requires auth) instead of internal Ollama port 11435
  - Health checks were always getting 401 and reporting Ollama as down
  - Now uses `OLLAMA_INTERNAL_PORT` (default 11435) to reach Ollama directly
  - Also fixed healthcheck.sh fallback path with same issue
- **Fix init-qdrant exit code 22** — `curl -sf` was failing on HTTP 404 (collection not found) before the status code could be checked, killing the script via `set -e`. Removed `-f` flag and added explicit HTTP status handling. Also treats 409 (already exists) as success.
- **Fix stale model default** in `docker-entrypoint.sh` and `pull-models.sh` — fallback was `llama3.2:3b` instead of `llama3.1:8b`

### Changed (2026-02-22)
- **RENAMED**: Established hierarchical naming convention
  - Repository: `jimbomesh-holler-server`
  - Docker Compose project: `jimbomesh-holler` (namespace for all services)
  - Main service: `jimbomesh-still` (Ollama server, allows future variants)
  - Supporting services: `jimbomesh-qdrant`, `init-qdrant`
  - Docker image: `jimbomesh-still:latest`
  - Network: `jimbomesh-holler_default` (auto-created)
  - Volumes: `jimbomesh-holler_ollama_models`, `jimbomesh-holler_qdrant_storage`
  - Added `NAMING.md` to document naming hierarchy and rationale
  - Updated all documentation to reflect new naming scheme

### Added (2026-02-22)
- **NEW**: Web-based Admin UI at `/admin` on the API gateway port
  - Dashboard with server health, Ollama latency, model count, running models, uptime (auto-refresh 10s)
  - Models tab: list installed models, pull with SSE progress streaming, delete with confirmation, view details
  - Playground tab: test embeddings (dimensions + latency), chat with streaming, generate with streaming
  - Configuration tab: read-only view of all env vars grouped by category (API keys shown as boolean only)
  - Activity tab: last 200 requests with timestamp, method, path, status, IP, duration (auto-refresh 5s)
  - Vanilla JavaScript — no framework dependencies, no build step
  - Dark theme, responsive layout
  - API key authentication via `sessionStorage` (cleared on tab close)
  - `ADMIN_ENABLED` env var to disable all `/admin` routes (default: `true`)
  - Path traversal protection, CSP headers, no secrets in static assets
  - In-memory activity ring buffer (last 200 requests) in the gateway process
  - New files: `admin-routes.js`, `admin/index.html`, `admin/app.js`, `admin/style.css`


- **NEW**: API Key Authentication for Ollama server
  - Node.js API gateway (`api-gateway.js`) validates X-API-Key header on all requests
  - Ollama now runs on internal port 11435 (localhost only)
  - API gateway on external port 11434 with rate limiting (60 req/min per IP)
  - Health endpoint `/health` bypasses auth for monitoring
  - Configured via `JIMBOMESH_HOLLER_API_KEY` environment variable
  - Generate with: `openssl rand -hex 32`

- Created comprehensive Mac → Windows setup documentation
- Added TROUBLESHOOTING.md with common issues and solutions
- Added this CHANGELOG.md to track project changes
- Created `.gitattributes` to enforce Unix line endings for shell scripts
- Added `embed_model` and `embed_source` metadata to Qdrant payloads
- Configured Qdrant with API key authentication
- Installed Node.js in Docker image for API gateway

### Fixed (2026-02-22)
- **CRITICAL**: Fixed Docker entrypoint path in Dockerfile (relative → absolute path)
  - Changed from `ENTRYPOINT ["docker-entrypoint.sh"]`
  - To `ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]`
  - This was causing container restart loops

- **CRITICAL**: Fixed Windows line endings (CRLF → LF) in all shell scripts
  - Converted `docker-entrypoint.sh` from CRLF to LF
  - Converted all scripts in `scripts/` directory from CRLF to LF
  - Line endings were causing "exec: no such file or directory" errors

- **CRITICAL**: Fixed shell compatibility issue in docker-entrypoint.sh
  - Changed shebang from `#!/bin/sh` to `#!/bin/bash`
  - The script uses bash-specific features like `trap SIGTERM`
  - This was causing "trap: SIGTERM: bad trap" errors

### Changed (2026-02-22)
- **BREAKING**: Updated default LLM model from `llama3.2:3b` to `llama3.1:8b`
  - Llama 3.1 8B provides better performance and 128K context window
  - Increased model size from ~2GB to ~4.9GB
  - Updated `.env`, `.env.example`, and `docker-compose.yml`

- Updated JimboMesh embed.sh to support dual backends (Ollama + OpenRouter)
  - Auto-detects backend based on `OLLAMA_URL` environment variable
  - Handles both Ollama and OpenRouter API formats
  - Maintains backward compatibility with existing OpenRouter usage

- Generated and configured Qdrant API key
  - Previously used placeholder value
  - Now uses secure 32-byte hex key (auto-generated)

### Security
- **MAJOR**: Implemented API key authentication for Ollama server
  - All API requests require X-API-Key header (401 Unauthorized if missing)
  - Invalid API keys rejected with 403 Forbidden
  - Rate limiting prevents abuse (429 Too Many Requests after 60 req/min)
  - Ollama isolated on internal localhost port, only accessible via authenticated gateway
  - Prevents unauthorized access to embedding and LLM endpoints

- Enforced Unix line endings via `.gitattributes` to prevent script execution issues
- Added Qdrant API key for database access control
- Documented trust boundary handling in retrieved context

## Known Issues

No known issues at this time.

## Upgrade Notes

### From Previous Versions to 2026-02-22

1. **Set API Key** (**REQUIRED** for API authentication):
   ```bash
   # Generate API key
   openssl rand -hex 32

   # Add to .env
   JIMBOMESH_HOLLER_API_KEY=your_generated_key_here
   ```

2. **Rebuild Docker Image** (required for API gateway):
   ```bash
   docker compose down
   docker compose build --no-cache
   docker compose up -d
   ```

3. **Update Client Applications**:
   - All API requests must now include `X-API-Key` header
   - Update JimboMesh `.env` to include `JIMBOMESH_HOLLER_API_KEY=<same-key-as-server>`
   - Example: `curl -H "X-API-Key: your_key" http://localhost:11434/api/tags`

4. **Update .env** (if using Qdrant):
   ```bash
   # Replace placeholder API key
   QDRANT_API_KEY=<generate-with-openssl-rand-hex-32>
   ```

5. **Model Update** (optional):
   - llama3.2:3b → llama3.1:8b
   - Will download ~4.9GB on first start
   - Or keep using llama3.2:3b by updating `.env`

6. **JimboMesh Integration** (if using with Mac):
   - Update JimboMesh's `scripts/embed.sh` with dual-backend support
   - Add `OLLAMA_URL` and `JIMBOMESH_HOLLER_API_KEY` to JimboMesh's `.env`
   - See [docs/MAC_WINDOWS_SETUP.md](docs/MAC_WINDOWS_SETUP.md)

## Version History

### [1.0.0] - 2026-02-21
- Initial release
- Docker-based Ollama server
- Support for nomic-embed-text embeddings
- Optional Qdrant integration
- Health check endpoints
- Installation scripts for Windows and Linux/macOS

---

## Contributing

When adding changelog entries:
- Use present tense ("Add feature" not "Added feature")
- Reference issue/PR numbers when applicable
- Group changes by type: Added, Changed, Deprecated, Removed, Fixed, Security
- Keep descriptions concise but informative

## Links

- [GitHub Repository](https://github.com/IngressTechnology/jimbomesh-holler-server)
- [Issue Tracker](https://github.com/IngressTechnology/jimbomesh-holler-server/issues)
- [Documentation](docs/)

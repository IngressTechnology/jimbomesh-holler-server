# Claude Code Project Notes

## Key Paths

- **Source repo:** `jimbomesh-holler-server/` (workspace root)
  - Docker Compose: `docker-compose.yml`
  - Environment: `.env` / `.env.example`
  - Docs: `docs/` (ARCHITECTURE.md, DEPLOYMENT.md, CONFIGURATION.md, DOCKERBUILD.md, INTEGRATION.md, API_USAGE.md, CURSOR_VS_CODE.md, IDE_INTEGRATIONS.md, OPENCLAW_INTEGRATION.md, SECURITY.md, CUSTOMIZATION.md, MAC_WINDOWS_SETUP.md, ARM_SUPPORT.md, MODEL_BENCHMARKS.md, TROUBLESHOOTING.md)
  - API Spec: `openapi.yaml` (OpenAPI 3.0.3, spec version 0.7.3, served at `/docs` via Swagger UI)
  - Scripts: `scripts/` (embed.sh, healthcheck.sh, health-server.js, init-qdrant.sh, benchmark-models.sh, test-openclaw-connection.sh)

- **Integration notes:**
  - Can be used as an on-prem embeddings backend for other applications
  - Supports dual-backend embed.sh that auto-detects based on OLLAMA_URL env var
  - Compatible with applications expecting 768d embeddings (nomic-embed-text)

## Project Structure

```
jimbomesh-holler-server/
  Dockerfile              # Extends ollama/ollama:0.17.4
  docker-compose.yml      # Base compose: Ollama service + optional Qdrant (profile)
  docker-compose.gpu.yml  # GPU overlay: adds NVIDIA deploy config (loaded via COMPOSE_FILE)
  docker-compose.mac.yml  # macOS Performance Mode overlay: sets OLLAMA_EXTERNAL_URL (committed; also written by setup.sh)
  .setup-config.json      # Written by setup.sh — records ollamaMode, installedAt, securityWarningAccepted, platform, arch
  docker-entrypoint.sh    # Production entrypoint (start → wait → pull → serve; branches on OLLAMA_EXTERNAL_URL)
  mesh-webrtc.js          # WebRTC peer-to-peer handler (HollerPeerHandler, PeerSession) for direct Buyer connections
  package.json            # Node.js dependencies (sql.js, busboy, pdfjs-dist, mammoth, swagger-ui-dist, jsonwebtoken, jwks-rsa, optional wrtc)
  setup.ps1             # Windows PowerShell installer
  setup.sh                # Linux/macOS Bash installer
  .env.example            # Configuration template
  api-gateway.js          # Node.js API gateway with auth, rate limiting, admin, /v1/embeddings, /docs
  db.js                   # SQLite database layer (sql.js, persisted on mutation)
  qdrant-client.js        # Qdrant vector DB HTTP client (collections, points, search)
  document-pipeline.js    # Document RAG pipeline (extract, chunk, embed, store, search, Q&A)
  openapi.yaml            # OpenAPI 3.0.3 spec, version 0.7.3 (served by Swagger UI at /docs)
  admin-routes.js         # Admin UI API route handlers + static file server
  stats-collector.js      # Request stats collection, model metadata/pricing, Moonshine pricing
  mesh-connector.js       # JimboMesh SaaS mesh connector (registration, heartbeat, job polling, WebRTC)
  token-manager.js        # Tier 2 auth: named bearer tokens (jmh_*) with SHA-256 hashing, scoped permissions, per-token rate limits
  jwt-validator.js        # Tier 3 auth: Auth0 JWT validation with JWKS caching for mesh-connected mode
  swagger-brand.js        # Swagger UI customization (footer, branding)
  swagger-brand.css       # Swagger UI custom styles
  admin/
    index.html            # Admin SPA shell (minimal, JS-rendered)
    i18n.js               # Internationalization runtime (t() function, localStorage, reactive updates)
    app.js                # Vanilla JS application (auth, dashboard, models, playground, activity, documents)
    style.css             # Dark theme, responsive layout
    locales/
      en.json             # English translations
      hillbilly.json      # Hillbilly translations (moonshine-themed)
      es.json             # Spanish translations
    assets/
      logo.svg            # Login page logo (teal whiskey glass + HOLLER text)
      favicon.svg         # Browser tab icon + header icon (whiskey glass)
      theme.css           # User-overridable theme file (loaded after style.css)
      README.md           # Quick customization guide for assets
  scripts/
    embed.sh              # Ollama-compatible embedding pipeline
    healthcheck.sh        # Docker health check (tries HTTP endpoint, falls back to direct)
    health-server.js      # Node.js health HTTP server (/healthz, /readyz, /status on :9090)
    health-server.sh      # HTTP health server launcher (legacy socat wrapper)
    health-handler.sh     # HTTP health request handler (legacy, superseded by health-server.js)
    init-qdrant.sh        # Qdrant collection initializer (one-shot)
    benchmark-models.sh   # Embedding model benchmark (latency comparison)
    test-openclaw-connection.sh  # OpenClaw compatibility test (7 endpoint checks)
    entrypoint.sh         # Legacy entrypoint (superseded by docker-entrypoint.sh)
    pull-models.sh        # Legacy model puller (merged into docker-entrypoint.sh)
  docs/
    ARCHITECTURE.md       # System design, data flow, security, SQLite storage
    DEPLOYMENT.md         # Installation, operations, troubleshooting
    CONFIGURATION.md      # Environment variables, models, profiles
    DOCKERBUILD.md        # Image build process, rebuild guide
    INTEGRATION.md        # Integration guide, dimension migration
    MODEL_BENCHMARKS.md   # Embedding model comparison and benchmark guide
    ARM_SUPPORT.md        # ARM64 deployment (Apple Silicon, Raspberry Pi, Graviton)
    MAC_WINDOWS_SETUP.md  # Mac Setup Guide: Performance Mode (Metal GPU), Secure Mode, Mac → Windows cross-machine
    TROUBLESHOOTING.md    # Common issues and solutions (includes macOS Performance Mode section)
    API_USAGE.md          # API usage guide (curl, Postman, Swagger UI)
    CUSTOMIZATION.md      # Admin UI theming, branding, CSS variables guide
    CURSOR_VS_CODE.md     # IDE run configs, tasks, Cursor rules, developer workflow
    SECURITY.md           # Security model: Performance Mode vs Secure Mode, auth, TLS, rate limiting
    IDE_INTEGRATIONS.md   # IDE setup guides (Cursor, VS Code+Continue, JetBrains, Neovim, Zed, Aider, Windsurf)
    OPENCLAW_INTEGRATION.md # OpenClaw provider setup and testing
  NAMING.md               # Naming convention hierarchy
  QUICK_START.md          # Install holler, start still, configure Admin UI
  CONTRIBUTING.md         # Contribution guide, repo map, PR expectations
  CODE_OF_CONDUCT.md      # Contributor Covenant 2.1
  CHANGELOG.md            # Version history and changes
  UNINSTALL-OLLAMA.md     # Uninstall guide for native Ollama (macOS Performance Mode)
  TODO.md                 # Open and completed work items
  SESSION_SUMMARY.md      # Legacy session notes (2026-02-22)
  .github/
    PULL_REQUEST_TEMPLATE.md  # PR template
  .gitattributes          # Enforces Unix line endings for scripts
```

## Naming Convention

- **Repository/Project**: `jimbomesh-holler-server` — Overall project containing multiple services
- **Compose Project**: `jimbomesh-holler` — Groups all Docker services under one namespace
- **Main Service**: `jimbomesh-still` — Primary Ollama service (can have GPU variant)
- **Supporting Services**: `jimbomesh-qdrant`, `init-qdrant` — Use compose project prefix
- **Docker Image**: `jimbomesh-still:latest` — Built from Dockerfile
- **Network**: `jimbomesh-holler_default` — Auto-created by Compose
- **Volumes**: `jimbomesh-holler_ollama_models`, `jimbomesh-holler_qdrant_storage`

See [NAMING.md](NAMING.md) for detailed hierarchy and rationale.

## Docker Compose Configuration

- **CPU/Secure Mode (default)**: `docker compose up -d` — no extra flags needed
- **NVIDIA GPU**: Set `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env`, then `docker compose up -d`
- **macOS Performance Mode**: Set `COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml` in `.env` (done automatically by `setup.sh`), then `docker compose up -d`. Requires native Ollama running via `brew services start ollama`.
- **Qdrant**: `docker compose --profile qdrant up -d`
- **Down**: `docker compose down` — always works (no profile flags needed)

## macOS Dual-Mode Architecture

Two deployment modes for macOS. The mode is controlled by whether `docker-compose.mac.yml` overlay is active:

| | Secure Mode | Performance Mode |
|---|---|---|
| Ollama location | Inside Docker container (CPU) | Native on host (`brew services`) |
| Metal GPU | No | Yes — full Apple Silicon GPU |
| Activated by | Default (no overlay) | `COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml` |
| Key env var | — | `OLLAMA_EXTERNAL_URL=http://host.docker.internal:11434` |
| Model storage | Docker volume `ollama_models` | `~/.ollama/models/` |
| Setup | `./setup.sh --cpu` or `[S]` | `./setup.sh` then `[P]` |

**`docker-entrypoint.sh` branching**: When `OLLAMA_EXTERNAL_URL` is set, skips `ollama serve`, routes gateway to the external URL, and uses `OLLAMA_HOST` env var for model pulls targeting the host Ollama.

**Security**: Performance Mode exposes Ollama at `localhost:11434` on the host (any local process can reach it). `setup.sh` hardens with `chmod 700 ~/.ollama` and verifies localhost-only binding. See `docs/SECURITY.md`.

## Key Concepts

- **Embedding dimensions**: Supports 768d embeddings via nomic-embed-text model. Cannot mix different dimensions in same Qdrant collection.
- **Dual-backend support**: embed.sh auto-detects Ollama vs OpenRouter based on OLLAMA_URL environment variable
- **OpenAI compatibility**: `/v1/embeddings` endpoint translates OpenAI format to Ollama format (supports batch)
- **Swagger UI**: Live interactive API docs at `/docs` (unauthenticated, backed by `openapi.yaml`)
- **Trust boundaries**: All embedded text wrapped in `<retrieved_context>` XML tags for safe RAG integration.
- **Admin UI branding**: Customizable via CSS variables (`admin/assets/theme.css`), logo replacement, and env vars (`HOLLER_SERVER_NAME`, `HOLLER_ADMIN_TITLE`). See `docs/CUSTOMIZATION.md`.
- **Internationalization (i18n)**: Admin UI supports English, Hillbilly, and Spanish. Language selector in toolbar, persists to `localStorage` (`holler-lang`), defaults to English. All UI strings live in `admin/locales/*.json`. See `docs/CUSTOMIZATION.md`.
- **API key management**: Admin UI can view masked key, copy full key (with `JIMBOMESH_HOLLER_API_KEY=` prefix for .env), regenerate with "hellyeah" confirmation. Runtime rotation stored in SQLite (`api_key_override`), no container restart needed.
- **Qdrant key management**: Admin UI shows Qdrant key status; when configured, displays masked key with copy button (copies `QDRANT_API_KEY=<key>` for direct .env paste). Backend: `GET /admin/api/qdrantkey`.
- **Auto-login URL**: `http://host:1920/admin#key=<KEY>` — hash-based auto-login, printed by installers on first install. Hash never sent to server.
- **Interactive installers**: GPU/mode, Qdrant, and existing-install detection prompts. macOS: `[P]` Performance Mode (native Ollama + Metal GPU) or `[S]` Secure Mode (Docker CPU). Linux/Windows: NVIDIA GPU detection. Auto-generate both API keys on first run. Support `-CpuOnly`/`--cpu` and `-WithQdrant`/`--qdrant` flags. One-liner install commands available (git, curl, wget, PowerShell `irm`).
- **macOS Performance Mode**: Native Ollama via `brew services`, Docker runs only API gateway. Full Metal GPU. `OLLAMA_EXTERNAL_URL` env var routes gateway to host Ollama. `docker-compose.mac.yml` overlay committed to repo and also written by `setup.sh`. Models stored in `~/.ollama/models/`. Security hardening applied automatically. Installation metadata persisted to `.setup-config.json`.
- **GPU detection API**: `GET /admin/api/gpu-info` (admin auth required) — detects NVIDIA via `nvidia-smi`, Apple Metal via `OLLAMA_EXTERNAL_URL` / Darwin platform. Returns GPU name, VRAM (total/used/free), Ollama offload %, and system RAM. 30s response cache. Used by the Marketplace tab to render a VRAM bar and model fit badges ("Will fit" / "Tight fit" / "Won't fit").
- **`.setup-config.json`**: Written by `setup.sh` to record `{ ollamaMode, installedAt, securityWarningAccepted, platform, arch }`. Allows tooling to detect whether the installation is in Performance Mode or Secure Mode without parsing `.env`.
- **Document RAG Pipeline**: Upload files (.pdf, .md, .txt, .csv, .docx) via Admin UI Documents tab → automatic text extraction, chunking (~500 tokens, 50-token overlap), embedding via Ollama, and vector storage in Qdrant. Semantic search and RAG Q&A with streaming answers. Backend: `qdrant-client.js` (HTTP client), `document-pipeline.js` (processing engine). SQLite `documents` table for metadata. Files stored in `holler_data` volume at `/data/documents/`.
- **WebRTC Peer-to-Peer**: When connected to the mesh, the Holler can establish direct WebRTC data channels with Buyers. Inference data flows peer-to-peer (SaaS only handles signaling + billing). `mesh-webrtc.js` contains `HollerPeerHandler` (manages connections, enforces `MAX_PEER_CONNECTIONS`) and `PeerSession` (per-job signaling, SDP/ICE negotiation, streaming inference over data channel). Lazy-loads the optional `wrtc` native module — if it is unavailable, the server keeps running and falls back to non-WebRTC paths. Fallback chain: WebRTC → SSE fallback (via management WebSocket) → HTTP polling. Admin UI shows connection mode badge and active peer table. `GET /admin/api/mesh/peers` endpoint.
- **Mesh key persistence**: Disconnecting from the mesh keeps `mesh_api_key` in SQLite so the user can reconnect with one click. `POST /mesh/connect-stored` reconnects using the stored key. `POST /mesh/forget-key` explicitly clears it.
- **Admin restart controls**: `POST /admin/api/restart` with `{ target: 'holler' | 'ollama' }`. Holler restart exits the process for container/process manager restart. Ollama restart sends `pkill` on macOS Performance Mode. Admin UI "Utilities" section with Restart Holler / Restart Ollama buttons.
- **Enhanced Security (Bearer Tokens — Tier 2)**: Named bearer tokens (`jmh_*`) with SHA-256 hashing, scoped permissions, per-token rate limits, expiry, and usage tracking. Tokens stored in `/data/keys.json`. Enable via `ENHANCED_SECURITY_ENABLED=true` or Admin UI toggle. Managed via `token-manager.js`. Admin endpoints: `GET/POST/DELETE/PATCH /admin/api/tokens`, `GET /admin/api/tokens/:id/usage`, `GET /admin/api/auth/status`.
- **JWT Validation (Tier 3)**: Auth0 JWT validation with JWKS caching for mesh-connected mode. Activated when `JIMBOMESH_API_KEY` is set and `data/auth0-config.json` exists. `jwt-validator.js` validates RS256 JWTs, extracts buyer ID, permissions, and per-buyer rate limits.
- **Three-tier auth model**: Tier 1 = API Key (`X-API-Key`), Tier 2 = Bearer Tokens (`jmh_*`), Tier 3 = JWT (Auth0). Each tier builds on the previous.
- **IDE Integrations**: Setup guides for Cursor, VS Code+Continue, VS Code+Cody, JetBrains, Neovim, Zed, Aider, and Windsurf. See `docs/IDE_INTEGRATIONS.md`.
- **OpenClaw Integration**: Use Holler as a local LLM backend for OpenClaw. Provider config, testing script, bearer token support. See `docs/OPENCLAW_INTEGRATION.md`.
- **Swagger UI branding**: Custom footer and styles via `swagger-brand.js` and `swagger-brand.css`.
- **Node.js health server**: `scripts/health-server.js` replaces the legacy socat/bash health server. Listens on `HEALTH_PORT` (9090), serves `/healthz`, `/readyz`, `/status`.
- **Model pricing and Moonshine**: `stats-collector.js` tracks model metadata, per-model pricing (Moonshine tokens), and inference metrics. Admin endpoints: `GET/POST /admin/api/stats/pricing`.

## Recent Changes

### Recent Changes (2026-03-02)

### Mesh Connector Resilience & SSE Fallback
- **Ping/pong keepalive**: Management WebSocket now has proper ping/pong with 10s pong timeout. If pong is missed, the WebSocket is torn down and reconnected automatically.
- **Stepped exponential backoff**: WS reconnect delays are now `[2s, 5s, 10s, 30s, 60s]` (was `Math.pow(2, retries)` capped at 30s).
- **Full re-registration after 5 min downtime**: If management WS has been disconnected >5 minutes, triggers a full re-registration instead of just reconnecting the WebSocket.
- **Heartbeat safety net**: Each heartbeat checks if the management WebSocket is dead and reconnects it.
- **Timer cleanup**: New `_clearMgmtTimers()` method properly clears ping interval, pong timeout, and retry timeout. Called on stop, cancel, disconnect, and reconnect.
- **Reusable connector instances**: `start()` now resets `_stopped` flag, allowing a stopped connector to be restarted without creating a new instance.
- **SSE fallback inference**: When WebRTC ICE negotiation fails, SaaS sends a `fallback_inference` message via the management WebSocket. The Holler streams the Ollama response back as `fallback_token` / `fallback_done` messages. New `_handleFallbackInference()` and `_sendMgmtMessage()` methods.

### Mesh Key Persistence & One-Click Reconnect
- **Disconnect preserves key**: `handleMeshDisconnect` now keeps `mesh_api_key` in SQLite (only clears `mesh_auto_connect`). Users can reconnect with one click instead of re-entering the key.
- **`POST /mesh/connect-stored`**: New endpoint to reconnect using the stored API key without re-entering it.
- **`POST /mesh/forget-key`**: New endpoint to explicitly clear the stored mesh API key from SQLite.
- **`POST /mesh/reconnect`**: New endpoint to stop the current connection and reconnect using the stored key.
- **`hasStoredMeshKey`**: New boolean field in mesh status response indicating whether a key is stored.
- **Admin UI**: Mesh card shows one-click "Connect" button when a stored key exists (instead of the full config form). "Forget Key" button to clear the stored key. "Reconnect" button when connected. Config fields are hidden when a key is stored for a cleaner UI.

### Admin Restart Controls
- **`POST /admin/api/restart`**: New endpoint accepting `{ target: 'holler' | 'ollama' }`. Holler restart calls `process.exit(0)` for container/process manager restart. Ollama restart sends `pkill -f "ollama serve"` on macOS Performance Mode.
- **Admin UI**: New "Utilities" section in Configuration tab with Restart Holler (warning style) and Restart Ollama buttons, both with confirmation dialogs.
- **i18n**: New `admin.utilities`, `admin.restartHoller`, `admin.restartOllama`, `admin.restarting`, `admin.restartConfirm`, `admin.restartOllamaConfirm` keys in all three locales.
- **Mesh i18n**: New `mesh.reconnect`, `mesh.reconnecting`, `mesh.forgetKey`, `mesh.quickConnect` keys in all three locales.

### Recent Changes (2026-03-01)

### Documentation & Swagger (2026-03-01)
- **OpenAPI 0.5.0**: Added `model` to AdminDocumentQueryRequest (documents/ask), coordinator URL descriptions for mesh endpoints, `connection_type` in stats/requests schema/example
- **API_USAGE.md**: Qdrant key section, mesh status response fields (hollerId, autoConnect, peerConnections), Postman table (mesh, qdrantkey), documents/ask model param
- **ARCHITECTURE.md**: `request_stats` table with connection_type in SQLite storage section

### Mesh Connection UX Overhaul
- **`mesh-connector.js`**: Replaced boolean `connected`/`connecting` with `_state` enum (`'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting'`). Backward-compat getters preserve `connector.connected` API. Added circular log buffer (`_log`, 100 entries), `_addLog(type, message)` method, `cancel()` method with `_aborted` flag, `hollerName` config support. `getStatus()` now returns `state`, `errorMessage`, `hollerName`, and `log` array.
- **`admin-routes.js`**: `handleMeshStatus` returns saved config (coordinator URL, holler name, auto-connect) even when disconnected. `handleMeshConnect` accepts `hollerName` and `autoConnect`. New `POST /mesh/cancel` route. New `POST /mesh/settings` route for saving config without connect/disconnect.
- **`api-gateway.js`**: New env vars `JIMBOMESH_COORDINATOR_URL` (alias, takes precedence over `JIMBOMESH_MESH_URL`), `JIMBOMESH_HOLLER_NAME`, `JIMBOMESH_AUTO_CONNECT` (default true). Auto-connect respects `JIMBOMESH_AUTO_CONNECT=false`.
- **Admin UI**: Complete rewrite of `renderMeshCard()` — unified card with 5 connection states, terminal-style scrollable log (`mesh-log` CSS), state-aware action buttons (Connect/Cancel/Disconnect/Retry/Dismiss), portal signup banner, config fields (Coordinator URL, API Key, Holler Name, Auto-Connect toggle). Smart 5s polling with incremental log/heartbeat updates.
- **CSS**: New `.mesh-log`, `.mesh-state-dot`, `.mesh-portal-banner`, `.mesh-actions`, `.mesh-toggle` styles
- **i18n**: 16 new `mesh.*` keys in all three locales (statusReconnecting, statusDisconnected, coordinatorUrl, hollerName, hollerNamePlaceholder, autoConnect, cancel, retry, dismiss, viewDashboard, portalTitle, portalText, portalLink, cancelSuccess, logEmpty)
- **Env vars**: `JIMBOMESH_COORDINATOR_URL`, `JIMBOMESH_HOLLER_NAME`, `JIMBOMESH_AUTO_CONNECT` in `.env.example` and `docker-compose.yml`

### WebRTC Peer-to-Peer Connections
- **`mesh-webrtc.js`**: New file — WebRTC peer handler for direct Holler ↔ Buyer inference streaming
  - `HollerPeerHandler`: Manages active peer connections, enforces `MAX_PEER_CONNECTIONS` (default 10), lazy-loads `wrtc` native module
  - `PeerSession`: Per-job WebRTC lifecycle — signaling via Node.js 22 native WebSocket, SDP/ICE negotiation, streaming inference over `RTCDataChannel`, usage reporting to SaaS
  - State machine: `signaling → connected → streaming → complete → closed`
  - Inference content flows P2P — SaaS only handles signaling metadata and billing
- **`mesh-connector.js` integration**: After registration, initializes `peerHandler` via lazy `require('./mesh-webrtc')`. Jobs with `signaling_url` + `ice_servers` route to WebRTC; others fall back to HTTP polling. `getStatus()` includes `peerConnections`. Graceful shutdown closes all peer sessions
- **`GET /admin/api/mesh/peers`**: New endpoint in `admin-routes.js` returning active peer connection details
- **Admin UI**: Mesh card shows "Connection Mode" badge (WebRTC P2P / HTTP Polling) and active peer connections table (job ID, model, state, duration) when peers are active. Auto-refreshes every 10s
- **Schema migration v3→v4**: `ALTER TABLE request_stats ADD COLUMN connection_type TEXT` — tracks `'webrtc'`, `'http'`, or `NULL` (legacy)
- **`stats-collector.js`**: `startRequest()` now includes `connectionType` field; `recordRequest()` writes `connection_type` to SQLite
- **Optional dependency**: `wrtc` ^0.4.7 (Node.js native WebRTC — RTCPeerConnection, RTCDataChannel)
- **Env var**: `MAX_PEER_CONNECTIONS` (default 10) — max concurrent WebRTC peer connections per Holler. Set to 0 to disable WebRTC
- **i18n**: New `mesh.connectionMode`, `mesh.modeWebrtc`, `mesh.modePolling`, `mesh.peerConnections`, `mesh.peerJob`, `mesh.peerModel`, `mesh.peerState`, `mesh.peerDuration`, `mesh.noPeers` keys in all three locales
- **Docker**: `mesh-webrtc.js` COPY in Dockerfile; `MAX_PEER_CONNECTIONS` in docker-compose.yml; documented in `.env.example`

### Recent Changes (2026-02-27)

### GPU Detection and Admin Display
- **`GET /admin/api/gpu-info`**: New endpoint in `admin-routes.js`; detects NVIDIA (via `nvidia-smi`) and Apple Metal (via `OLLAMA_EXTERNAL_URL` / Darwin), queries Ollama `/api/ps` for offload %, 30s cache
- **`detectConfiguredMode()`**: Returns `'metal'` (OLLAMA_EXTERNAL_URL set), `'nvidia'` (COMPOSE_FILE includes gpu.yml), `'metal-native'` (macOS without overlay), or `'cpu'`
- **`detectNvidiaGpu()`**: Runs `nvidia-smi` query for GPU name, total/used/free VRAM
- **`detectGpuInfo(ollamaUrl)`**: Main async function; assembles full GPU info response
- **Marketplace tab**: VRAM bar (color-coded: green < 60%, yellow 60–85%, red > 85%) and model fit badges per card
- **`admin/app.js`**: `gpuInfo` state, `renderVramBar()`, `getAvailableVramGb()`, `fitBadge()` functions
- **`.setup-config.json`**: Written by `setup.sh` — persists `ollamaMode`, `installedAt`, `securityWarningAccepted`, `platform`, `arch`
- **`docker-compose.mac.yml`**: Now committed to repo (previously described as generated-only)
- **i18n**: New `marketplace.*` keys in all three locales (`vramGpu`, `vramMetal`, `vramMetalIdle`, `vramCpuOnly`, `gpuDetected`, `metalDetected`, `cpuOnly`, `willFit`, `willFitTight`, `wontFit`)
- **bash 3.2 fix**: `setup.sh` replaced `${var^^}` uppercase operator with `$(echo "$var" | tr '[:lower:]' '[:upper:]')` for macOS compatibility

### Document RAG Pipeline
- **Documents tab**: New admin panel tab with Upload, Browse, and Ask sub-tabs
- **File upload**: Drag-and-drop upload with SSE progress for .pdf, .md, .txt, .csv, .docx files
- **Text extraction**: PDF via `pdfjs-dist`, DOCX via `mammoth`, CSV/MD/TXT via `fs.readFileSync`
- **Smart chunking**: Paragraph-boundary splitting (~500 tokens target, 50-token overlap, ~4 chars/token)
- **Embedding**: Batch embedding via Ollama `/api/embed` (batches of 10) with progress tracking
- **Vector storage**: Qdrant upsert with document metadata (filename, chunk index, char offset)
- **Semantic search**: `POST /admin/api/documents/query` — embed query → Qdrant search → ranked results
- **RAG Q&A**: `POST /admin/api/documents/ask` — search → `<retrieved_context>` XML context → streaming Ollama chat with source citations
- **Browse**: Document table with View Chunks modal, Reindex, Delete actions
- **Collection management**: `GET/POST/DELETE /admin/api/collections` — list, create, delete Qdrant collections
- **File dedup**: SHA-256 content hashing prevents re-ingestion of identical files
- **Prerequisite checks**: Documents tab warns if no embedding model found or Qdrant unreachable
- **New files**: `qdrant-client.js` (Qdrant HTTP client), `document-pipeline.js` (processing engine)
- **New deps**: `busboy` (multipart upload), `pdfjs-dist` (PDF extraction), `mammoth` (DOCX extraction)
- **SQLite**: New `documents` table with status tracking (pending → processing → ready/error)
- **11 new endpoints**: upload, list, get, chunks, delete, reindex, query, ask, collections CRUD
- **i18n**: Full `documents.*` namespace (~55 keys) in all three locales

### Activity Log Management
- **Clear log**: New "Clear Log" button in Activity tab with confirmation dialog
- **Manual refresh**: New "Refresh" button in Activity tab to fetch latest entries immediately
- **Backend**: `DELETE /admin/api/activity` clears all request log entries
- **i18n**: `activity.refresh/clearLog/clearing/clearConfirmTitle/clearConfirmMessage/clearSuccess/clearError` in all locales

### Admin UI: GitHub Feedback Integration
- **Feedback tab**: New tab in Admin UI with Bug Report and Feature Request sub-tabs
- **Bug Report form**: Title, description, steps to reproduce, expected/actual behavior — creates GitHub issue with `[Bug]` prefix and `bug` label
- **Feature Request form**: Title, description, use case — creates GitHub issue with `[Feature]` prefix and `enhancement` label
- **GitHub API**: `POST /admin/api/github/issue` creates issues on `IngressTechnology/jimbomesh-holler-server` via GitHub REST API
- **Configuration**: Requires `GITHUB_TOKEN` env var (PAT with `repo` or `public_repo` scope). Tab shows "not configured" message if missing
- **Status endpoint**: `GET /admin/api/github/status` returns `{ configured: true/false }`
- **i18n**: Full `feedback.*` strings in all three locales (en, hillbilly, es)

### One-Command Install & .env-Ready Key Copy
- **Quick Start one-liners**: `QUICK_START.md` and `README.md` now lead with single-command install per OS (git clone + run, curl/tar, wget/tar, PowerShell `irm`/`Expand-Archive`)
- **Installer flags table**: All flags (`--gpu`, `--qdrant`, `--no-start`, `--pull-only`) documented with both bash/PowerShell syntax
- **Always generate Qdrant key**: Both installers now generate `QDRANT_API_KEY` unconditionally (not just when `--qdrant` is passed), so it's ready if Qdrant is enabled later
- **Key banner shows both keys**: Installer output now displays `JIMBOMESH_HOLLER_API_KEY=<key>` and `QDRANT_API_KEY=<key>` in paste-ready format
- **Admin copy prepends env name**: Copying API key from Admin UI now copies `JIMBOMESH_HOLLER_API_KEY=<key>` (not just the raw key), ready to paste into `.env`
- **Qdrant key management in Admin UI**: When `QDRANT_API_KEY` is configured, Security section shows masked key with copy button (copies `QDRANT_API_KEY=<key>`)
- **Backend**: New `GET /admin/api/qdrantkey` endpoint returns masked + full Qdrant key
- **docker-compose.yml**: Added `QDRANT_API_KEY` passthrough to `jimbomesh-still` service (was missing — Admin UI couldn't report key status)
- **i18n**: New `qdrantKey.*` locale strings in all three locales; updated `apiKey.copyTooltip` to mention .env format

### Admin UI: API Key Management
- **View masked key**: Configuration > Security shows the current API key masked (first 4 + last 4 chars visible)
- **Copy to clipboard**: One-click copy of the current session key
- **Regenerate key**: Generates new 64-char hex key via `crypto.randomBytes(32)`, requires typing "hellyeah" to confirm
- **Runtime rotation**: New key takes effect immediately — saved to SQLite (`api_key_override` setting), session auto-updated
- **New key dialog**: After regeneration, shows the full key with copy button and reminder to update `.env`
- **Backend**: `GET /admin/api/apikey` (masked), `POST /admin/api/apikey/regenerate` (requires `{ confirm: "hellyeah" }`)
- **i18n**: Full `apiKey.*` strings in all three locales (en, hillbilly, es)

### Auto-Login URL
- **Hash-based login**: Admin UI reads `#key=` from URL hash, auto-logs in, strips hash from URL bar
- **Installers print connect URL**: Both installers read API key from `.env` and show `http://localhost:1920/admin#key=<KEY>`
- **Safe**: Hash fragments never leave the browser (not sent as HTTP requests)

### Interactive Installer Prompts
- **GPU/mode prompt**: Linux/Windows: Detects NVIDIA GPU via `nvidia-smi`; defaults to GPU if found, CPU if not. macOS: Shows `[P]` Performance Mode (native Ollama + Metal GPU) or `[S]` Secure Mode (Docker CPU) prompt
- **Qdrant prompt**: Asks user if they want Qdrant vector DB; defaults to Yes
- **Auto-generated keys**: Both `JIMBOMESH_HOLLER_API_KEY` and `QDRANT_API_KEY` generated automatically on first install
- **Existing install detection**: If container/image/.env already exists, shows interactive menu:
  - 1) Update (rebuild + restart, preserves models)
  - 2) Restart (no rebuild)
  - 3) Fresh install
  - 4) Stop
  - 5) Cancel
- **New flags**: `-CpuOnly` / `--cpu` to skip GPU prompt

### Installer Fixes
- **401 flood fix**: Installer wait loops now poll `http://localhost:9090/healthz` (no auth) instead of `http://localhost:1920/api/tags` (auth required)
- **PowerShell banner fix**: Replaced bash-syntax `fprint_banner()` with proper PowerShell `Write-Banner` function

### Environment Variable Rename & Developer Tooling
- **HOLLER_MODELS rename**: Renamed `OLLAMA_MODELS` to `HOLLER_MODELS` across all code, config, and docs — fixes naming collision with Ollama's native `OLLAMA_MODELS` env var (model storage directory path). Host-level `OLLAMA_MODELS` was leaking into the container and being treated as a model name to pull.
- **Deploy Code launch config**: New "Docker: Deploy Code" VS Code run configuration — rebuilds only the `jimbomesh-still` image and force-recreates the container without touching volumes or dependencies. Fastest iteration path for code changes.
- **CURSOR_VS_CODE.md**: New developer guide documenting all IDE run configurations, tasks, Cursor AI rules, endpoints, terminal commands, volume persistence, and file-edit-to-container-action map.

### Recent Changes (2026-02-26)

### Admin UI Internationalization (i18n)
- **Language system**: `admin/i18n.js` runtime with `t(key, params)` lookup, `{placeholder}` interpolation, dot-separated key paths
- **Three locales**: `admin/locales/en.json` (English), `hillbilly.json` (moonshine-themed), `es.json` (Spanish)
- **Language selector**: Custom dropdown in header toolbar (before Sign Out) and login page corner, with inline SVG flags (US, Spain) and 🤠 emoji for Hillbilly
- **Persistence**: Selection saved to `localStorage` key `holler-lang`, defaults to `en`
- **Reactive**: Changing language instantly updates all rendered text without page reload
- **Full coverage**: Every user-facing string extracted — nav, buttons, labels, placeholders, status messages, dialogs, table headers, footer
- **Fallback chain**: Missing key in current locale falls back to English, then returns the key itself

### Recent Changes (2026-02-25)

### Docker Compose Refactor
- **Single service**: Merged `jimbomesh-still` (cpu) and `jimbomesh-still-gpu` into one service — no more `cpu`/`gpu` profiles
- **GPU overlay**: New `docker-compose.gpu.yml` loaded via `COMPOSE_FILE` env var in `.env`
- **Fixed**: `docker compose down` now always cleans up containers (previously failed when GPU profile wasn't specified)
- **Setup scripts**: `setup.sh` and `setup.ps1` write `COMPOSE_FILE` to `.env` when GPU is requested

### Admin UI Branding Kit
- **JimboMesh Theme**: Teal `#0d9488` accent, dark navy `#0f172a` backgrounds, updated login/header styling
- **Brand Assets**: `admin/assets/` directory with `logo.svg` (whiskey glass + HOLLER text), `favicon.svg` (icon), `theme.css` (user overrides)
- **Customization System**: CSS variables in `theme.css` override defaults; replace SVGs for logo; env vars `HOLLER_SERVER_NAME` and `HOLLER_ADMIN_TITLE` for text branding
- **Branding API**: `/admin/api/branding` (unauthenticated) returns server name and title for login page
- **Documentation**: `docs/CUSTOMIZATION.md` with full CSS variable reference, logo replacement, theme examples

### Production Hardening
- **Graceful Shutdown**: SIGTERM/SIGINT handling with configurable drain timeout (`SHUTDOWN_TIMEOUT_MS`), connection tracking, `/readyz` endpoint returns 503 during shutdown, `docker-entrypoint.sh` uses `exec` for node process
- **Persistent Rate Limiting**: SQLite-backed rate limits survive container restarts, in-memory cache for performance, `RATE_LIMIT_BURST` env var for burst allowance
- **Admin Role Separation**: New `ADMIN_API_KEY` env var for separate admin authentication, backward compatible
- **Request Validation**: Body size limits (`MAX_REQUEST_BODY_BYTES`), batch size limits (`MAX_BATCH_SIZE`), Ollama timeout (`OLLAMA_TIMEOUT_MS`), concurrency queue (`MAX_CONCURRENT_REQUESTS`, `MAX_QUEUE_SIZE`)
- **Structured Errors**: All error responses use `{ error: { code, message, type } }` format with `sendError()` helper, `Retry-After` headers on 429/503
- **Optional TLS**: `TLS_CERT_PATH` + `TLS_KEY_PATH` env vars for HTTPS mode, validation that both must be set

### SQLite Persistent Storage
- **db.js**: New SQLite wrapper using `sql.js` with explicit saves after mutations
- **package.json**: New file with `sql.js` dependency
- **Tables**: `request_log`, `settings`, `stats_hourly`, `schema_version`
- **holler_data volume**: `/opt/jimbomesh-still/data/holler.db`
- **Env vars**: `SQLITE_DB_PATH`, `LOG_RETENTION_DAYS`
- **Admin API**: New `/admin/api/settings` (GET/POST), `/admin/api/stats` (GET)
- **Activity pagination**: `/admin/api/activity?limit=N&offset=N`
- **Dashboard**: Persistent stats (today's count, embed/chat counts, errors, avg latency, DB size)
- **Configuration tab**: Editable runtime settings with save buttons
- **Background tasks**: Stats rollup every 5 min, log pruning every hour
- **Dockerfile**: Added build-essential, python3; runs npm install for native module

### Recent Changes (2026-02-23)

### Bug Fixes
- **Health handler**: Fixed health-handler.sh hitting gateway port 1920 (auth required) instead of internal Ollama port 11435
- **Init-qdrant**: Fixed exit code 22 — removed curl `-f` flag, handles 404/409 gracefully
- **Model defaults**: Fixed stale `llama3.2:3b` fallback in docker-entrypoint.sh and pull-models.sh

#### New Features
- **OpenAI-compatible `/v1/embeddings`**: Drop-in endpoint with batch support (array of inputs)
- **Node.js 22.x LTS**: Pinned via NodeSource in Dockerfile (was floating apt version)
- **Model benchmarks**: Benchmarking script and results guide
- **ARM support**: ARM64 deployment guide (Apple Silicon, Raspberry Pi, Graviton)
- **Multi-stage Dockerfile evaluation**: Documented in DOCKERBUILD.md (not adopted)

#### Removed
- **nginx.conf**: Dead code from before the Node.js API gateway

### Previous Changes (2026-02-22)
- **Admin UI**: Web-based admin panel at `/admin` on port 1920 (no new port/process)
- **API key auth**: Node.js gateway validates X-API-Key on all requests
- **Dual-backend embed.sh**: Supports both Ollama and OpenRouter backends
- **Docker fixes**: Absolute entrypoint path, CRLF→LF, sh→bash shebang
- **Model update**: llama3.1:8b (128K context, 4.9GB)

## Network Configuration

### Default Endpoints
- Holler Gateway: `http://localhost:1920`
- Admin UI: `http://localhost:1920/admin`
- Swagger UI: `http://localhost:1920/docs`
- Health API: `http://localhost:9090`
- Qdrant API: `http://localhost:6333` (when using --profile qdrant)

### Firewall Rules
Windows firewall must allow inbound connections on:
- Port 1920 (Holler Gateway)
- Port 9090 (Health checks)
- Port 6333 (Qdrant, if used)

### Qdrant API Key
- Stored in: `.env` (jimbomesh-holler-server)
- Generate with: `openssl rand -hex 32`
- Never commit to git

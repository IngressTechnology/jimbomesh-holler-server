# JimboMesh Holler Server

On-prem embedding and LLM inference server for [JimboMesh](https://github.com/IngressTechnology/JimboMesh). Replaces cloud-based embedding calls (OpenRouter/OpenAI) with a local Ollama instance, keeping all data on-premises.

## What This Does

JimboMesh currently uses OpenRouter's `text-embedding-3-small` (1536d) for all embedding operations. This project provides a local Ollama server running `nomic-embed-text` (768d) as a drop-in replacement, eliminating the need for cloud API calls during ingestion.

```
Before:  ingest-*.js → embed.sh → OpenRouter API → Qdrant
After:   ingest-*.js → embed.sh → Ollama (local) → Qdrant
```

## Quick Start

The built-in setup scripts are the fastest way to get running — they handle
prerequisites, `.env` creation, API key generation, image build, startup, and
persist your setup selections to `.env` for seamless reinstalls/rebuilds.

### Linux / macOS (one command)

```bash
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git && cd jimbomesh-holler-server && ./setup.sh
```

### Windows PowerShell (one command)

```powershell
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git; cd jimbomesh-holler-server; .\setup.ps1
```

> **Windows Users:** Requires PowerShell 7+. Install with `winget install Microsoft.PowerShell`, then run `pwsh .\setup.ps1` (not `powershell`).

### No git? No problem.

**Linux / macOS — curl:**

```bash
curl -fsSL https://github.com/IngressTechnology/jimbomesh-holler-server/archive/refs/heads/main.tar.gz | tar xz && cd jimbomesh-holler-server-main && ./setup.sh
```

**Linux / macOS — wget:**

```bash
wget -qO- https://github.com/IngressTechnology/jimbomesh-holler-server/archive/refs/heads/main.tar.gz | tar xz && cd jimbomesh-holler-server-main && ./setup.sh
```

**Windows — PowerShell (no git):**

```powershell
irm https://github.com/IngressTechnology/jimbomesh-holler-server/archive/refs/heads/main.zip -OutFile holler.zip; Expand-Archive holler.zip .; cd jimbomesh-holler-server-main; .\setup.ps1
```

> **Windows Users:** Requires PowerShell 7+. Install with `winget install Microsoft.PowerShell`, then run `pwsh .\setup.ps1` (not `powershell`).

Add `--gpu` / `-WithGpu` for NVIDIA GPU support, `--qdrant` / `-WithQdrant` for a local vector DB.
See the [Quick Start Guide](QUICK_START.md) for all flags and the manual install path.

## Documentation by Audience

Start with the section that matches your role:

- **Users**: [QUICK_START.md](QUICK_START.md), [docs/API_USAGE.md](docs/API_USAGE.md), [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md), [docs/INTEGRATION.md](docs/INTEGRATION.md)
- **Admins / Operators**: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/SECURITY.md](docs/SECURITY.md), [docs/MAC_WINDOWS_SETUP.md](docs/MAC_WINDOWS_SETUP.md)
- **Contributors / Developers**: [CONTRIBUTING.md](CONTRIBUTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CURSOR_VS_CODE.md](docs/CURSOR_VS_CODE.md), [docs/DOCKERBUILD.md](docs/DOCKERBUILD.md)

## Testing

The test suite has three layers:

| Layer | Command | Runner | Notes |
|------|---------|--------|-------|
| Unit | `npm test` | Node.js built-in test runner | Fast logic tests in `test/*.test.js` |
| API | `npm run test:api` | Playwright APIRequestContext | Runs specs in `test/api/*.spec.js` against `http://localhost:1920` |
| UI | `npm run test:ui` | Playwright browser automation | Runs specs in `test/ui/*.spec.js` against `/admin` |

Prerequisites for API/UI tests:

- Start the server first (`npm start` or Docker stack).
- Ensure `.env` has a valid auth key (`ADMIN_TOKEN`, `ADMIN_API_KEY`, or `JIMBOMESH_HOLLER_API_KEY`).
- Keep Ollama reachable (`OLLAMA_HOST`, default `http://localhost:11434`) for inference-dependent tests.

### Manual

```bash
cp .env.example .env
# Edit .env — REQUIRED: set JIMBOMESH_HOLLER_API_KEY (generate with: openssl rand -hex 32)
# Optional: set QDRANT_API_KEY if using --profile qdrant
docker compose build jimbomesh-still
docker compose up -d
```

First startup pulls the configured models (~2-5 minutes depending on network speed).

## Naming Convention

This project uses a hierarchical naming scheme:

- **Repository**: `jimbomesh-holler-server` — The overall project
- **Compose Project**: `jimbomesh-holler` — Docker Compose namespace
- **Service**: `jimbomesh-still` — The main Ollama service
- **Image**: `jimbomesh-still:latest` — Docker image

See [NAMING.md](NAMING.md) for details on why this structure supports multiple service variants.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                   Docker Network                       │
│                                                        │
│  ┌─────────────────────┐   ┌─────────────────────┐   │
│  │  jimbomesh-still     │   │  jimbomesh-qdrant   │   │
│  │                      │   │  (optional profile) │   │
│  │  ┌───────────────┐   │   │                     │   │
│  │  │ API Gateway   │   │   │  Qdrant v1.13.2     │   │
│  │  │ :1920 (ext)   │   │   │  :6333 REST         │   │
│  │  │ X-API-Key auth│   │   │  :6334 gRPC         │   │
│  │  │ /admin (UI)   │   │   │                     │   │
│  │  └───────┬───────┘   │   │                     │   │
│  │          ▼           │   │  Collections:       │   │
│  │  Ollama Server       │   │  - knowledge_base   │   │
│  │  :11435 (internal)   │   │  - memory           │   │
│  │  :9090 (health)      │   │  - client_research  │   │
│  │  Models:             │   │                     │   │
│  │  - nomic-embed-text  │   │                     │   │
│  │  - llama3.1:8b       │   │                     │   │
│  │                      │   │                     │   │
│  │  SQLite (holler.db)  │   │                     │   │
│  │  /data/ volume       │   │                     │   │
│  └─────────────────────┘   └─────────────────────┘   │
└────────────────────────────────────────────────────────┘
```

## Port 1920

JimboMesh runs on port **1920** by default — the year Prohibition started and moonshine went underground.

| Service | URL |
|---------|-----|
| Holler Gateway | http://localhost:1920 |
| Admin UI | http://localhost:1920/admin |
| OpenAI-Compatible API | http://localhost:1920/v1 |
| Ollama (upstream) | http://localhost:11434 |

To use a custom port, set `GATEWAY_PORT` and `OLLAMA_HOST_PORT` in `.env`:

```bash
GATEWAY_PORT=8080
OLLAMA_HOST_PORT=8080
```

## Storage

All request logs, runtime settings, and aggregated statistics are stored in a SQLite database (`holler.db`) on a dedicated Docker volume (`holler_data`). Data persists across container restarts and rebuilds. Logs are automatically pruned after 30 days (configurable via `LOG_RETENTION_DAYS`).

## Deployment Modes

| Mode | How to Enable | Services |
|------|--------------|----------|
| CPU (default) | `docker compose up -d` | `jimbomesh-still` |
| NVIDIA GPU | Set `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env`, then `docker compose up -d` | `jimbomesh-still` (with GPU) |
| macOS Metal GPU | Run `./setup.sh`, select **[P] Performance Mode** | `jimbomesh-still` (gateway only; Ollama runs natively) |
| + Qdrant | Append `--profile qdrant` to any `docker compose up` | + `jimbomesh-qdrant` |

**NVIDIA GPU mode:** Add to `.env`: `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` (use `;` separator on Windows). Then all `docker compose` commands (up, down, restart) automatically include GPU support.

**macOS Performance Mode:** Docker cannot pass through Apple Metal GPU to containers. `setup.sh` detects macOS and offers a mode selection — Performance Mode installs Ollama natively via Homebrew (full Metal GPU), while Docker handles only the API gateway. See [docs/MAC_WINDOWS_SETUP.md](docs/MAC_WINDOWS_SETUP.md) for details.

## Models

| Model | Type | Dimensions | Size | Purpose |
|-------|------|-----------|------|---------|
| `nomic-embed-text` | Embedding | 768 | ~274 MB | Text embeddings for Qdrant |
| `llama3.1:8b` | LLM | — | ~4.9 GB | General-purpose inference (128K context) |

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#alternative-embedding-models) for alternative models.

## API

**Authentication Required:** All API requests must include the `X-API-Key` header.

OpenAPI schemas in this section:
- `GET /api/tags` → response `TagsResponse`
- `POST /api/embed` → request `OllamaEmbedRequest`, response `OllamaEmbedResponse`

```bash
# List models
curl -H "X-API-Key: your_api_key_here" \
  http://localhost:1920/api/tags

# Generate embeddings
curl -H "X-API-Key: your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{"model": "nomic-embed-text", "input": "Your text here"}' \
  http://localhost:1920/api/embed
```

### OpenAI-Compatible Endpoint

A drop-in `/v1/embeddings` endpoint that speaks the OpenAI format. Just change the base URL:

OpenAPI schemas: request `OpenAIEmbeddingsRequest`, response `OpenAIEmbeddingsResponse`.

```bash
curl -H "X-API-Key: your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{"model": "nomic-embed-text", "input": ["Hello world", "Another text"]}' \
  http://localhost:1920/v1/embeddings
```

Returns OpenAI-format response with `object`, `data[].embedding`, `model`, and `usage`. Supports batch (array of strings) natively.

**Authentication Errors:**
- `401 Unauthorized` — Missing API key
- `403 Forbidden` — Invalid API key
- `429 Too Many Requests` — Rate limit exceeded (60 req/min default)

### Health Endpoints (port 9090)

| Endpoint | Purpose | 200 when | 503 when |
|----------|---------|----------|----------|
| `/healthz` | Liveness probe | Ollama API responds | API unreachable |
| `/readyz` | Readiness probe | API up + model available | Any check fails |
| `/status` | Info/debug | API responds | API unreachable |

```bash
# Liveness check
curl -s http://localhost:9090/healthz | jq .

# Readiness check (used by Docker healthcheck)
curl -s http://localhost:9090/readyz | jq .

# Detailed status with model list
curl -s http://localhost:9090/status | jq .
```

## Admin UI

A built-in web admin panel is available at `/admin` on the API gateway port (default 1920). No additional ports or processes required.

**Quick connect** — use the auto-login URL printed by the installer:

```
http://localhost:1920/admin#key=YOUR_API_KEY
```

The `#key=` fragment logs you in automatically and is stripped from the URL bar
(hash fragments never leave the browser). Bookmark it for quick access, or
navigate to `http://localhost:1920/admin` and enter the key manually.

**Features:**

| Tab | Description |
|-----|-------------|
| Dashboard | Server health, Ollama latency, model count, uptime (auto-refresh 10s) |
| Models | List, pull (with streaming progress), delete, view details |
| Mesh | Connect/disconnect/cancel Mesh sessions, set coordinator URL and Holler name, view live Mesh connection log and mode |
| Playground | Test embeddings, chat (streaming), generate (streaming) |
| Configuration | Editable runtime settings, API key management (view masked, copy, regenerate) |
| Activity | Last 200 requests with method, path, status, IP, duration (auto-refresh 5s + manual Refresh button) |
| Documents | Upload files (.pdf, .md, .txt, .csv, .docx), browse/search documents, RAG Q&A with streaming answers |
| Feedback | Bug reports and feature requests — creates GitHub issues (requires `GITHUB_TOKEN`) |

**Authentication:** Enter `JIMBOMESH_HOLLER_API_KEY` (or `ADMIN_API_KEY` if set). Stored in `sessionStorage` (cleared on tab close).

**Disable:** Set `ADMIN_ENABLED=false` in `.env` to return 404 for all `/admin` routes.

### Optional Mesh Connectivity

When `JIMBOMESH_API_KEY` is set, this Holler can connect to the JimboMesh coordinator and contribute jobs.

- **Auth method**: Mesh requests always use `X-API-Key` with your configured `JIMBOMESH_API_KEY` (register, heartbeat, job polling, WebRTC signaling/usage)
- **No token swapping**: Registration response tokens are ignored; the original mesh API key remains the persistent credential
- **Key separation**: `JIMBOMESH_HOLLER_API_KEY` is local gateway/admin auth and is never replaced by mesh operations
- **Connection states**: `disconnected`, `connecting`, `connected`, `error`, `reconnecting`
- **WebRTC peer mode**: direct Holler <-> Buyer data channels when signaling info is available
- **Fallback mode**: HTTP polling for jobs when WebRTC is unavailable or disabled
- **Auto-connect control**: `JIMBOMESH_AUTO_CONNECT` (default `true`)
- **WebRTC capacity**: `MAX_PEER_CONNECTIONS` (default `10`, set `0` to force HTTP-only)

Key Mesh environment variables:

- `JIMBOMESH_COORDINATOR_URL` (preferred, takes precedence)
- `JIMBOMESH_MESH_URL` (legacy fallback)
- `JIMBOMESH_HOLLER_NAME` (defaults to `HOLLER_SERVER_NAME`)
- `JIMBOMESH_AUTO_CONNECT`
- `MAX_PEER_CONNECTIONS`

## IDE Integrations

Use your Holler as a local AI coding assistant in your favorite IDE — replace GitHub Copilot, Cursor Pro, and Cody with your own hardware.

| IDE | Setup Time |
|-----|-----------|
| [Cursor](docs/IDE_INTEGRATIONS.md#cursor) | 2 minutes |
| [VS Code + Continue](docs/IDE_INTEGRATIONS.md#vs-code--continue) | 3 minutes |
| [JetBrains](docs/IDE_INTEGRATIONS.md#jetbrains-ides) | 3 minutes |
| [Neovim](docs/IDE_INTEGRATIONS.md#neovim) | 5 minutes |
| [Zed](docs/IDE_INTEGRATIONS.md#zed) | 2 minutes |
| [Aider](docs/IDE_INTEGRATIONS.md#aider) | 1 minute |

**Full guide:** [docs/IDE_INTEGRATIONS.md](docs/IDE_INTEGRATIONS.md)

**Save $79-108/month** by replacing cloud AI subscriptions with your own hardware.

## OpenClaw Integration

Use your Holler as a local LLM backend for OpenClaw — zero cloud API costs, all data stays on your hardware.

OpenAPI schemas:
- `POST /v1/chat/completions` → request `OpenAIChatRequest`, response `OpenAIChatResponse` (or SSE stream)
- `POST /v1/embeddings` → request `OpenAIEmbeddingsRequest`, response `OpenAIEmbeddingsResponse`
- `GET /v1/models` → response `OpenAIModelListResponse`

```json
{
  "providers": {
    "holler": {
      "type": "openai",
      "baseUrl": "http://localhost:1920/v1",
      "apiKey": "your-holler-api-key"
    }
  }
}
```

**Supported endpoints:**
- `POST /v1/chat/completions` — Chat with streaming & non-streaming
- `POST /v1/embeddings` — Text embeddings (batch support)
- `GET /v1/models` — List available models

**Test your connection:**

```bash
./scripts/test-openclaw-connection.sh
```

See [docs/OPENCLAW_INTEGRATION.md](docs/OPENCLAW_INTEGRATION.md) for the full setup guide.

## Security

### API Key Authentication

The Ollama server requires API key authentication for all requests:

- **Admin UI** — Web panel at `/admin` behind API key auth; static assets served without auth (contain no secrets)
- **API Gateway** — Node.js proxy validates `X-API-Key` header on all requests
- **Rate Limiting** — 60 requests/minute per IP address (configurable)
- **Internal Isolation** — Ollama runs on localhost:11435, only accessible via the gateway
- **External Access** — API gateway on 0.0.0.0:1920 validates all incoming requests

Generate an API key:

```bash
openssl rand -hex 32
```

Set in `.env`:

```bash
JIMBOMESH_HOLLER_API_KEY=your_generated_key_here
```

### Health Endpoints

Health endpoints on port `9090` (`/healthz`, `/readyz`, `/status`) bypass authentication for monitoring. The gateway-level `/health` endpoint on port `1920` also bypasses auth. All inference and admin API endpoints require authentication.

## Documentation

| Audience | Document | Description |
|----------|----------|-------------|
| Users | [QUICK_START.md](QUICK_START.md) | Fast install and first-run walkthrough |
| Users | [docs/API_USAGE.md](docs/API_USAGE.md) | curl/Postman examples for all core endpoints |
| Users | [docs/INTEGRATION.md](docs/INTEGRATION.md) | JimboMesh integration and dimension migration |
| Users | [docs/IDE_INTEGRATIONS.md](docs/IDE_INTEGRATIONS.md) | Cursor, VS Code, JetBrains, Neovim, Zed, Aider |
| Admins | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Installation, operations, backup, updates |
| Admins | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Environment variables and runtime configuration |
| Admins | [docs/SECURITY.md](docs/SECURITY.md) | Security model and hardening guidance |
| Admins | [docs/MAC_WINDOWS_SETUP.md](docs/MAC_WINDOWS_SETUP.md) | macOS performance mode and cross-machine setup |
| Contributors | [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution workflow and quality expectations |
| Contributors | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flow, and trust boundaries |
| Contributors | [docs/CURSOR_VS_CODE.md](docs/CURSOR_VS_CODE.md) | Dev workflow in Cursor/VS Code |
| Contributors | [docs/DOCKERBUILD.md](docs/DOCKERBUILD.md) | Docker build pipeline and rebuild strategy |
| Reference | [openapi.yaml](openapi.yaml) | OpenAPI 3.0 spec served at `/docs` |
| Reference | [docs/OPENCLAW_INTEGRATION.md](docs/OPENCLAW_INTEGRATION.md) | OpenClaw provider setup |
| Reference | [docs/MODEL_BENCHMARKS.md](docs/MODEL_BENCHMARKS.md) | Embedding model comparison and benchmark script |
| Reference | [docs/ARM_SUPPORT.md](docs/ARM_SUPPORT.md) | ARM64 deployment notes |
| Reference | [UNINSTALL-OLLAMA.md](UNINSTALL-OLLAMA.md) | Uninstall native Ollama after macOS Performance Mode |

## License

See [LICENSE](LICENSE).

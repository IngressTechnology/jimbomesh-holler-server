# Quick Start Guide

Get a JimboMesh Holler Server running on your machine in under 10 minutes.
This guide walks through three steps: installing the **holler** (the server project),
starting a **still** (the Ollama inference service), and configuring everything
through the built-in **Admin UI**.

## Fastest Path: One-Command Install

The built-in setup scripts are the fastest way to get running. They handle
prerequisite checks, `.env` creation, API key generation, Docker image build,
service startup, and persist your setup choices back into `.env` so reinstalls
are seamless.

### Linux / macOS

```bash
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git && cd jimbomesh-holler-server && ./setup.sh
```

If you see `zsh: permission denied: ./setup.sh`, make the script executable and run again:

```bash
chmod +x setup.sh
./setup.sh
```

Alternative (without changing file permissions):

```bash
bash setup.sh
```

### Windows (PowerShell)

```powershell
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git; cd jimbomesh-holler-server; .\setup.ps1
```

### One-liner variants (no git required)

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

### Installer flags

| Flag | `setup.sh` | `setup.ps1` | Effect |
|------|-----------|---------------|--------|
| GPU | `--gpu` | `-WithGpu` | Enable NVIDIA GPU passthrough (skip prompt) |
| CPU | `--cpu` | `-CpuOnly` | Force CPU mode (skip prompt) |
| Qdrant | `--qdrant` | `-WithQdrant` | Include local Qdrant vector DB |
| No start | `--no-start` | `-NoStart` | Set up everything but don't start services |
| Pull only | `--pull-only` | `-PullOnly` | Build the Holler image, skip startup |

Without flags, the installer prompts interactively for both GPU and Qdrant:

- **GPU** (Linux/Windows): defaults to **Yes** when NVIDIA GPU detected, **No** otherwise.
- **macOS**: instead of a GPU prompt, the installer shows a **mode selection**:
  - **[P] Performance Mode** — installs Ollama natively via Homebrew for full Apple Metal GPU acceleration. Docker runs only the API gateway. Best performance on Apple Silicon.
  - **[S] Secure Mode** — fully Docker-based, CPU-only. Same behavior as Linux without a GPU.
  - **[?]** — opens the security documentation in your browser.
  - Use `--cpu` to skip the prompt and select Secure Mode automatically.
  - See [Mac Setup Guide](docs/MAC_WINDOWS_SETUP.md) for the full explanation.
- **Qdrant**: defaults to **Yes** — includes a local vector database for RAG workflows

When Qdrant is enabled, the installer auto-generates a `QDRANT_API_KEY` in `.env`.

Append flags to any one-liner above, e.g.:

```bash
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git && cd jimbomesh-holler-server && ./setup.sh --gpu --qdrant
```

If you used any of the commands above, skip ahead to
[Verify the still is running](#verify-the-still-is-running) — the installer
builds and starts the service for you.

### Running the setup script again

The setup script detects an existing installation and presents a menu:

```
  Existing installation detected!

  Container: running
  Image:     jimbomesh-still:latest
  Config:    .env found

  What would you like to do?

  1) Update        — Rebuild image + restart (keeps models & data)
  2) Restart       — Just restart services (no rebuild)
  3) Reconfigure   — Re-run setup prompts + rebuild (preserves existing .env)
  4) Stop          — Shut down all services
  5) Quick Start   — Continue with guided setup flow
  6) Uninstall     — Remove containers/images/volumes and config
  7) Nuclear       — Wipe everything and start fresh (keeps Ollama models)
  8) Cancel        — Exit without changes
```

**Models are never re-downloaded.** They live on a persistent Docker volume
(`ollama_models`) that survives rebuilds. The entrypoint checks each model
with `ollama list` and skips any that are already present.

---

## Prerequisites (manual install only)

If you prefer to set things up manually instead of using the setup scripts,
you will need:

- [Docker Desktop](https://docs.docker.com/desktop/) (includes Docker Engine + Docker Compose)
- [Git](https://git-scm.com/downloads)
- ~5 GB free disk space (Docker image + model weights)
- 8 GB+ RAM recommended
- (Optional) NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

---

## 1. Install the Holler (manual)

The **holler** is the server project -- it contains the Dockerfile, API gateway,
admin panel, and configuration for running one or more Ollama services (stills).

### Clone the repository

```bash
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git
cd jimbomesh-holler-server
```

### Generate an API key

Every request to the server requires an API key. Generate one now:

```bash
# Linux / macOS
openssl rand -hex 32
```

```powershell
# Windows PowerShell
-join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
```

Copy the output -- you will paste it in the next step.

### Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` in a text editor and replace the placeholder API key:

```
JIMBOMESH_HOLLER_API_KEY=<paste your generated key here>
```

Everything else has sensible defaults. Optionally, you can also set a separate
admin key so the admin panel uses a different credential than inference clients:

```
# Optional -- if not set, admin routes use JIMBOMESH_HOLLER_API_KEY
ADMIN_API_KEY=<paste a second generated key here>
```

---

## 2. Install a still

A **still** is an instance of the Ollama inference service, packaged with the
Node.js API gateway that provides authentication, rate limiting, and the admin UI.

### Build the Docker image

```bash
docker compose build jimbomesh-still
```

### Start the still

```bash
# CPU-only (default)
docker compose up -d
```

For NVIDIA GPU acceleration, add to `.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
```

Then start normally:

```bash
docker compose up -d
```

To also run a local Qdrant vector database:

```bash
docker compose --profile qdrant up -d
```

### What happens on first boot

The container follows this lifecycle:

1. Ollama starts on an internal port (11435, localhost only)
2. The entrypoint waits for Ollama to become ready
3. Models are pulled (default: `nomic-embed-text` ~274 MB + `llama3.2:1b` ~1.3 GB)
4. The Node.js API gateway starts on port 1920 with authentication enabled

First startup takes 2-10 minutes depending on your network speed while models
download. **Subsequent rebuilds skip model downloads** — models live on a
persistent Docker volume, so the entrypoint detects them as "already present"
and moves straight to starting the gateway. Watch progress with:

```bash
docker logs -f jimbomesh-still
```

You will see output like:

```
[jimbomesh-still] starting container...
[jimbomesh-still] waiting for Ollama API on :11435...
[jimbomesh-still] Ollama API ready on :11435 (waited 8s)
[jimbomesh-still] pulling nomic-embed-text...
[jimbomesh-still] nomic-embed-text — done
[jimbomesh-still] pulling llama3.2:1b...
[jimbomesh-still] llama3.2:1b — done
[jimbomesh-still] all models ready — starting API gateway on :1920 (auth)
[api-gateway] Listening on 0.0.0.0:1920 (HTTP)
```

### Verify the still is running

```bash
# Health check (no auth required)
curl http://localhost:9090/healthz

# List models (auth required -- replace with your key)
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/api/tags

# Test an embedding
curl -H "X-API-Key: YOUR_KEY" \
  -X POST http://localhost:1920/api/embed \
  -H "Content-Type: application/json" \
  -d '{"model":"nomic-embed-text","input":"Hello, world!"}'
```

The embedding response contains an `embeddings` array with a 768-dimensional vector.

---

## 3. Connect to the Admin UI

The still includes a built-in web admin panel -- no extra ports or processes needed.

### Quick connect (auto-login URL)

The installer prints a ready-to-click URL at the end. Copy-paste it into your
browser and you are logged in immediately:

```
http://localhost:1920/admin#key=YOUR_API_KEY
```

Replace `YOUR_API_KEY` with the actual key from your `.env` file. The installer
prints this URL using your configured gateway port (`GATEWAY_PORT`, default `1920`).
The `#key=`
hash is read once, used to log in, then stripped from the URL bar — it is never
sent to the server as part of an HTTP request (hash fragments stay client-side).

You can bookmark this URL for quick access.

### Manual login

Navigate to **http://localhost:1920/admin** in your browser and enter your API
key in the login prompt:

- If you set `ADMIN_API_KEY` in `.env`, use that key.
- Otherwise, use `JIMBOMESH_HOLLER_API_KEY` (the same key used for inference).

The key is stored in `sessionStorage` and cleared when you close the tab.

### Finding your API key

If you used the setup script, the key was printed at the end. You can also read it
from your `.env` file:

```bash
# Linux / macOS
grep JIMBOMESH_HOLLER_API_KEY .env
```

```powershell
# Windows PowerShell
Select-String JIMBOMESH_HOLLER_API_KEY .env
```

### Dashboard

The dashboard is the landing page after login. It shows at a glance:

| Metric | Description |
|--------|-------------|
| Healthy | Whether Ollama is reachable |
| Ollama Latency | Round-trip time to the backend |
| Model Count | Number of installed models |
| Running Models | Models currently loaded in memory |
| Uptime | How long the gateway has been running |
| Recent Requests | Count from the activity buffer |

The dashboard auto-refreshes every 10 seconds.

### Models

The Models tab lets you manage Ollama models without the command line:

- **Installed models** -- name, size, parameter count, quantization
- **Pull a model** -- enter a model name (e.g. `mxbai-embed-large`) and watch
  the SSE progress stream as it downloads
- **Delete a model** -- remove models you no longer need to free disk space
- **Show details** -- view the full model card (template, parameters, license)

### Marketplace

Browse models curated for local deployment and see which ones fit your hardware:

- **VRAM bar** (top of tab) — shows current GPU or memory usage at a glance:
  - NVIDIA GPU: used vs total VRAM (green < 60%, yellow 60–85%, red > 85%)
  - Apple Silicon (Performance Mode): GPU offload % + unified memory total — no discrete VRAM ceiling
  - CPU-only: system RAM indicator
- **Model cards** — each shows size, parameter count, use case, and a **fit badge**:
  - **Will fit** — model size is well within available VRAM or RAM
  - **Tight fit** — model will fit but leaves little headroom
  - **Won't fit** — model exceeds available VRAM or RAM; may crash or run slowly on CPU

Click **Pull** on any model card to download it; the progress stream appears live.

GPU detection runs automatically when you open the Marketplace tab. On macOS
Performance Mode the display shows Apple Metal stats; on NVIDIA systems it reads
`nvidia-smi`; on CPU-only deployments it shows system RAM.

### Playground

Test your models interactively:

- **Embeddings** -- paste text, select a model, and generate embeddings.
  Shows the vector dimensions and latency.
- **Chat** -- send messages to an LLM model with streaming responses.
- **Generate** -- raw text completion with streaming.

This is the fastest way to verify a new model works after pulling it.

### Configuration

All server settings grouped by category, editable in-place:

- **Branding** -- server name
- **Server** -- ports, rate limits, shutdown timeout
- **Request Limits** -- body size, batch size, Ollama timeout, concurrency, queue size
- **Ollama** -- models, embed model, dimensions, parallelism, keep-alive
- **Health** -- port, warmup checks
- **Data** -- log retention
- **Security** -- masked API key display, copy/regenerate actions, Qdrant key visibility, Enhanced Security toggle, bearer token management, and Tier 3 auth status
- **Utilities** -- Restart Holler and Restart Ollama buttons when supported by the current deployment mode

Changes to non-port settings take effect within seconds. Port and startup
changes require a container restart. Values are persisted in SQLite and
survive restarts.

### Activity

A live feed of the last 200 API requests showing:

- Timestamp, HTTP method, path, status code, client IP, duration (ms)

Auto-refreshes every 5 seconds. Use the **Refresh** button to pull updates
immediately without waiting for the next auto-refresh. Use **Clear Log** to wipe
the activity table after confirmation. Useful for debugging client integrations
and spotting rate-limited or failed requests.

### Documents

Upload and query documents with AI-powered search and Q&A. Requires Qdrant
(`--profile qdrant`) and an embedding model (e.g., `nomic-embed-text`).

- **Upload** -- drag and drop files (.pdf, .md, .txt, .csv, .docx) into the
  upload zone. Files are automatically parsed, chunked, embedded, and stored
  in Qdrant. SSE progress shows each phase in real time.
- **Browse** -- view uploaded documents with chunk counts and status. Click
  "View Chunks" to inspect individual text chunks. Delete or reindex documents.
- **Ask** -- type a question and get a streaming AI answer grounded in your
  documents, with source citations showing which chunks were used.

Use the collection dropdown to organize documents into separate Qdrant
collections, or create new collections on the fly.

### Feedback

Report bugs and request features directly from the Admin UI. Each submission
creates a GitHub issue on the project repository.

- **Bug Report** -- title, description, steps to reproduce, expected/actual behavior
- **Feature Request** -- title, description, use case

Requires the `GITHUB_TOKEN` environment variable (a GitHub Personal Access Token
with `public_repo` scope). If not configured, the tab shows a setup message.

### Mesh (optional)

Connect this Holler to the JimboMesh coordinator if you want to contribute jobs.
Leave Mesh settings unset for standalone off-grid mode.

- Set `JIMBOMESH_API_KEY` in `.env`
- Optional: set `JIMBOMESH_COORDINATOR_URL` (preferred over `JIMBOMESH_MESH_URL`)
- Optional: set `JIMBOMESH_HOLLER_NAME` for display (defaults to `HOLLER_SERVER_NAME`)
- Optional: set `JIMBOMESH_AUTO_CONNECT=false` to require manual connect in Admin UI
- Optional: set `MAX_PEER_CONNECTIONS=0` to disable WebRTC and force HTTP polling

After updating `.env`, restart:

```bash
docker compose restart jimbomesh-still
```

After the first successful connection, the Mesh tab can reuse the stored key for
one-click **Connect**, **Reconnect**, **Cancel**, and **Forget Key** actions.

---

## Quick Reference

### Ports

| Port | Service | Auth Required |
|------|---------|---------------|
| 1920 | API gateway (Ollama API + Admin UI) | Yes (`X-API-Key` header) |
| 9090 | Health server (`/healthz`, `/readyz`, `/status`) | No |
| 6333 | Qdrant REST API (if `--profile qdrant`) | Yes (`api-key` header) |

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/admin` | Admin UI (web panel) |
| `/health` | Gateway liveness probe (port `1920`) |
| `/readyz` | Gateway readiness probe (port `1920`, `503` during shutdown) |
| `http://localhost:9090/healthz` | Container health-server liveness probe |
| `http://localhost:9090/status` | Container health-server status details |
| `/api/tags` | List installed models |
| `/api/embed` | Generate embeddings (Ollama format) |
| `/v1/embeddings` | Generate embeddings (OpenAI-compatible, batch support) |
| `/v1/models` | List models (OpenAI-compatible) |
| `/v1/chat/completions` | Chat completions (OpenAI-compatible, streaming/non-streaming) |
| `/v1/documents/search` | Public semantic search over indexed documents |
| `/v1/documents/ask` | Public RAG Q&A over indexed documents |
| `/api/generate` | LLM text completion |
| `/api/chat` | LLM chat completion |
| `/admin/api/documents/*` | Document upload, browse, search, RAG Q&A |
| `/admin/api/collections` | Qdrant collection management |
| `/admin/api/mesh/status` | Mesh connection status and state |
| `/admin/api/mesh/latest-version` | Latest published mesh version (when connected) |
| `/admin/api/mesh/peers` | Active WebRTC peer sessions |

### Common Commands

```bash
# View logs
docker logs -f jimbomesh-still

# Stop all services (preserves models)
docker compose down

# Restart the still
docker compose restart jimbomesh-still

# Rebuild after code changes (does NOT re-download models)
docker compose up --build -d

# Pull a new model at runtime
docker exec jimbomesh-still ollama pull mxbai-embed-large

# Check which models are loaded in memory
docker exec jimbomesh-still ollama ps
```

---

## Next Steps

- [Configuration Reference](docs/CONFIGURATION.md) -- all environment variables
- [Deployment Guide](docs/DEPLOYMENT.md) -- advanced operations, backup, updating
- [Architecture](docs/ARCHITECTURE.md) -- system design, data flow, security model
- [Model Benchmarks](docs/MODEL_BENCHMARKS.md) -- embedding model comparison
- [Mac Setup Guide](docs/MAC_WINDOWS_SETUP.md) -- Metal GPU (Performance Mode), Secure Mode, Mac → Windows cross-machine setup
- [Troubleshooting](docs/TROUBLESHOOTING.md) -- common issues and solutions

## Need Help?

- Check [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for common issues
- View container logs: `docker logs jimbomesh-still`
- [File an issue on GitHub](https://github.com/IngressTechnology/jimbomesh-holler-server/issues)

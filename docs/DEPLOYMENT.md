# Deployment Guide

## Prerequisites

- [Docker Desktop](https://docs.docker.com/desktop/) (includes Docker Engine + Docker Compose)
- Git
- ~5 GB free disk space (Docker image + model weights)
- (Optional) NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

## Installation

### One-Command Install

**Linux / macOS:**

```bash
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git && cd jimbomesh-holler-server && ./setup.sh
```

**Windows (PowerShell):**

```powershell
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git; cd jimbomesh-holler-server; .\setup.ps1
```

### Without Git

**curl (Linux / macOS):**

```bash
curl -fsSL https://github.com/IngressTechnology/jimbomesh-holler-server/archive/refs/heads/main.tar.gz | tar xz && cd jimbomesh-holler-server-main && ./setup.sh
```

**PowerShell (Windows):**

```powershell
irm https://github.com/IngressTechnology/jimbomesh-holler-server/archive/refs/heads/main.zip -OutFile holler.zip; Expand-Archive holler.zip .; cd jimbomesh-holler-server-main; .\setup.ps1
```

### What the Installer Does

1. **Detects existing install** — If containers, images, or `.env` already exist, shows an interactive menu (see [Existing Installation](#existing-installation) below)
2. **Checks prerequisites** — Docker, Docker Compose, Docker running
3. **GPU / mode selection** — Linux/Windows: Detects NVIDIA GPU; defaults to GPU if found, CPU if not. macOS: Shows a **Performance Mode vs Secure Mode** prompt — [P] installs Ollama natively via Homebrew for full Apple Metal GPU, [S] uses Docker CPU-only. Use `--cpu` to skip the prompt and select Secure Mode automatically. See [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md)
4. **Qdrant prompt** — Asks if you want the Qdrant vector database (default: Yes). Skipped with `--qdrant` flag
5. **Creates/preserves `.env`** — Copies from `.env.example` only when missing; otherwise preserves your existing configuration
6. **Persists setup choices** — Writes selected mode, ports, model list, mesh auto-connect/name, and admin settings to `.env`
7. **Auto-generates server branding** — Sets `HOLLER_SERVER_NAME=Holler Server <hostname>` when missing/empty
8. **Builds the image** — `jimbomesh-still:latest` from the Dockerfile (~1-2 min)
9. **Starts Ollama** — Launches the container, pulls models on first run
10. **Waits for readiness** — Polls health endpoint until services are available
11. **Prints auto-login URL + config summary** — Shows clickable Admin URL and a saved `.env` summary

### Installer Options

| PowerShell | Bash | Description |
|-----------|------|-------------|
| `-WithGpu` | `--gpu` | Enable NVIDIA GPU passthrough (skip GPU prompt) |
| `-CpuOnly` | `--cpu` | Force CPU mode (skip GPU prompt) |
| `-WithQdrant` | `--qdrant` | Include local Qdrant vector database (skip Qdrant prompt) |
| `-NoStart` | `--no-start` | Don't start services after setup |
| `-PullOnly` | `--pull-only` | Build image only, skip startup |
| `-Help` | `--help` | Show help |

> **Tip:** Without flags, the installer asks interactively. Flags let you script unattended installs.

### Existing Installation

If the setup script detects a previous installation (existing container, Docker image, or `.env` file), it presents an interactive menu instead of starting a fresh install:

| Option | Action |
|--------|--------|
| **1) Update** | Rebuild image + restart container. Preserves model volumes — no re-download |
| **2) Restart** | Restart existing container without rebuilding |
| **3) Reconfigure** | Re-run setup prompts and rebuild while preserving existing `.env` values |
| **4) Stop** | Stop all running services |
| **5) Quick Start** | Continue with guided setup flow |
| **6) Uninstall** | Remove containers/images/volumes and config |
| **7) Nuclear** | Wipe everything and start fresh (keeps Ollama model cache) |
| **8) Cancel** | Exit without changes |

### Manual Installation

If you prefer to set up manually:

```bash
# Clone the repo
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git
cd jimbomesh-holler-server

# Copy .env.example and customize
cp .env.example .env
# Edit .env — set JIMBOMESH_HOLLER_API_KEY (required)
# QDRANT_API_KEY is pre-populated with a placeholder; generate a real one:
#   openssl rand -hex 32

# Build the image
docker compose build jimbomesh-still

# Start Ollama only (CPU)
docker compose up -d

# Start with GPU (add COMPOSE_FILE to .env first — see below)
docker compose up -d

# Start with local Qdrant
docker compose --profile qdrant up -d

# Start with GPU + Qdrant
docker compose --profile qdrant up -d
```

## First-Time Setup

### 1. Connect via Auto-Login URL

The installer prints a clickable auto-login URL at the end:

```
http://localhost:11434/admin#key=YOUR_API_KEY_HERE
```

Click or paste this URL to open the Admin UI and log in automatically. The API key in the URL hash (`#key=...`) is **client-side only** — it never leaves your browser.

> **Note:** Save your API key from the setup output. You'll need it for API access and to reconnect to the Admin UI.

### 2. Verify Ollama is Running

```bash
curl -H "X-API-Key: YOUR_KEY" http://localhost:11434/api/tags
```

You should see a JSON response listing the pulled models.

### 3. Open Admin UI (Manual)

If you don't have the auto-login URL, open `http://localhost:11434/admin` in your browser and enter your API key. The dashboard shows server health, latency, model count, and uptime at a glance.

> **Forgot your key?** Check your `.env` file for `JIMBOMESH_HOLLER_API_KEY`, or use the Admin UI > Configuration tab to regenerate one.

### 4. Test Embedding Generation

```bash
curl -H "X-API-Key: YOUR_KEY" \
  http://localhost:11434/api/embed -d '{
  "model": "nomic-embed-text",
  "input": "The quick brown fox jumps over the lazy dog"
}'
```

The response should contain an `embeddings` array with a 768-dimensional vector.

### 5. Verify Qdrant (if enabled)

```bash
# Health check
curl http://localhost:6333/healthz

# List collections
curl -H "api-key: YOUR_KEY" http://localhost:6333/collections
```

### 6. (Optional) Connect to JimboMesh Mesh

If you want this Holler to contribute jobs to the JimboMesh network, set `JIMBOMESH_API_KEY` in `.env` and optionally configure:

- `JIMBOMESH_COORDINATOR_URL` (preferred coordinator URL override)
- `JIMBOMESH_HOLLER_NAME` (friendly display name, defaults to `HOLLER_SERVER_NAME`)
- `JIMBOMESH_AUTO_CONNECT` (`true` by default)
- `MAX_PEER_CONNECTIONS` (default `10`, set `0` for HTTP-only)

Then restart:

```bash
docker compose restart jimbomesh-still
```

Or connect from Admin UI:

1. Open `http://localhost:11434/admin`
2. Go to the **Mesh** tab
3. Enter Mesh API key, coordinator URL, and Holler name
4. Click **Connect**

## Deployment Modes

### Mode 1: Ollama Only (default)

The simplest deployment. Provides an embedding API that JimboMesh's `embed.sh` can call.

```bash
docker compose up -d
```

Services started: `jimbomesh-still`

### Mode 2: Ollama + Qdrant

Standalone stack with its own Qdrant instance. Useful for development, testing, or running a separate embedding environment.

```bash
docker compose --profile qdrant up -d
```

Services started: `jimbomesh-still`, `jimbomesh-holler-qdrant`, `init-qdrant`

### Mode 3: GPU Acceleration

For NVIDIA GPU passthrough. Requires [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

Add to `.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
```

Then start normally:

```bash
docker compose up -d
```

### Mode 4: Full Stack (GPU + Qdrant)

Set `COMPOSE_FILE` in `.env` as above, then:

```bash
docker compose --profile qdrant up -d
```

### Mode 5: macOS Metal GPU (Performance Mode)

Runs Ollama natively on the host via Homebrew, with Docker handling only the API gateway and authentication. Gives full Apple Metal GPU acceleration on Apple Silicon Macs — Docker Desktop does not pass Metal GPU through to containers.

Run `./setup.sh` and select **[P] Performance Mode** when prompted. The installer:

1. Checks for Homebrew, installs if needed
2. Installs and starts native Ollama via `brew services`
3. Hardens Ollama with localhost-only binding and restricted model directory permissions
4. Generates `docker-compose.mac.yml` overlay (`OLLAMA_EXTERNAL_URL=http://host.docker.internal:11434`)
5. Writes `COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml` to `.env`
6. Pulls models through the native Ollama, then starts the Docker gateway

After setup, the standard `docker compose up -d` activates Performance Mode automatically (the `COMPOSE_FILE` in `.env` loads the overlay).

To add Qdrant:

```bash
docker compose --profile qdrant up -d
```

See [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md) for the full walkthrough, security details, and mode-switching instructions.

## Operations

### Starting and Stopping

```bash
# Start (CPU, Ollama only)
docker compose up -d

# Stop all services (preserves model volume)
docker compose down

# Stop AND delete model data (destructive!)
docker compose down -v

# Restart Ollama
docker compose restart jimbomesh-still

# Check service status
docker compose ps
```

### Rebuilding After Code Changes

```bash
docker compose up --build -d
```

This rebuilds the Docker image with your latest code but **does not re-download models**.
Models live on the `ollama_models` Docker volume, which persists across image rebuilds.
On startup, the entrypoint checks each model in `HOLLER_MODELS` — if it's already on the
volume it prints "already present" and skips the pull. A full model download only happens
when a model is genuinely missing from the volume (first run, or after `docker compose down -v`).

### Viewing Logs

```bash
# Follow Ollama logs
docker logs -f jimbomesh-still

# Last 50 lines
docker logs --tail 50 jimbomesh-still

# Follow Qdrant logs (if running)
docker logs -f jimbomesh-holler-qdrant

# Follow all services
docker compose logs -f
```

### Managing Models

Models can be managed via the **Admin UI** (`http://localhost:11434/admin` → Models tab) or via the command line.

**Secure Mode (Docker CPU) or NVIDIA GPU Mode** — Ollama runs inside the container:

```bash
# List installed models
docker exec jimbomesh-still ollama list

# Pull a new model
docker exec jimbomesh-still ollama pull mxbai-embed-large

# Remove a model
docker exec jimbomesh-still ollama rm <model-name>

# Show model details
docker exec jimbomesh-still ollama show nomic-embed-text
```

**macOS Performance Mode** — Ollama runs natively on the host; use the `ollama` CLI directly:

```bash
# List installed models
ollama list

# Pull a new model
ollama pull mxbai-embed-large

# Remove a model
ollama rm <model-name>

# Show model details
ollama show nomic-embed-text
```

Models in Performance Mode are stored in `~/.ollama/models/` on your Mac, not in a Docker volume.

### Mesh Operations

```bash
# Check current Mesh status
curl -s -H "X-API-Key: YOUR_KEY" http://localhost:11434/admin/api/mesh/status | jq

# List active WebRTC peer sessions
curl -s -H "X-API-Key: YOUR_KEY" http://localhost:11434/admin/api/mesh/peers | jq

# Disconnect from Mesh
curl -s -X POST -H "X-API-Key: YOUR_KEY" http://localhost:11434/admin/api/mesh/disconnect
```

### Health Check

The health server runs on port 9090 with standard probe endpoints:

```bash
# Liveness — is Ollama alive?
curl -s http://localhost:9090/healthz | jq

# Readiness — is Ollama ready to serve requests?
curl -s http://localhost:9090/readyz | jq

# Detailed status with model list
curl -s http://localhost:9090/status | jq

# Ollama API health (direct, requires auth)
curl -s -H "X-API-Key: YOUR_KEY" http://localhost:11434/api/tags | jq

# Qdrant health (if running)
curl -s http://localhost:6333/healthz

# Qdrant collections (if running)
curl -s -H "api-key: YOUR_KEY" http://localhost:6333/collections | jq
```

#### Kubernetes Probes

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 9090
  initialDelaySeconds: 30
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /readyz
    port: 9090
  initialDelaySeconds: 60
  periodSeconds: 15
```

## Updating

### Update JimboMesh Holler Server

```bash
cd /path/to/jimbomesh-holler-server
git pull origin main
docker compose up --build -d
```

> **Note:** `--build` rebuilds the image only. Models on the `ollama_models` volume are
> not re-downloaded — the entrypoint skips any model already present.

### Update Ollama Version

The Dockerfile uses `ollama/ollama:latest`. To update:

```bash
docker compose build --no-cache jimbomesh-still
docker compose up -d
```

### Update Models

Edit `HOLLER_MODELS` in `.env`, then restart:

```bash
docker compose up -d --force-recreate
```

Or pull models directly:

```bash
docker exec jimbomesh-still ollama pull <model-name>
```

## Backup

### Model Weights

Models are stored in the `ollama_models` Docker volume. To back up:

```bash
# Export volume
docker run --rm -v ollama_models:/data -v $(pwd):/backup alpine \
  tar czf /backup/ollama-models-backup.tar.gz -C /data .

# Restore volume
docker run --rm -v ollama_models:/data -v $(pwd):/backup alpine \
  tar xzf /backup/ollama-models-backup.tar.gz -C /data
```

### Qdrant Data

If using the local Qdrant profile:

```bash
# Snapshot via API
curl -X POST -H "api-key: YOUR_KEY" \
  http://localhost:6333/collections/knowledge_base/snapshots
```

## Troubleshooting

### Ollama is slow to start

First startup downloads models (~274 MB for nomic-embed-text, ~4.9 GB for llama3.1:8b). This can take 2-5 minutes depending on network speed. Check logs:

```bash
docker logs -f jimbomesh-still
```

### GPU not detected

Ensure NVIDIA Container Toolkit is installed and the Docker daemon is configured:

```bash
# Verify toolkit
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi
```

### Embedding returns wrong dimensions

Check that `EMBED_DIMENSIONS` in `.env` matches your model:

| Model | Dimensions |
|-------|-----------|
| `nomic-embed-text` | 768 |
| `mxbai-embed-large` | 1024 |
| `all-minilm` | 384 |
| `snowflake-arctic-embed` | 1024 |

### Qdrant init-container keeps restarting

The init container has `restart: "no"` — it runs once and exits. If it failed, check logs:

```bash
docker logs jimbomesh-holler-init-qdrant
```

Common cause: Qdrant API key mismatch between `.env` and the running Qdrant instance.

### "variable is not set" warning on build

Harmless — API keys are runtime variables. Create a `.env` file to suppress:

```bash
cp .env.example .env
```

### Windows: Docker build fails with path errors

Use PowerShell, not Git Bash. Git Bash path conversion can break Docker context paths.

## Further Reading

- [Quick Start](../QUICK_START.md) — Shortest path from clone to running server
- [Configuration](CONFIGURATION.md) — All environment variables, models, runtime settings
- [Model Benchmarks](MODEL_BENCHMARKS.md) — Embedding model comparison and benchmarking script
- [ARM Support](ARM_SUPPORT.md) — ARM64 deployment (Apple Silicon, Raspberry Pi, Graviton)
- [Docker Build Guide](DOCKERBUILD.md) — Image build process, multi-stage evaluation, rebuild guide
- [Cursor / VS Code](CURSOR_VS_CODE.md) — IDE run configs, developer workflow, Cursor rules

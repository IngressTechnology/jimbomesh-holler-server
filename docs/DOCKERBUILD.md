# Docker Build Guide

How the JimboMesh Holler Server image is built, rebuilt, and customized.

## Quick Reference

```bash
# Build (first time or after Dockerfile changes)
docker compose build jimbomesh-still

# Rebuild from scratch (no cached layers)
docker compose build --no-cache jimbomesh-still

# Start Ollama only
docker compose up -d

# Start with GPU (after setting COMPOSE_FILE in .env) + Qdrant
docker compose --profile qdrant up -d

# Delete and rebuild
docker compose down
docker rmi jimbomesh-still:latest
docker compose build jimbomesh-still
docker compose up -d
```

## What the Build Does

The Dockerfile extends the official Ollama image with health checks, utility scripts, and a production entrypoint. The build is fast (~1-2 minutes) because it layers on top of the pre-built Ollama image.

> **Note:** The Dockerfile only builds the `jimbomesh-still` image. The `jimbomesh-qdrant` service uses the official `qdrant/qdrant:v1.13.2` image from Docker Hub — no build step required.

### Build Stages

| Step | What | Why | ~Time |
|------|------|-----|-------|
| 1 | `ollama/ollama:0.17.4` base | Pre-built Ollama with all dependencies | cached |
| 2 | System deps (curl, jq, bash, socat) | Health checks, JSON parsing | ~10s |
| 3 | Node.js 22.x LTS via NodeSource (+ build-essential, python3) | API gateway runtime and supporting dependencies | ~15s |
| 4 | Copy `docker-entrypoint.sh` | Production lifecycle management | instant |
| 5 | Copy `package.json` + `npm ci` | Install dependencies (`sql.js`, `pdfjs-dist`, optional `wrtc`, etc.) | ~30s |
| 6 | Copy API gateway, `db.js`, admin UI, and all modules | Auth proxy, SQLite, stats, mesh, tokens, documents, Swagger | instant |
| 7 | Create `/opt/jimbomesh-still/data/` | SQLite database directory | instant |
| 8 | Copy utility scripts | Health check, embed, Qdrant init | instant |
| 9 | Set executable permissions | Script execution | instant |
| 10 | Declare volume + port | Model persistence, API access | instant |

## Image Details

| Property | Value |
|----------|-------|
| Base image | `ollama/ollama:0.17.4` |
| Image name | `jimbomesh-still:latest` |
| Entrypoint | `docker-entrypoint.sh` (start → wait → pull → serve) |
| Working directory | `/` (Ollama default) |
| Model storage | `/root/.ollama` (volume mounted) |

### Key Paths Inside the Container

```
/usr/local/bin/docker-entrypoint.sh    ← Production entrypoint
/opt/jimbomesh-still/api-gateway.js    ← API gateway (auth, rate limiting, admin)
/opt/jimbomesh-still/admin-routes.js   ← Admin UI API handlers + static server
/opt/jimbomesh-still/db.js             ← SQLite database layer (sql.js)
/opt/jimbomesh-still/package.json      ← Node.js dependencies
/opt/jimbomesh-still/node_modules/     ← Installed dependencies (sql.js, pdfjs-dist, etc.)
/opt/jimbomesh-still/stats-collector.js ← Request stats, model metadata/pricing
/opt/jimbomesh-still/mesh-connector.js ← Mesh connector (SaaS registration, heartbeat, jobs)
/opt/jimbomesh-still/mesh-webrtc.js    ← WebRTC peer handler (P2P inference)
/opt/jimbomesh-still/token-manager.js  ← Bearer token management (Tier 2 auth)
/opt/jimbomesh-still/jwt-validator.js  ← JWT validation (Tier 3 auth)
/opt/jimbomesh-still/qdrant-client.js  ← Qdrant HTTP client
/opt/jimbomesh-still/document-pipeline.js ← Document RAG pipeline
/opt/jimbomesh-still/swagger-brand.js  ← Swagger UI branding
/opt/jimbomesh-still/swagger-brand.css ← Swagger UI custom styles
/opt/jimbomesh-still/openapi.yaml      ← OpenAPI spec (v0.7.3)
/opt/jimbomesh-still/admin/            ← Admin UI static files (HTML, JS, CSS)
/opt/jimbomesh-still/data/holler.db    ← SQLite database (volume mounted)
/opt/jimbomesh-still/healthcheck.sh    ← Docker health check script
/opt/jimbomesh-still/health-server.js  ← Node.js health HTTP server
/opt/jimbomesh-still/embed.sh          ← Embedding pipeline (Ollama-compatible)
/opt/jimbomesh-still/init-qdrant.sh    ← Qdrant collection initializer
/root/.ollama/                         ← Model storage (volume mounted)
```

### Environment Variables Set at Runtime

| Variable | Source | Purpose |
|----------|--------|---------|
| `HOLLER_MODELS` | `.env` | Models to pull on startup |
| `OLLAMA_EMBED_MODEL` | `.env` | Primary embedding model |
| `OLLAMA_HOST` | `docker-entrypoint.sh` | Bind address (`127.0.0.1:11435`, internal only) |
| `OLLAMA_NUM_PARALLEL` | `.env` | Max concurrent requests |
| `OLLAMA_MAX_LOADED_MODELS` | `.env` | Max models in memory |
| `OLLAMA_KEEP_ALIVE` | `.env` | Model unload timeout |
| `QDRANT_API_KEY` | `.env` | Qdrant auth (for embed.sh) |

## Entrypoint Script

`docker-entrypoint.sh` runs on every container start. It follows one of two paths based on whether `OLLAMA_EXTERNAL_URL` is set:

**Standard (Secure Mode / NVIDIA GPU):**

1. **Starts Ollama server** — `ollama serve &` in background
2. **Waits for API** — Polls `/api/tags` until responsive (120s timeout)
3. **Pulls models** — Iterates `HOLLER_MODELS`, pulls if not present (idempotent)
4. **Serves** — Waits on the Ollama process PID

**macOS Performance Mode** (when `OLLAMA_EXTERNAL_URL` is set via `docker-compose.mac.yml`):

1. **Skips `ollama serve`** — Ollama is already running natively on the host
2. **Sets internal URL** — Routes the gateway to `OLLAMA_EXTERNAL_URL` instead of `localhost:11435`
3. **Waits for host Ollama** — Polls `OLLAMA_EXTERNAL_URL/api/tags` until responsive
4. **Pulls models via host** — Uses `OLLAMA_HOST` env var to target the native Ollama
5. **Starts gateway** — Node.js gateway proxies to the host Ollama

This is why first startup takes longer — models must be downloaded. Subsequent starts are fast because models persist in the named volume (Secure Mode) or `~/.ollama/models/` (Performance Mode).

## Volumes

The image uses two volumes mapped by Docker Compose:

```yaml
volumes:
  - ollama_models:/root/.ollama
  - holler_data:/opt/jimbomesh-still/data
```

- `ollama_models` — Model weights (~2-5 GB). First run downloads models; subsequent starts are fast.
- `holler_data` — SQLite database (~1-300 MB). Request logs, settings, hourly stats.

Both volumes:
- **`docker compose down`**: Preserves volumes
- **`docker compose down -v`**: Deletes volumes (models re-download, DB reset)
- **Rebuilding the image**: Does NOT affect volume data

## Rebuilding

### When to Rebuild

| Scenario | Command |
|----------|---------|
| Changed Dockerfile | `docker compose build jimbomesh-still` |
| Changed scripts or admin UI | `docker compose build jimbomesh-still` |
| Update Ollama version | `docker compose build --no-cache jimbomesh-still` |
| Broken image / clean slate | `docker rmi jimbomesh-still:latest && docker compose build --no-cache jimbomesh-still` |

### Full Rebuild (Nuclear Option)

```bash
# Stop everything
docker compose down

# Remove the image
docker rmi jimbomesh-still:latest

# Remove Docker build cache
docker builder prune -f

# Rebuild
docker compose build --no-cache jimbomesh-still

# Start
docker compose up -d
```

> **Note:** `docker compose down` preserves the `ollama_models` volume. Your downloaded models are safe.

## GPU Build Notes

### NVIDIA GPU

GPU support uses the same image as the CPU variant. It is enabled at runtime via the `docker-compose.gpu.yml` overlay file (set `COMPOSE_FILE` in `.env`). The Docker `deploy.resources.reservations.devices` configuration handles GPU passthrough — no separate build is needed.

Requirements:
- NVIDIA GPU
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed
- Docker configured for NVIDIA runtime

Verify GPU access:

```bash
docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi
```

### macOS Metal GPU (Performance Mode)

Apple Silicon GPU support does **not** require a different Docker image. Docker Desktop cannot pass Metal GPU through to containers regardless of build configuration. Instead, Performance Mode runs Ollama natively on the host (via Homebrew), with Docker running only the API gateway.

The `docker-compose.mac.yml` overlay sets `OLLAMA_EXTERNAL_URL=http://host.docker.internal:11434`, which tells `docker-entrypoint.sh` to skip the internal `ollama serve` and route the gateway to the native host Ollama. No Dockerfile changes are required.

`docker-compose.mac.yml` is committed to the repository and serves as the canonical reference for the overlay. `setup.sh` also writes this file during Performance Mode setup (overwriting any local edits) to ensure the correct values are present.

Set up with:

```bash
./setup.sh  # Select [P] Performance Mode
```

`setup.sh` also writes `.setup-config.json` to the project root, recording `ollamaMode`, `installedAt`, `securityWarningAccepted`, `platform`, and `arch`. This file is `.gitignore`d.

See [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md) for the full guide and [ARM_SUPPORT.md](ARM_SUPPORT.md) for Raspberry Pi and Graviton details.

## Multi-Stage Build Evaluation

### Summary

A multi-stage Docker build was evaluated and **not adopted**. The potential savings are negligible compared to the base image size, and the added complexity is not justified.

### Size Breakdown

| Layer | Approximate Size | Could Multi-Stage Help? |
|-------|-----------------|------------------------|
| `ollama/ollama:0.17.4` base | ~1.5 GB | No — required at runtime |
| Node.js 22.x runtime | ~100 MB | No — required at runtime |
| System deps (curl, jq, bash, socat) | ~30 MB | No — required at runtime |
| NodeSource setup artifacts (gnupg, apt lists) | ~15-20 MB | Yes — build-only |
| Scripts + admin UI | ~100 KB | No — required at runtime |

### Analysis

In a multi-stage build, you use a "builder" stage to install packages and then copy only the needed artifacts into a clean final stage. This is effective when:

1. **Build tools are much larger than runtime artifacts** — e.g., compiling Go/Rust produces a static binary; the compiler is discarded. Here, Node.js needs its full runtime at runtime.

2. **The base image is small** — e.g., starting from `alpine` or `scratch`. Here, the base image is `ollama/ollama:0.17.4` (~1.5 GB), which already contains Ubuntu, CUDA libraries, and the Ollama binary.

3. **There are significant build-only dependencies** — e.g., `gcc`, `make`, header files. Here, the only build-only artifacts are the NodeSource GPG key and apt repository config (~15-20 MB).

### What Multi-Stage Would Save

A multi-stage build could avoid shipping the NodeSource GPG key and apt repo config, saving approximately **15-20 MB** on a **~1.7 GB** image — less than 1.2% reduction.

### What Multi-Stage Would Cost

- More complex Dockerfile (harder to read and maintain)
- Cannot use the simple `FROM ollama/ollama:0.17.4` + `apt-get install` pattern
- Would need to either:
  - Copy the Node.js binary from a builder stage (fragile, may miss shared libraries)
  - Use `ollama/ollama:0.17.4` as the final stage anyway (negating most benefits)
- Risk of runtime failures from missing shared libraries that were present in the builder

### Conclusion

The image size is dominated by the Ollama base image (~1.5 GB) and model weights (stored in a volume, not the image). The ~15-20 MB of build artifacts is not worth the added Dockerfile complexity. If image size becomes a concern, the most impactful change would be pinning a specific Ollama version tag instead of `:latest`, or requesting a slimmer Ollama base image upstream.

### Effective Size Reduction Strategies

If image size matters for your deployment:

1. **Pin Ollama version** — Avoid `:latest` tag drift. Currently pinned to `ollama/ollama:0.17.4`.
2. **Use `--no-install-recommends`** — Already done in our Dockerfile.
3. **Clean apt lists** — Already done (`rm -rf /var/lib/apt/lists/*`).
4. **Combine RUN layers** — Reduces layer overhead. Current Dockerfile uses two RUN commands for clarity; combining them saves ~5 MB.
5. **Use `.dockerignore`** — Prevent large files (docs, git history) from entering the build context.

## Troubleshooting

### Build fails at `apt-get install`

Network issues. Retry:

```bash
docker compose build jimbomesh-still
```

### Image is large

The base `ollama/ollama:0.17.4` image is already ~1-2 GB. This project adds minimal overhead (curl, jq, scripts). Model weights are stored in the volume, not the image.

### Models re-download on every start

The volume may not be persisting. Check:

```bash
docker volume ls | grep ollama
```

If the volume exists but models still re-download, the container may be using a different volume name. Ensure `docker-compose.yml` has:

```yaml
volumes:
  ollama_models:
```

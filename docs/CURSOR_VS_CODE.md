# Cursor & VS Code Developer Guide

IDE-specific configurations, run commands, and workflow tips for developing the Holler Server.

## Run Configurations (launch.json)

Open the Run & Debug panel (`Ctrl+Shift+D`) or press `F5` and select a configuration from the dropdown.

| Configuration | What It Does |
|---------------|--------------|
| **Docker: Build & Up** | Full build + start all services in detached mode, then tail logs |
| **Docker: Deploy Code** | Rebuild only the `jimbomesh-still` image and restart its container — preserves model volumes, skips Qdrant |
| **Docker: Down** | Stop and remove all containers and network |
| **Docker: Rebuild (no cache)** | Tear down, rebuild from scratch (no Docker layer cache), start, tail logs |
| **Docker: Logs** | Tail `jimbomesh-still` container logs |

### Choosing the Right Configuration

```
First time / fresh clone  →  Docker: Build & Up
Edited JS, HTML, shell    →  Docker: Deploy Code     (fast — reuses cached layers, preserves models)
Changed Dockerfile/deps   →  Docker: Rebuild (no cache)
Something went wrong      →  Docker: Down → Docker: Build & Up
```

**Docker: Deploy Code** is the daily driver. It runs:

1. `docker compose build jimbomesh-still` — rebuilds only the application image
2. `docker compose up -d --force-recreate --no-deps jimbomesh-still` — restarts only this container
3. Tails logs so you see startup output immediately

Named volumes (`ollama_models`, `holler_data`) are never removed. The entrypoint detects models already present on the volume and skips the pull.

## Tasks (tasks.json)

Open the task runner with `Ctrl+Shift+P` → **Tasks: Run Task**, or bind a keyboard shortcut.

| Task | Command | Notes |
|------|---------|-------|
| Docker Compose: Down | `docker compose down --remove-orphans` | Cleans up orphan containers |
| Docker Compose: Build only | `docker compose build` | Image build without starting |
| Docker Compose: Build & Up (CPU) | down + `up --build` | CPU-only, foreground logs |
| Docker Compose: Build & Up (GPU) | down + `up --build` | Requires `COMPOSE_FILE` GPU overlay in `.env` |
| Docker Compose: Build & Up (Qdrant) | down + `--profile qdrant up --build` | Includes Qdrant + init container |
| Docker Compose: Build & Up (GPU + Qdrant) | down + `--profile qdrant up --build` | GPU overlay via `COMPOSE_FILE` + Qdrant profile |

Tasks run in the integrated terminal. Build tasks use a **dedicated** panel; the Down task uses a **shared** panel.

### Run Configurations vs Tasks

- **Run Configurations** (launch.json) — one-click from the Run dropdown or `F5`. Best for the common workflows you repeat dozens of times a day.
- **Tasks** (tasks.json) — mode variants (CPU/GPU via `COMPOSE_FILE`) and optional Qdrant profile. Use when you need a specific compose combination.

## Cursor AI Rules (.cursor/rules/)

Three project rules give Cursor's AI context about the codebase:

| Rule | Scope | Always Active |
|------|-------|---------------|
| `project-context.mdc` | Architecture, key paths, critical constraints | Yes |
| `docker.mdc` | Compose structure, volumes, security, env var conventions | When editing Docker/env files |
| `shell-scripts.mdc` | Bash conventions, embed.sh patterns, error handling | When editing `scripts/*.sh` |

These files live in `.cursor/rules/` and are automatically loaded by Cursor when relevant files are open. Edit them to update the AI's understanding of the project.

### CLAUDE.md

The root `CLAUDE.md` file provides extended project context — full directory structure, naming conventions, network configuration, and recent changelog. This is loaded as always-applied context for every AI interaction.

## Endpoints for Development

After starting the container, these are available on the host:

| Endpoint | URL | Auth |
|----------|-----|------|
| Ollama API | `http://your-server-ip:1920` | `X-API-Key` header (if `JIMBOMESH_HOLLER_API_KEY` set) |
| Admin UI | `http://your-server-ip:1920/admin` | Same API key via login form |
| Swagger UI | `http://your-server-ip:1920/docs` | None |
| Health checks | `http://your-server-ip:9090/healthz` | None |
| Readiness | `http://your-server-ip:9090/readyz` | None |

Without `JIMBOMESH_HOLLER_API_KEY` in `.env`, requests are unauthenticated. This is useful for isolated local development but unsafe for shared machines or networks.

## Terminal Quick Reference

Common commands you'll run in the integrated terminal:

```bash
# Check container status
docker compose ps

# Watch logs (already running)
docker compose logs -f jimbomesh-still

# Exec into the container
docker compose exec jimbomesh-still bash

# Check which models are loaded
docker compose exec jimbomesh-still ollama list

# Test the embedding endpoint
curl http://your-server-ip:1920/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{"input": "hello world", "model": "nomic-embed-text"}'

# Test health
curl http://your-server-ip:9090/readyz

# View SQLite database
docker compose exec jimbomesh-still sqlite3 /opt/jimbomesh-still/data/holler.db ".tables"

# Nuke everything (volumes too) — WARNING: re-downloads models
docker compose down -v
```

## Environment Setup

1. Copy `.env.example` to `.env`
2. Generate API keys: `openssl rand -hex 32`
3. For GPU mode, add to `.env`:
   - Linux/macOS: `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml`
   - Windows: `COMPOSE_FILE=docker-compose.yml;docker-compose.gpu.yml`

## Volume Persistence

| Volume | Mount | Survives `down` | Survives `down -v` |
|--------|-------|-----------------|---------------------|
| `ollama_models` | `/root/.ollama` | Yes | **No** — re-downloads all models |
| `holler_data` | `/opt/jimbomesh-still/data` | Yes | **No** — loses SQLite DB |
| `qdrant_storage` | `/qdrant/storage` | Yes | **No** — loses vector data |

`docker compose down` (without `-v`) is safe. It removes containers and the network but preserves all volumes. Use **Docker: Deploy Code** for the fastest code iteration cycle — it doesn't even run `down`, just rebuilds the image and force-recreates the container.

## File Edit → Container Update Map

Where you edited determines how to get changes into the running container:

| Files Changed | Minimum Action |
|---------------|----------------|
| `api-gateway.js`, `admin-routes.js`, `db.js` | **Deploy Code** (rebuild image) |
| `admin/*.html`, `admin/*.js`, `admin/*.css` | **Deploy Code** (rebuild image) |
| `admin/locales/*.json` | **Deploy Code** (rebuild image) |
| `docker-entrypoint.sh`, `scripts/*.sh` | **Deploy Code** (rebuild image) |
| `openapi.yaml` | **Deploy Code** (rebuild image) |
| `package.json` | **Rebuild (no cache)** — npm install layer changes |
| `Dockerfile` | **Rebuild (no cache)** |
| `docker-compose.yml` | **Down** then **Build & Up** |
| `.env` | `docker compose restart` (no rebuild needed) |
| `.cursor/rules/*`, `CLAUDE.md` | No container action — AI context only |
| `docs/*.md` | No container action — documentation only |

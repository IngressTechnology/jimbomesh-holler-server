# Development Guide

This guide is for people who want to contribute to, debug, or modify `jimbomesh-holler-server`.

If you are trying to install and use Holler rather than change the codebase, start with the root [README.md](../README.md) and [QUICK_START.md](../QUICK_START.md). For contribution norms and PR expectations, also read [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

- Node.js 22+
- Docker Desktop or Docker Engine with Compose
- Ollama for local inference testing outside Docker
- Git

Optional, depending on what you touch:

- Rust via [rustup](https://rustup.rs) for desktop app work in `desktop/`
- Qdrant if you are testing document ingestion and RAG flows outside the default Docker stack

## Getting Started

### Clone and Install

```bash
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git
cd jimbomesh-holler-server
cp .env.example .env
# Edit .env and set at least JIMBOMESH_HOLLER_API_KEY
openssl rand -hex 32
npm install
```

At minimum, put a generated key into `.env`:

```bash
JIMBOMESH_HOLLER_API_KEY=your_generated_key_here
```

### Run Locally

For quick iteration on the Node.js server:

```bash
node api-gateway.js
```

Default local URLs:

- Gateway: `http://localhost:1920`
- Admin UI: `http://localhost:1920/admin`
- OpenAI-compatible API: `http://localhost:1920/v1`
- Health API: `http://localhost:9090`

### Docker Development

Docker is the recommended dev path because it matches the supported runtime, includes the SQLite-backed service environment, and avoids host-specific native module drift.

```bash
docker compose up -d
```

Optional variants:

- Add Qdrant: `docker compose --profile qdrant up -d`
- Enable NVIDIA GPU: set `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env`, then run `docker compose up -d`
- On Windows, use `;` instead of `:` in `COMPOSE_FILE`

Useful verification commands:

```bash
docker compose ps
docker logs -f jimbomesh-still
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/api/tags
```

## Testing

### Important: Full Validation Should Be Run In Docker

The recommended contributor workflow is to run the full test and lint suite inside the Docker environment. That keeps the gateway, SQLite pathing, env defaults, Ollama connectivity, and native modules aligned with production behavior.

You can run some commands locally on a correctly configured machine, but do not treat a host-only run as release validation.

### Test Layers

| Layer | Runner | Scope | Command |
|-------|--------|-------|---------|
| Unit | Node.js built-in test runner | Shared logic in `test/*.test.js` | `npm test` |
| API | Playwright `APIRequestContext` | Live endpoint behavior in `test/api/*.spec.js` | `npm run test:api` |
| UI | Playwright browser automation | Admin UI workflows in `test/ui/*.spec.js` | `npm run test:ui` |

### Run Tests In The Container

The main service container is `jimbomesh-still`.

```bash
docker exec -it jimbomesh-still npm test
docker exec -it jimbomesh-still npm run test:api
docker exec -it jimbomesh-still npm run test:ui
docker exec -it jimbomesh-still npm run lint
docker exec -it jimbomesh-still npm run format:check
```

Before running API and UI tests:

- Keep Holler running on `http://localhost:1920`
- Ensure `.env` has a working auth key
- Keep Ollama reachable for inference-backed test cases
- Enable Qdrant if you are testing document ingestion or RAG flows

### Pre-Commit Checklist

1. `npm run format:check`
2. `npm run lint`
3. `npm test`
4. `npm run test:api`
5. `npm run test:ui`
6. Update docs when behavior or configuration changed

If your change affects setup scripts, admin workflows, mesh connectivity, Qdrant, or the desktop wrapper, test that user path explicitly and note it in the PR.

## Repository Map

### Core Runtime

- `api-gateway.js` - main Node.js gateway, auth, rate limiting, Ollama/OpenAI-compatible routes
- `admin-routes.js` - admin API endpoints and static admin delivery
- `db.js` - SQLite persistence layer
- `document-pipeline.js` - extraction, chunking, embeddings, and RAG orchestration
- `qdrant-client.js` - Qdrant HTTP client helpers
- `mesh-connector.js` - JimboMesh SaaS coordination, registration, heartbeat, and job polling
- `mesh-webrtc.js` - peer-to-peer WebRTC path for mesh inference jobs
- `token-manager.js` - Tier 2 bearer tokens
- `jwt-validator.js` - Tier 3 JWT validation

### Frontend And Tests

- `admin/` - admin frontend, written in vanilla HTML, CSS, and JavaScript with locale JSON files
- `test/` - Node.js unit tests
- `test/api/` - Playwright API tests
- `test/ui/` - Playwright UI and end-to-end tests

### Packaging And Operations

- `docker-compose.yml` - base Compose stack
- `docker-compose.gpu.yml` - NVIDIA GPU overlay
- `docker-entrypoint.sh` - container startup, readiness wait, and model pull logic
- `setup.sh` and `setup.ps1` - interactive installers
- `desktop/` - Tauri desktop wrapper
- `.github/workflows/` - CI, release, and packaging automation

## Configuration

Most runtime configuration is driven by `.env`. See [docs/CONFIGURATION.md](CONFIGURATION.md) for the complete reference and [`.env.example`](../.env.example) for the latest defaults.

### Common Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `JIMBOMESH_HOLLER_API_KEY` | Yes | Main local API key for inference endpoints |
| `ADMIN_API_KEY` | No | Separate admin key for `/admin` and `/admin/api/*` |
| `GATEWAY_PORT` | No | Gateway port, default `1920` |
| `OLLAMA_INTERNAL_PORT` | No | Internal Ollama port, default `11435` |
| `HOLLER_SERVER_NAME` | No | Display name in the admin UI and mesh metadata |
| `HOLLER_MODELS` | No | Models pulled on startup |
| `OLLAMA_EMBED_MODEL` | No | Primary embedding model |
| `JIMBOMESH_API_KEY` | No | Optional mesh key for SaaS-connected mode |

### Port 1920

The default port is `1920`, the year Prohibition started. That is intentional branding and should remain the default unless a real deployment need requires otherwise.

## Code Style And Conventions

- CommonJS only; this repo does not use `"type": "module"`
- Prefer `const` and `let`; do not introduce `var`
- Keep admin auth behavior aligned with `ADMIN_API_KEY` fallback to `JIMBOMESH_HOLLER_API_KEY`
- Do not swallow errors silently; if a catch must stay non-fatal, log enough context to debug it
- Keep changes scoped and update docs in the same PR when user-facing behavior changes
- Use existing formatting and linting commands rather than introducing one-off style rules

## Architecture Pointers

Start here when you need deeper background:

- [docs/ARCHITECTURE.md](ARCHITECTURE.md) for system design, trust boundaries, and data flow
- [docs/DOCKERBUILD.md](DOCKERBUILD.md) for image and rebuild workflow
- [docs/CURSOR_VS_CODE.md](CURSOR_VS_CODE.md) for contributor workflow in Cursor and VS Code
- [docs/SECURITY.md](SECURITY.md) for auth tiers and hardening
- [openapi.yaml](../openapi.yaml) for the served API contract behind `/docs`

## Desktop App Development

The `desktop/` folder contains the Tauri wrapper around the existing admin UI.

### Desktop Prerequisites

- Rust 1.77+ via `rustup`
- Node.js 22+
- Ollama installed locally

Linux desktop builds also need the system packages listed in [`desktop/README.md`](../desktop/README.md).

### Run The Desktop App In Dev Mode

Start the Holler server first from the repo root:

```bash
npm install
npm start
```

In a second terminal:

```bash
cd desktop
npm install
npm run tauri dev
```

The Tauri webview points at `http://localhost:1920/admin`.

### Build Native Installers

```bash
cd desktop
npm run tauri build
```

Output bundles are written under `desktop/src-tauri/target/release/bundle/`.

The desktop app supports:

- Attach mode: connect to an already running Holler on port `1920`
- Standalone mode: install or start local dependencies and manage its own Holler instance

## Mesh Development

Mesh-connected mode is optional and activated by `JIMBOMESH_API_KEY`.

Rules of thumb:

- No mesh key means standalone local mode
- Mesh mode is outbound from the Holler to SaaS
- SaaS coordination must not store prompts, responses, or chat history
- Holler remains the thick runtime; SaaS is thin coordination and billing

Relevant files:

- `mesh-connector.js`
- `mesh-webrtc.js`
- `jwt-validator.js`
- `token-manager.js`

## Branching, Commits, And Releases

- Branch from `main`
- Keep PRs focused to one concern where possible
- Prefer conventional commit style, for example `fix(api): normalize timeout errors`
- Tag format is `v0.x.y`
- Tag pushes drive Docker and native release packaging

Pre-1.0 release rhythm in this repo has been:

- Minor versions for feature releases
- Patch versions for fixes and docs/maintenance work

### Automated Release Scripts

Use the release helpers from the repo root when cutting a version:

```bash
./scripts/release.sh 0.3.2
```

```powershell
.\scripts\release.ps1 0.3.2
```

The release scripts:

- Require a version argument
- Refuse to continue until the working tree is clean
- Run `npm run lint` and `npm test`
- Sync the version in `package.json`, `desktop/src-tauri/tauri.conf.json`, and `desktop/src-tauri/Cargo.toml`
- Create the release commit as `release: vX.Y.Z`
- Create the git tag as `vX.Y.Z`
- Push `main` and all tags to `origin`

If a release fails after version files were updated but before the commit is created, reset the working tree with:

```bash
git checkout .
```

## Documentation Rules

If you change behavior, update the docs in the same PR. Common touch points:

- [README.md](../README.md) for top-level behavior
- [QUICK_START.md](../QUICK_START.md) for first-run and install flow
- [docs/CONFIGURATION.md](CONFIGURATION.md) for env vars
- [docs/API_USAGE.md](API_USAGE.md) for endpoints and examples
- [docs/DEPLOYMENT.md](DEPLOYMENT.md) for operator-facing runbooks
- [docs/IDE_INTEGRATIONS.md](IDE_INTEGRATIONS.md) for editor setup

## Helpful Commands

```bash
docker compose up -d
docker compose --profile qdrant up -d
docker logs -f jimbomesh-still
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/health
curl http://localhost:9090/healthz
```

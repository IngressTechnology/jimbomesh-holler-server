# Contributing to JimboMesh Holler Server

Thanks for helping improve Holler.
This guide focuses on practical, current workflow for contributors.

## Code of Conduct

All contributors are expected to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Ways to Contribute

- Fix bugs or improve reliability.
- Improve docs for users, admins, and contributors.
- Add tests and tighten error handling.
- Improve setup scripts and cross-platform behavior.
- Improve admin UX and accessibility.

## Before You Start

- Search existing issues and PRs first.
- For bugs, include clear repro steps and logs.
- For larger changes, open an issue to align on approach.

## Local Development Setup

### Prerequisites

- Docker Desktop (with Compose)
- Git
- Node.js 22.x (only needed for some local tooling/tasks)

### Clone and Configure

```bash
git clone https://github.com/YOUR-USERNAME/jimbomesh-holler-server.git
cd jimbomesh-holler-server
git remote add upstream https://github.com/IngressTechnology/jimbomesh-holler-server.git
cp .env.example .env
```

Set at least:

```bash
JIMBOMESH_HOLLER_API_KEY=<generated key>
```

Generate a key:

```bash
openssl rand -hex 32
```

### Run the Stack

```bash
# CPU mode (default)
docker compose up -d

# Optional: include Qdrant
docker compose --profile qdrant up -d
```

For NVIDIA GPU mode, set `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env`, then run `docker compose up -d`.

### Verify

```bash
docker compose ps
docker logs -f jimbomesh-still
curl -H "X-API-Key: YOUR_KEY" http://localhost:11434/api/tags
```

Admin UI: `http://localhost:11434/admin`

## Repository Map

- `api-gateway.js`: API gateway, auth, rate limiting, OpenAI-compatible routes.
- `admin-routes.js`: Admin API endpoints and static admin delivery.
- `db.js`: SQLite persistence layer.
- `document-pipeline.js`: Document extraction, chunking, embeddings, RAG flow.
- `qdrant-client.js`: Qdrant HTTP client helpers.
- `admin/`: Admin frontend (vanilla JS + i18n locale files).
- `setup.sh`, `setup.ps1`: Interactive installers.
- `docker-entrypoint.sh`: Container startup, readiness wait, model pull logic.

## Development Workflow

1. Create a branch from `main`.
2. Keep changes scoped to one concern.
3. Test the user path and the admin path when relevant.
4. Update docs in the same PR when behavior changes.
5. Open PR with a clear description and test notes.

Example:

```bash
git checkout -b fix/descriptive-name
```

## Testing Checklist

Run the checks that match your change:

- API smoke checks (`/api/tags`, `/api/embed`, `/v1/embeddings`)
- Admin UI flows you changed
- Docs links and command validity
- Qdrant flow if you touched document pipeline
- Setup script path if you changed install behavior

Useful commands:

```bash
docker compose logs -f jimbomesh-still
curl -H "X-API-Key: YOUR_KEY" http://localhost:11434/health
curl http://localhost:9090/healthz
```

## Documentation Requirements

If behavior changes, update docs in the same PR:

- `README.md` for top-level behavior
- `QUICK_START.md` for first-run flow
- `docs/CONFIGURATION.md` for new/changed env vars
- `docs/API_USAGE.md` for endpoint or payload changes
- `docs/DEPLOYMENT.md` for operations/runbook changes
- `docs/CURSOR_VS_CODE.md` for contributor workflow/tooling changes

## Pull Request Expectations

- Clear title and intent.
- Why this change is needed.
- What was tested.
- Screenshots/GIFs for UI changes.
- Linked issue when applicable (`Closes #123`).

## Commit Style

Conventional Commits are preferred:

```text
feat(admin): add qdrant key copy action
fix(api): handle timeout response normalization
docs(config): clarify COMPOSE_FILE GPU overlay behavior
```

## Security Reporting

Do not file public issues for vulnerabilities.
Report privately via [SECURITY.md](SECURITY.md).

## Helpful References

- [README.md](README.md)
- [QUICK_START.md](QUICK_START.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- [docs/SECURITY.md](docs/SECURITY.md)

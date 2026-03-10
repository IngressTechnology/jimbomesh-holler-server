# TODO

## Open Items

### High Priority

- [ ] **Automated dimension migration** — Script that handles the full Qdrant dimension migration: backup collections, delete, re-create with new dimensions, trigger `--full` re-sync. Currently a manual multi-step process documented in `docs/INTEGRATION.md`.

### Medium Priority

(No open items)

### Low Priority

- [ ] **Model auto-update** — Cron job to periodically check for updated model versions and pull them. Ollama model tags can change upstream.

- [ ] **CI/CD pipeline** — GitHub Actions workflow to build the image, run smoke tests (start container, verify embedding), and push to a registry.

## Completed

- [x] Dockerfile with auto model pulling
- [x] Docker Compose with GPU and Qdrant profiles
- [x] Drop-in `embed.sh` replacement for JimboMesh
- [x] Qdrant collection initializer
- [x] Windows PowerShell installer (`setup.ps1`)
- [x] Linux/macOS Bash installer (`setup.sh`)
- [x] Production `docker-entrypoint.sh`
- [x] Full documentation system (ARCHITECTURE, DEPLOYMENT, CONFIGURATION, DOCKERBUILD, INTEGRATION)
- [x] CLAUDE.md for Claude Code context
- [x] CONTRIBUTING.md
- [x] HTTP health check endpoints (`/healthz`, `/readyz`, `/status`) with optional model warmup
- [x] Admin UI web panel at `/admin` (dashboard, models, playground, config, activity)
- [x] SQLite persistent storage (`sql.js`) for request logs, settings, and statistics
  - Request logs survive container restarts (replaces in-memory ring buffer)
  - Runtime-mutable settings editable from admin UI
  - Hourly aggregated statistics with rollups
  - Paginated activity log API
  - Admin dashboard shows persistent stats (today, all-time, DB size)
  - Automatic log pruning (configurable retention)
  - Pure JavaScript/WASM SQLite with explicit saves after mutations
- [x] OpenAI-compatible `/v1/embeddings` endpoint with batch support
- [x] Batch embedding — `/v1/embeddings` accepts array of inputs natively
- [x] Pinned Node.js 22.x (LTS) via NodeSource in Dockerfile
- [x] Fixed init-qdrant exit code 22 (handle HTTP 404/409 gracefully)
- [x] Fixed health-handler.sh using internal Ollama port (was hitting auth-protected gateway)
- [x] Dual-backend embed.sh (auto-detects Ollama vs OpenRouter via OLLAMA_URL)
- [x] Qdrant API key authentication and configuration
- [x] Fixed Docker entrypoint path (relative to absolute)
- [x] Fixed line endings (CRLF to LF) with .gitattributes enforcement
- [x] Fixed shell compatibility (sh to bash shebang)
- [x] Model upgrade to llama3.1:8b (128K context)
- [x] Additional documentation (MAC_WINDOWS_SETUP.md, TROUBLESHOOTING.md, QUICK_START.md, CHANGELOG.md, NAMING.md)
- [x] Model benchmarks — Benchmarking script (`scripts/benchmark-models.sh`) and results guide (`docs/MODEL_BENCHMARKS.md`)
- [x] Multi-stage Dockerfile — Evaluated and documented in `docs/DOCKERBUILD.md` (not adopted: <1.2% savings vs added complexity)
- [x] ARM support — ARM64 deployment guide (`docs/ARM_SUPPORT.md`) covering Apple Silicon, Raspberry Pi, AWS Graviton

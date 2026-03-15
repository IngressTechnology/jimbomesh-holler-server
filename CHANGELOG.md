# Changelog

All notable changes to the JimboMesh Holler Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.37] - 2026-03-14

### Added

- **Mesh model availability hardening**
  - Mesh registration, heartbeats, and job model checks now use a shared 30-second cached model list.
  - Added fallback to `HOLLER_MODELS` when `GET /api/tags` is temporarily unavailable.

### Changed

- Mesh model validation now checks for model availability instead of requiring a currently loaded model.
- Documentation sweep across `README.md`, `docs/ARCHITECTURE.md`, and `docs/API_USAGE.md` to align mesh behavior, reconnect timing, and examples with current implementation.

## [0.3.21] - 2026-03-11

### Added

- **Mesh reconnect UX + key persistence**
  - New endpoints: `POST /admin/api/mesh/connect-stored`, `POST /admin/api/mesh/forget-key`, `POST /admin/api/mesh/reconnect`
  - `GET /admin/api/mesh/status` now includes `hasStoredMeshKey`
  - `GET /admin/api/mesh/latest-version` to fetch latest published coordinator-compatible Holler version metadata
- **Admin restart controls**
  - New endpoint: `POST /admin/api/restart` with `{"target":"holler"|"ollama"}`
  - Admin UI Utilities actions for restart flows
- **Mesh connector resilience**
  - Ping/pong keepalive on management WebSocket with timeout-driven reconnect
  - Stepped reconnect backoff and full re-registration after prolonged disconnect
  - SSE fallback inference path when WebRTC job signaling fails

### Changed

- Mesh disconnect now preserves stored mesh API key by default for one-click reconnect (clears auto-connect flag only).
- OpenAPI spec bumped to `0.7.3` and updated with the mesh latest-version endpoint.
- Documentation refresh across `README.md`, `QUICK_START.md`, `docs/API_USAGE.md`, `docs/DEPLOYMENT.md`, and `docs/MAC_WINDOWS_SETUP.md` to match current endpoints and installer behavior.

### Fixed

- Improved management socket timer cleanup and restart safety for reusable mesh connector instances.
- Reduced stale/disconnected management WS states via heartbeat safety checks and reconnect guards.
- Prevented duplicate mesh execution for the same job by skipping SSE fallback inference when a WebRTC P2P session is already active (`webrtc_active` skip signal).

## [0.3.0] - 2026-03-09

### Added

- **🖥️ Native Desktop App (Tauri)** — One-click installer for Windows (.exe), macOS (.dmg), and Linux (.AppImage)
  - System tray with status indicator, server controls (Start/Stop/Restart), and portal link
  - Minimize-to-tray instead of close — runs in background
  - First-run wizard: detects/installs Ollama, generates API keys, pulls default model
  - Dual-mode: **Attach** (connect to existing Docker/CLI Holler) or **Standalone** (self-contained)
  - Detection dialog when existing Holler found on configured port
  - Auto-authentication via URL hash fragment — zero manual login for desktop users
  - Remembers user preference (attach vs standalone) across launches
  - "Switch Mode" tray menu item to change between attach and standalone
  - "Open JimboMesh Portal" tray menu opens app.jimbomesh.ai in default browser
  - Dynamic port detection reads `GATEWAY_PORT` from `.env` (default 1920)
  - GitHub Actions CI/CD builds all 3 platforms on tag push
  - Auto-updater configured via GitHub Releases

- **💰 Estimated Savings column** in Recent Activity dashboard — shows USD saved vs commercial API pricing (GPT-4o equivalent)
  - Configurable baseline pricing in `appsettings.json` (`InputCostPer1K`, `OutputCostPer1K`)
  - Running total across all displayed rows
  - Per-row savings calculated from actual token counts

- **📊 Recent Activity usage stats** — TokensIn, TokensOut, DurationMs, Cost, and HollerName now populated on every inference completion
  - Scrollable fixed-height table (300 records, 20 visible rows, sticky headers)
  - Dark theme styling (`#1a1a2e` bg, `#00d4aa` teal accents)

- **🥃 Moonshine currency display** — Cost column always shows 🥃 emoji (fallback: MS), never $
  - Est. Savings always shows explicit `$` prefix, never locale-dependent formatting

- **Install workflow** — native dialog detects existing Holler with port, name, and status

### Changed

- Default model changed from `llama3.2:3b` to `llama3.2:1b` for faster first-run on all hardware
- Recent Activity API (`GET /api/usage`) now accepts `?limit=300` parameter (default 20, max 300)
- Recent Activity populates `HollerName` from Holler records instead of empty string

### Fixed

- **Moonshine balance per-USER not per-Holler** (JIM-448) — `MoonshineService.GetBalanceAsync` now reads `Users.MoonshineBalance` directly, not SUM of transactions. Fixes zero-balance display when Hollers are stale/deleted.
- **Usage stats write path** (JIM-453) — `HollerConnectionManager.cs` now captures Ollama final chunk stats (`prompt_eval_count`, `eval_count`, `total_duration`) on `fallback_done` and routes through `CompleteJobAsync`
- **Est. Savings locale bug** — `ToString("C")` rendered as Đ on some Azure regions. Replaced with explicit `$"{value:F2}"` formatting.
- `EconomyService.AdjustBalanceAsync` uses `Users.MoonshineBalance` as source of truth
- `GrantStarterBalanceAsync` atomic write (balance + transaction in single `SaveChangesAsync`)

## [0.2.11] - 2026-03-08

### Added

- Version badge in admin header bar (reads from `package.json`)
- CHANGELOG.md (Keep a Changelog format)
- ESLint + Prettier configuration with zero-warning policy
- 116 total tests: 41 unit (Node.js 22 built-in runner) + 68 Playwright UI + 7 Playwright API
- CI/CD pipeline: lint → test → Docker build on push, Docker + Release on tag
- Playwright E2E scaffolding with 18 spec files
- `.github/workflows/release.yml` for automated Docker image publishing

### Changed

- `var` → `const`/`let` throughout codebase (ESLint cleanup)
- Empty catch blocks now log warnings
- Browser globals configured for ESLint

### Fixed

- SSRF in HuggingFace model import — domain allowlist on redirects (`huggingface.co`, `hf.co` + subdomains)
- `ADMIN_TOKEN` references updated to `ADMIN_API_KEY` in documentation

### Security

- HTTPS + domain suffix allowlist on every redirect hop for model downloads
- ALLOWED_HF_DOWNLOAD_HOST_SUFFIXES enforcement in `admin-routes.js`

## [0.2.10] - 2026-03-08

### Added

- Initial public release
- Admin UI with dark theme (`#1a1a2e` background, `#00d4aa` teal accents)
- Model Marketplace with HuggingFace + Ollama integration (37 curated models)
- OpenAI-compatible Chat Completions API (`/v1/chat/completions`)
- IDE integration guides for 8 IDEs
- GPU detection (NVIDIA CUDA + macOS Metal)
- Docker + Docker Compose deployment
- SQLite for local state management
- Health check endpoint (`/health`)
- Rate limiting (configurable per-minute + burst)
- VRAM-aware model badges
- SSE streaming for chat completions
- Setup scripts for Windows (PowerShell) and macOS/Linux (bash)

## [0.1.0] - 2026-02-27

### Added

- Initial alpha release
- Basic Ollama proxy with API gateway
- Admin dashboard (dark theme)
- Model management (pull, delete, list)
- Port 1920 (Prohibition era signature)

[0.3.37]: https://github.com/IngressTechnology/jimbomesh-holler-server/compare/v0.3.21...v0.3.37
[0.3.21]: https://github.com/IngressTechnology/jimbomesh-holler-server/compare/v0.3.0...v0.3.21
[0.3.0]: https://github.com/IngressTechnology/jimbomesh-holler-server/compare/v0.2.11...v0.3.0
[0.2.11]: https://github.com/IngressTechnology/jimbomesh-holler-server/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/IngressTechnology/jimbomesh-holler-server/compare/v0.1.0...v0.2.10
[0.1.0]: https://github.com/IngressTechnology/jimbomesh-holler-server/releases/tag/v0.1.0

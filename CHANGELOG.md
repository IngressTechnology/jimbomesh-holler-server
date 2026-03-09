# Changelog

All notable changes to the JimboMesh Holler Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.0]: https://github.com/IngressTechnology/jimbomesh-holler-server/compare/v0.2.11...v0.3.0
[0.2.11]: https://github.com/IngressTechnology/jimbomesh-holler-server/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/IngressTechnology/jimbomesh-holler-server/compare/v0.1.0...v0.2.10
[0.1.0]: https://github.com/IngressTechnology/jimbomesh-holler-server/releases/tag/v0.1.0

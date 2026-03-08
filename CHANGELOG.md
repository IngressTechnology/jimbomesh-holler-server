# Changelog

All notable changes to the JimboMesh Holler Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.11] - 2026-03-08

### Added

#### Features
- **OpenAI-Compatible Chat Completions API** — Drop-in `/v1/chat/completions` endpoint with streaming and non-streaming support, compatible with OpenAI client libraries, LangChain, LlamaIndex, and any tool that speaks OpenAI
- **Model Marketplace** — Browse, search, and pull models from Hugging Face + Ollama directly from the Admin UI with VRAM-aware compatibility badges and real-time SSE download progress
- **Mac Metal GPU Support** — First-class Apple Silicon acceleration with auto-detection, Ollama Metal configuration, and GPU stats reporting in the dashboard
- **Port 1920** — New default gateway port (was 3000). 1920 = the year Prohibition started 🥃. Admin UI at `localhost:1920/admin`
- **IDE Integration Guides** — Step-by-step setup docs for 8 IDEs: VS Code (Continue + Cody), Cursor, Windsurf, JetBrains, Neovim, Emacs, Zed, Warp Terminal
- **Mesh Auto-Reconnect** — Exponential backoff reconnection with ping/pong keepalive on management WebSocket (JIM-392)
- **Smart Concurrency** — Configurable concurrent inference limiting (JIM-394)
- **API Key Separation** — Mesh registration key no longer overwrites local Ollama auth key (JIM-258)
- **Mesh Dashboard Stats** — Connection status, requests served, uptime tracking with tab persistence (URL hash)
- **Auto-Connect Toggle** — Enable/disable automatic mesh connection from Admin UI
- **Swagger Rebrand** — API documentation UI rebranded with JimboMesh theming and terminology
- **Version Badge** — Current Holler version displayed in admin header bar (reads from package.json)
- **Configurable Document Pipeline** — `MAX_UPLOAD_SIZE_MB` and `EMBED_BATCH_SIZE` environment variables with pre-flight file size validation
- **Configurable Ollama Timeout** — `OLLAMA_TIMEOUT_MS` environment variable for mesh fetch calls

#### Kinfolk & Moonshine Economy
- **Moonshine Ledger** — Balance tracking, transaction history, 100K starter balance, auto-reset at 10K floor (JIM-167, JIM-260)
- **Moonshine Pricing Engine** — 2.5x earn multiplier, tiered pricing, job pipeline wiring, ratio tracking (JIM-168, JIM-169, JIM-172, JIM-416)
- **Kinfolk Private Groups** — Create/manage access control groups with member invitations and access requests (JIM-261, JIM-263, JIM-420)
- **Public Pools** — Pool join/leave, qualification requirements, quality scoring (JIM-417, JIM-173)
- **The Still (Full Routing)** — Priority chain: Own → Direct → Kinfolk → Pools → 503. Bounce logic for unavailable Hollers (JIM-430, JIM-395, JIM-419)
- **Email Invitations** — SMTP pipeline with invite templates, accept/decline via token, rate limiting (JIM-263)
- **Economy Admin Controls** — Mint/burn/freeze, circuit breaker, leaderboards, ratio stats (JIM-415, JIM-416)
- **Platform Maintenance** — Dead Holler/User/Kinfolk lifecycle management, ghost detection, orphan cleanup, background runner (JIM-422 epic)
- **CORS Lockdown** — Wildcard CORS removed, identity-based rate limiting (JIM-399, JIM-432)
- **Auth0 M2M Service Account** — Client credentials flow for internal background services (JIM-431)

#### Testing Infrastructure
- **Unit Test Suite** — 41 tests across 3 files using Node.js 22 built-in test runner (`test/db.test.js`, `test/document-pipeline.test.js`, `test/mesh-utils.test.js`)
- **Playwright E2E Test Suite** — 79 UI tests across 18 spec files covering dashboard, model marketplace, playground, settings, navigation, accessibility, theme consistency, responsive layout, error states, performance, and copy-to-clipboard flows
- **Playwright API Tests** — Health, models, chat completions, admin auth, and CORS endpoint coverage
- **CI/CD Pipeline** — `.github/workflows/ci.yml` (lint → unit test → E2E test → Docker build) and `.github/workflows/release.yml` (Docker push on tag)
- **npm test scripts** — `test`, `test:watch`, `test:ui`, `test:api`, `test:e2e`, `test:ui:headed`, `test:ui:debug`

#### Code Quality
- **ESLint + Prettier** — `eslint.config.js` (flat config) + `.prettierrc` with `lint`, `lint:fix`, `format`, `format:check` scripts
- **Architecture Splitting** — Extracted `mesh-utils.js` shared module, `_createAndStartConnector` helper, `readRequestBody` helper
- **Prepared Statement Caching** — `_stmtCache` Map in `db.js` for reused SQL statements
- **Admin UI Accessibility** — ARIA roles on tabs/dialogs/toasts, keyboard navigation (arrow keys, Escape), `prefers-reduced-motion`, `:focus-visible` styles, `.sr-only` utility class, `<noscript>` fallback

### Changed
- **Default port** changed from 3000 to **1920** — update Docker port mappings and bookmarks
- **`var` → `const`/`let`** across entire codebase (modernization pass)
- **GPU detection** converted from `execSync` to async `execFile` — no more blocking the event loop
- **`url.parse()` → `new URL()`** — replaced all 5 deprecated calls with single constant
- **CSS hardcoded colors → CSS variables** — ~12 hex colors replaced with `var(--success)`, `var(--warning)`, `var(--error)`, etc.
- **`var(--text)` → `var(--text-primary)`** — fixed 3 instances in admin styles
- **Duplicate code consolidated** — removed `inferMeshRequestPath` duplicate from `mesh-webrtc.js`, consolidated 3 mesh connector creation blocks into one helper
- **Dockerfile cleaned** — removed duplicate `COPY db.js`, added `COPY mesh-utils.js`
- **`.env.example` expanded** — added JWT/Auth0 Tier 3 section, `TRUST_PROXY`, `OLLAMA_INTERNAL_URL`, coordinator URL precedence notes
- **`setup.ps1` parity** — added `Repair-StatsSchema` function with calls at restart, update, and fresh install paths

### Fixed
- **Mesh disconnect crash** — removed `process.exit` on WebSocket disconnect, graceful handling instead
- **Pong timeout leak** — added `clearTimeout` before setting new timeout in mesh connector
- **`buyerRateLimits` memory leak** — added periodic pruning every 10 min with 2h max age
- **WebSocket close handler** — added close event listener to signaling WebSocket to prevent hanging Promises
- **Fetch timeouts** — added `AbortController` with configurable `OLLAMA_TIMEOUT_MS` to all mesh-webrtc fetch calls
- **API key persistence** — keys persist in SQLite across restarts
- **Mesh registration key overwrite** — separated mesh registration key from local Ollama auth key (JIM-258)

### Security
- **SSRF fix on HuggingFace import** — `POST /admin/api/models/import-hf` now enforces HTTPS + domain allowlist (`huggingface.co`, `*.huggingface.co`, `hf.co`, `*.hf.co`) on initial URL and every redirect hop
- **CORS lockdown** — removed wildcard CORS, added identity-based rate limiting (JIM-399, JIM-432)
- **Auth0 M2M service account** — proper service identity for background services instead of piggybacking user JWTs (JIM-431)
- **npm audit** — 0 vulnerabilities (critical/high/moderate/low all zero)
- **No hardcoded secrets** — verified clean via pattern scan

## [0.1.0] - 2026-02-27

### Added
- Initial alpha release
- Holler server with Ollama proxy
- Admin UI (Express + EJS, dark theme)
- Docker support with GPU passthrough
- Model management (list, pull, delete)
- Health check endpoint
- Setup scripts (`setup.sh`, `setup.ps1`)
- i18n support (EN, DE)
- SQLite database for settings and request logging
- Mesh connector for JimboMesh SaaS (optional)

---

[0.2.10]: https://github.com/IngressTechnology/jimbomesh-holler-server/compare/v0.1.0...v0.2.10
[0.1.0]: https://github.com/IngressTechnology/jimbomesh-holler-server/releases/tag/v0.1.0

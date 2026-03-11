# JimboMesh Holler — Desktop App

Native desktop wrapper for JimboMesh Holler Server using [Tauri 2](https://v2.tauri.app/).

The Tauri webview points at `localhost:1920/admin` — the existing Node.js admin UI. **Zero UI rewrite.** The Rust backend handles system-level concerns: starting Ollama, launching the Holler server, system tray, and graceful shutdown.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 22+ | https://nodejs.org |
| Rust | 1.77+ | https://rustup.rs |
| Ollama | latest | https://ollama.com/download |

**Linux only** — additional system libraries:
```bash
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

## Development

```bash
# From the repo root — start the Holler server first
npm install
npm start

# In another terminal — run the Tauri dev app
cd desktop
npm install
npm run tauri dev
```

The dev webview connects to `http://localhost:1920/admin`. Hot-reload works — edit the admin UI and see changes in the native window.

## Build

```bash
cd desktop
npm run tauri build
```

Outputs platform-specific installers:
- **macOS**: `.dmg` in `src-tauri/target/release/bundle/dmg/`
- **Windows**: `.exe` (NSIS) in `src-tauri/target/release/bundle/nsis/`
- **Linux**: `.AppImage` in `src-tauri/target/release/bundle/appimage/`

## Icons

Placeholder teal icons are included. To generate proper icons from the JimboMesh logo:

```bash
npx @tauri-apps/cli icon ../admin/assets/favicon.svg
```

## Architecture

```
desktop/
├── src-tauri/
│   ├── Cargo.toml          # Rust dependencies
│   ├── tauri.conf.json     # Tauri configuration
│   ├── build.rs            # Tauri build script
│   ├── src/
│   │   ├── main.rs         # App entry, system tray, window management
│   │   ├── process.rs      # Child process lifecycle (Ollama, Holler server)
│   │   └── setup.rs        # First-run experience (keygen, model pull)
│   └── icons/              # App icons (all platforms)
└── package.json            # Tauri CLI dev dependency
```

### What the Rust backend does

1. **Start Ollama** — detects if running, finds the binary, launches `ollama serve`
2. **First-run setup** — generates `.env` with random API key, pulls `llama3.2:1b`
3. **Start Holler** — launches `node api-gateway.js` with the generated config
4. **System tray** — Show/Hide, status indicator, Quit
5. **Graceful shutdown** — kills child processes when the app exits
6. **Minimize to tray** — closing the window hides it instead of quitting

### What the Rust backend does NOT do

- Serve the admin UI (that's the existing Node.js server)
- Manage models (use the admin UI Marketplace tab)
- Handle API requests (that's the Node.js gateway)

## Auto-Update

The app uses `tauri-plugin-updater` for in-app update checks, download, signature verification, and install.

### Signing key setup (one-time)

```bash
# Generate signing keypair (one-time):
npx @tauri-apps/cli signer generate -w ~/.tauri/jimbomesh.key

# This creates:
# ~/.tauri/jimbomesh.key          (PRIVATE — add to GitHub secrets)
# ~/.tauri/jimbomesh.key.pub      (PUBLIC — put in tauri.conf.json pubkey field)
```

Add GitHub repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY` = contents of `~/.tauri/jimbomesh.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = password chosen during key generation

Then update `desktop/src-tauri/tauri.conf.json`:

- Set `plugins.updater.pubkey` to the contents of `~/.tauri/jimbomesh.key.pub`

## CI/CD

Tag pushes (`v*`) trigger the release workflow which builds native installers for macOS (universal), Linux (x64), and Windows (x64) alongside the Docker image. See `.github/workflows/release.yml`.

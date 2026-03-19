#!/bin/bash
#
# JimboMesh Holler Server — On-Prem Embeddings Installer
# Builds and runs the Ollama embedding server via Docker
#
# Usage:
#   ./setup.sh
#   ./setup.sh --gpu --qdrant
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="jimbomesh-still:latest"

# Flags
WITH_GPU=false
CPU_ONLY=false
GPU_FLAG_SET=false
WITH_QDRANT=false
NO_START=false
PULL_ONLY=false

# macOS native Ollama mode: "native" = Performance Mode, "docker" = Secure Mode
OLLAMA_MODE="docker"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --gpu)
            WITH_GPU=true
            GPU_FLAG_SET=true
            shift
            ;;
        --cpu)
            CPU_ONLY=true
            GPU_FLAG_SET=true
            shift
            ;;
        --qdrant)
            WITH_QDRANT=true
            shift
            ;;
        --no-start)
            NO_START=true
            shift
            ;;
        --pull-only)
            PULL_ONLY=true
            shift
            ;;
        --help|-h)
            echo "JimboMesh Holler Server — On-Prem Embeddings Installer"
            echo ""
            echo "Usage: setup.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --gpu             Enable NVIDIA GPU passthrough (skip prompt)"
            echo "  --cpu             Force CPU mode (skip prompt)"
            echo "  --qdrant          Include local Qdrant vector database"
            echo "  --no-start        Don't start services after setup"
            echo "  --pull-only       Only build the image, don't start"
            echo "  --help, -h        Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Functions
print_banner() {
  echo -e "${CYAN}"
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║                                                                  ║"
  echo "║        ⛏️  JIMBOMESH HOLLER SERVER  ⛏️                          ║"
  echo "║        On-Prem AI Embeddings & LLM Service                       ║"
  echo "║                                                                  ║"
  echo "║   ─────────────────────────────────────────────────────────────  ║"
  echo "║                                                                  ║"
  echo "║        🌐  https://jimbomesh.ai                                  ║"
  echo "║                                                                  ║"
  echo "║   ─────────────────────────────────────────────────────────────  ║"
  echo "║                                                                  ║"
  echo "║        Made with ❤️ by Ingress Technology                        ║"
  echo "║        https://ingresstechnology.ai                              ║"
  echo "║                                                                  ║"
  echo "║        🚀 Fractional CTO Services | AI & Cloud Strategy          ║"
  echo "║                                                                  ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  echo -e "${NC}"
}


mask_key() {
    local key="$1"
    if [ ${#key} -gt 12 ]; then
        echo "${key:0:8}...${key: -4}"
    else
        echo "****"
    fi
}

log_step() {
    echo -e "\n${BLUE}▶${NC} ${BOLD}$1${NC}"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

build_image_with_diagnostics() {
    local tmp_output
    tmp_output="$(mktemp -t jimbomesh-build.XXXXXX)"

    if $COMPOSE_CMD build jimbomesh-still >"$tmp_output" 2>&1; then
        cat "$tmp_output"
        rm -f "$tmp_output"
        return 0
    fi

    cat "$tmp_output"

    if grep -qiE 'failed to fetch oauth token|auth\.docker\.io|401 Unauthorized|incorrect username or password' "$tmp_output"; then
        echo ""
        log_error "Docker Hub authentication failed while pulling base image."
        echo "  This usually means cached Docker credentials are stale."
        echo ""
        echo "  Try:"
        echo "    1) docker logout"
        echo "    2) docker login"
        echo "    3) ./setup.sh"
        echo ""
        echo "  If login still fails in Docker Desktop, sign out/in there and retry."
    fi

    rm -f "$tmp_output"
    return 1
}

check_command() {
    if command -v "$1" &> /dev/null; then
        log_success "$1 found"
        return 0
    else
        log_error "$1 not found"
        return 1
    fi
}

show_startup_diagnostics() {
    local service="${1:-jimbomesh-still}"
    echo ""
    log_warning "Startup check timed out. Inspecting recent container logs..."
    local logs
    logs="$(docker logs --tail 120 "$service" 2>&1 || true)"
    if [ -z "$logs" ]; then
        log_warning "Could not read logs. Run: docker logs -f $service"
        return
    fi

    if echo "$logs" | grep -qiE 'SQLITE_READONLY_DIRECTORY|readonly database'; then
        log_error "Detected SQLite permission issue (readonly database)."
        echo -e "  ${YELLOW}Quick fix:${NC}"
        echo -e "    ${CYAN}docker exec jimbomesh-still sh -lc 'chown -R jimbomesh:jimbomesh /opt/jimbomesh-still/data && chmod 775 /opt/jimbomesh-still/data'${NC}"
        echo -e "    ${CYAN}docker compose restart jimbomesh-still${NC}"
    fi

    echo ""
    echo -e "  ${BOLD}Recent ${service} logs:${NC}"
    echo "$logs" | tail -n 25 | sed 's/^/    /'
}

# Ensure legacy SQLite installs have the request_stats.connection_type column.
# This prevents stats writes from failing after mode switches or old upgrades.
repair_stats_schema() {
    local service="jimbomesh-still"
    local node_script

    # Skip if container does not exist yet.
    if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${service}\$"; then
        return 0
    fi

    read -r -d '' node_script <<'EOF' || true
const fs = require('fs');
const initSqlJs = require('sql.js');

function getRow(db, sql, params) {
  const stmt = db.prepare(sql);
  try {
    if (params && params.length) stmt.bind(params);
    if (!stmt.step()) return null;
    return stmt.getAsObject();
  } finally {
    stmt.free();
  }
}

function getRows(db, sql, params) {
  const stmt = db.prepare(sql);
  try {
    if (params && params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

(async function () {
  const SQL = await initSqlJs({
    locateFile: function (file) {
      return require.resolve('sql.js/dist/' + file);
    },
  });
  const dbPath = process.env.SQLITE_DB_PATH || '/opt/jimbomesh-still/data/holler.db';
  const buffer = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  const db = new SQL.Database(buffer || undefined);
  try {
    const table = getRow(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='request_stats'");
    if (!table) {
      console.log('stats-schema:request_stats-missing');
      process.exit(0);
    }
    const cols = getRows(db, "PRAGMA table_info(request_stats)").map(function (r) { return r.name; });
    if (cols.indexOf('connection_type') === -1) {
      db.run('ALTER TABLE request_stats ADD COLUMN connection_type TEXT');
      fs.writeFileSync(dbPath, Buffer.from(db.export()));
      console.log('stats-schema:patched');
    } else {
      console.log('stats-schema:ok');
    }
  } finally {
    db.close();
  }
})().catch(function (err) {
  console.error('stats-schema:error', err.message);
  process.exit(1);
});
EOF

    local result
    result="$(docker exec -i "$service" sh -lc "cd /opt/jimbomesh-still && node -e \"$(printf '%s' "$node_script" | sed 's/"/\\"/g')\"" 2>/dev/null || true)"

    case "$result" in
        *stats-schema:patched*)
            log_success "SQLite stats schema repaired (added request_stats.connection_type)"
            ;;
        *stats-schema:ok*)
            log_success "SQLite stats schema verified"
            ;;
        *stats-schema:request_stats-missing*)
            log_warning "request_stats table not present yet (skipping schema repair)"
            ;;
        *)
            log_warning "Could not verify SQLite stats schema automatically"
            ;;
    esac
}

# ============================================================
# macOS Native Ollama Support (Performance Mode)
# ============================================================

# Show security warning + P/S/? mode selection.
# Sets OLLAMA_MODE="native" or "docker".
show_mac_mode_prompt() {
    local arch="$1"
    echo ""
    echo -e "${YELLOW}⚠️  SECURITY NOTICE — Native Ollama Installation${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "For maximum performance on Apple Silicon, this installer can run"
    echo "Ollama OUTSIDE of Docker directly on your Mac."
    echo ""
    echo "What this means:"
    echo "  • Ollama runs as YOUR user account (not containerized)"
    echo "  • Models are stored at ~/.ollama/models (host filesystem)"
    echo "  • Ollama listens on localhost:11434 (local only by default)"
    echo "  • Ollama starts automatically on boot via launchd"
    echo "  • No container isolation — a compromised model has host-level access"
    echo ""
    echo "Recommendations:"
    echo -e "  ${GREEN}✅ Safe for personal/development use on a private machine${NC}"
    echo -e "  ${GREEN}✅ Safe on a dedicated Holler node you control${NC}"
    echo -e "  ${YELLOW}⚠️  Not recommended for shared/multi-user machines${NC}"
    echo -e "  ${YELLOW}⚠️  Not recommended for production servers exposed to the internet${NC}"
    echo -e "  ${RED}❌ Never change Ollama's bind address to 0.0.0.0 (exposes to network)${NC}"
    echo ""
    echo "Only download models from trusted sources (Ollama Library, HuggingFace"
    echo "verified publishers). Untrusted GGUF files run with your user permissions."
    echo ""
    echo "Choose your installation mode:"
    echo ""
    if [ "$arch" = "arm64" ]; then
        echo -e "  ${GREEN}[P]${NC} Performance Mode — Native Ollama with Metal GPU ${BOLD}(recommended for personal use)${NC}"
    else
        echo -e "  ${GREEN}[P]${NC} Performance Mode — Native Ollama (Intel Mac — faster than Docker CPU)"
    fi
    echo -e "  ${YELLOW}[S]${NC} Secure Mode       — Docker-only, CPU mode (fully containerized, slower but isolated)"
    echo -e "  ${CYAN}[?]${NC} Learn more (opens documentation)"
    echo ""
    while true; do
        read -r -p "  Your choice [P/S/?] (default: P): " mac_choice
        mac_choice="${mac_choice:-P}"
        mac_choice="$(echo "$mac_choice" | tr '[:lower:]' '[:upper:]')"
        case "$mac_choice" in
            P)
                OLLAMA_MODE="native"
                log_success "Performance Mode selected"
                return 0
                ;;
            S)
                OLLAMA_MODE="docker"
                log_success "Secure Mode selected"
                return 0
                ;;
            "?")
                local docs_url="https://jimbomesh.ai/docs/mac-setup-security"
                echo ""
                echo -e "  Opening: ${CYAN}$docs_url${NC}"
                command -v open &> /dev/null && open "$docs_url" 2>/dev/null || true
                echo ""
                echo "  Key points:"
                echo "  • Performance Mode uses Apple's Metal GPU via native Ollama"
                echo "  • Secure Mode is fully containerized (CPU-only, slower but isolated)"
                echo "  • You can switch modes by re-running ./setup.sh"
                echo "  • Native Ollama binds to localhost only — safe for personal use"
                echo "  • Model files live at ~/.ollama and are user-owned"
                echo ""
                ;;
            *)
                echo -e "  ${RED}Invalid choice.${NC} Please enter P, S, or ?"
                ;;
        esac
    done
}

# Ensure Homebrew is installed; falls back to Secure Mode if user declines.
check_homebrew() {
    if command -v brew &> /dev/null; then
        log_success "Homebrew found"
        return 0
    fi
    echo ""
    log_warning "Homebrew is not installed (required for native Ollama)"
    echo ""
    read -r -p "  Install Homebrew now? [Y/n] (default: Y): " brew_choice
    if [ -z "$brew_choice" ] || echo "$brew_choice" | grep -qi '^y'; then
        log_step "Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Apple Silicon: brew lands in /opt/homebrew
        if [ -f /opt/homebrew/bin/brew ]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        fi
        if command -v brew &> /dev/null; then
            log_success "Homebrew installed"
            return 0
        else
            log_error "Homebrew installation failed"
            return 1
        fi
    else
        log_warning "Homebrew declined — falling back to Secure Mode (Docker)"
        OLLAMA_MODE="docker"
        return 1
    fi
}

# Install native Ollama via Homebrew, start service, verify binding.
setup_native_ollama_mac() {
    log_step "Setting up native Ollama on macOS..."

    check_homebrew || return 1

    # Install or verify Ollama
    if brew list ollama &> /dev/null 2>&1; then
        log_success "Ollama already installed via Homebrew"
    else
        log_step "Installing Ollama via Homebrew..."
        brew install ollama
        log_success "Ollama installed"
    fi

    # Warn if user has OLLAMA_HOST bound to all interfaces
    if [ "${OLLAMA_HOST}" = "0.0.0.0:11434" ] || [ "${OLLAMA_HOST}" = "0.0.0.0" ]; then
        echo ""
        echo -e "  ${RED}❌ SECURITY RISK: Your shell has OLLAMA_HOST=0.0.0.0${NC}"
        echo -e "  ${YELLOW}Please update your shell profile (.zshrc / .bash_profile):${NC}"
        echo -e "  ${CYAN}  export OLLAMA_HOST=127.0.0.1:11434${NC}  (or remove the variable)"
        echo ""
    fi

    # Start or confirm Ollama service
    if brew services list 2>/dev/null | grep -q "^ollama.*started"; then
        log_success "Ollama service is already running"
    else
        log_step "Starting Ollama service (launchd)..."
        brew services start ollama
    fi

    # Wait for Ollama to respond (max 30 seconds)
    echo -n "  Waiting for Ollama"
    local ollama_ready=false
    for i in $(seq 1 15); do
        if curl -sf http://localhost:11434/api/version > /dev/null 2>&1; then
            ollama_ready=true
            break
        fi
        echo -n "."
        sleep 2
    done
    echo ""

    if [ "$ollama_ready" = false ]; then
        log_warning "Ollama didn't respond within 30s — it may still be starting"
        echo -e "  Check:  brew services list | grep ollama"
        echo -e "  Logs:   tail -f ~/.ollama/logs/server.log"
    else
        log_success "Ollama is ready at http://localhost:11434"
    fi

    # Post-start: verify not bound to 0.0.0.0
    if command -v lsof &> /dev/null; then
        local bind_check
        bind_check=$(lsof -iTCP:11434 -sTCP:LISTEN 2>/dev/null | grep -v '127\.0\.0\.1\|::1\|localhost\|COMMAND' || true)
        if [ -n "$bind_check" ]; then
            echo ""
            echo -e "  ${RED}⚠️  WARNING: Ollama appears to be listening on a non-localhost interface!${NC}"
            echo "$bind_check"
            echo ""
            echo -e "  ${YELLOW}To restrict to localhost, add to your shell profile:${NC}"
            echo -e "  ${CYAN}    export OLLAMA_HOST=127.0.0.1:11434${NC}"
            echo ""
        else
            log_success "Ollama bind address: localhost only (secure ✅)"
        fi
    fi

    # Harden model directory permissions
    if [ -d "$HOME/.ollama" ]; then
        chmod 700 "$HOME/.ollama" 2>/dev/null || true
        log_success "Model directory hardened: ~/.ollama (permissions 700)"
    fi

    # Display chip/memory info
    echo ""
    echo -e "  ${BOLD}System:${NC}"
    if [ "$(uname -m)" = "arm64" ]; then
        local chip_info mem_info
        chip_info=$(system_profiler SPHardwareDataType 2>/dev/null | grep "Chip:" | sed 's/.*Chip: //' | xargs)
        mem_info=$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f GB", $1/1024/1024/1024}')
        [ -n "$chip_info" ] && echo -e "  Chip:   ${GREEN}$chip_info${NC}"
        [ -n "$mem_info" ] && echo -e "  Memory: ${GREEN}$mem_info${NC} (unified, fully available to Ollama)"
        echo -e "  GPU:    ${GREEN}Apple Metal — enabled via native Ollama${NC}"
    else
        local cpu_info
        cpu_info=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Intel Mac")
        echo -e "  CPU:    ${GREEN}$cpu_info${NC}"
        echo -e "  GPU:    ${YELLOW}Intel Mac — native process, faster than Docker CPU${NC}"
    fi
    echo ""
}

# Write docker-compose.mac.yml to the project directory.
generate_mac_compose() {
    local mac_compose="$SCRIPT_DIR/docker-compose.mac.yml"
    cat > "$mac_compose" << 'COMPOSE_EOF'
# JimboMesh Holler Server — macOS Native Ollama Overlay
#
# Configures the API gateway to use Ollama running natively on the host
# (for Metal GPU acceleration on Apple Silicon) instead of the bundled
# internal Ollama inside the container.
#
# Generated by setup.sh — do not edit directly.
# To switch modes: re-run ./setup.sh
#
# Applied via: COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml
# Host gateway port is managed in .env via OLLAMA_HOST_PORT.
# In Performance Mode setup.sh defaults OLLAMA_HOST_PORT=1920.
# No collision with native Ollama on localhost:11434.

services:
  jimbomesh-still:
    environment:
      # Route gateway requests to host's native Ollama (Metal GPU)
      - OLLAMA_EXTERNAL_URL=http://host.docker.internal:11434
      # Host total memory (MB) for accurate Metal/unified memory reporting
      - HOST_TOTAL_MEMORY_MB=${HOST_TOTAL_MEMORY_MB:-}
      # Container gateway still listens on 1920 internally.
      - GATEWAY_PORT=1920
    extra_hosts:
      - "host.docker.internal:host-gateway"
COMPOSE_EOF
    log_success "Mac compose overlay written: docker-compose.mac.yml"
}

# Pull models via the host's native Ollama CLI.
pull_host_models() {
    local models_str="$1"
    [ -z "$models_str" ] && models_str="nomic-embed-text,llama3.1:8b"
    log_step "Pulling models on host Ollama..."
    IFS=',' read -ra MODEL_LIST <<< "$models_str"
    for model in "${MODEL_LIST[@]}"; do
        model="$(echo "$model" | xargs)"
        [ -z "$model" ] && continue
        echo -e "  Pulling ${CYAN}${model}${NC}..."
        ollama pull "$model" || log_warning "Could not pull $model — retry with: ollama pull $model"
    done
    log_success "Model pull complete"
}

# Record the installation choice for reference.
write_setup_config() {
    local mode="$1"
    local config_file="$SCRIPT_DIR/.setup-config.json"
    local timestamp
    timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")"
    cat > "$config_file" << EOF
{
  "ollamaMode": "${mode}",
  "installedAt": "${timestamp}",
  "securityWarningAccepted": true,
  "platform": "darwin",
  "arch": "$(uname -m)"
}
EOF
    log_success "Setup config saved: .setup-config.json"
}

# Write a cleanup guide for removing native Ollama later.
write_uninstall_guide() {
    cat > "$SCRIPT_DIR/UNINSTALL-OLLAMA.md" << 'UNINSTALL_EOF'
# Uninstalling Native Ollama (Performance Mode)

If you installed Ollama natively via `setup.sh` Performance Mode, follow
these steps to cleanly remove it and switch back to Docker-only (Secure Mode).

## Step 1 — Stop Ollama Service

```bash
brew services stop ollama
```

## Step 2 — Uninstall Ollama

```bash
brew uninstall ollama
```

## Step 3 — Remove Model Files (optional)

This permanently deletes all downloaded models (~2–20 GB):

```bash
rm -rf ~/.ollama
```

## Step 4 — Switch Holler Server to Secure Mode

Edit `.env` and remove or comment out the mac overlay line:

```
# COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml
```

Or re-run the installer and choose **Secure Mode**:

```bash
./setup.sh
```

## Step 5 — Restart Holler Server

```bash
docker compose down
docker compose up -d
```

---

## Checking Ollama Status

```bash
brew services list | grep ollama         # service status
tail -f ~/.ollama/logs/server.log        # live logs
curl http://localhost:11434/api/tags     # API health check
```

## Security Notes

- Native Ollama runs as your user account — keep `OLLAMA_HOST` unset or `127.0.0.1:11434`
- Never set `OLLAMA_HOST=0.0.0.0` — this exposes Ollama to your network
- Only pull models from trusted sources (ollama.com, HuggingFace verified publishers)
UNINSTALL_EOF
    log_success "Uninstall guide written: UNINSTALL-OLLAMA.md"
}

# Banner shown after Performance Mode startup.
show_mac_performance_summary() {
    local arch="$1"
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  ✅ Performance Mode — Native Ollama Active${NC}"
    if [ "$arch" = "arm64" ]; then
        echo -e "${GREEN}     Metal GPU Acceleration Enabled${NC}"
    fi
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    if [ "$arch" = "arm64" ]; then
        local chip_info mem_info
        chip_info=$(system_profiler SPHardwareDataType 2>/dev/null | grep "Chip:" | sed 's/.*Chip: //' | xargs)
        mem_info=$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f GB", $1/1024/1024/1024}')
        echo -e "  🍎 ${BOLD}Apple Silicon${NC}"
        [ -n "$chip_info" ] && echo -e "     Chip:           ${GREEN}$chip_info${NC}"
        [ -n "$mem_info" ]  && echo -e "     Unified Memory: ${GREEN}$mem_info${NC} available to Ollama"
    else
        local cpu_info
        cpu_info=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Intel Mac")
        echo -e "  💻 ${BOLD}Intel Mac${NC}"
        echo -e "     CPU: ${GREEN}$cpu_info${NC}"
    fi
    echo ""
    if [ "$arch" = "arm64" ]; then
        echo -e "  Ollama:    ${GREEN}Native host process (Metal GPU)${NC} — ~4–5× faster than Docker"
    else
        echo -e "  Ollama:    ${GREEN}Native host process${NC} — faster than Docker CPU mode"
    fi
    echo -e "  Bind:      ${GREEN}localhost:11434 only ✅${NC}"
    echo -e "  Models:    ${GREEN}~/.ollama/models${NC}"
    echo -e "  Auto-boot: ${GREEN}launchd via brew services${NC}"
    echo ""
    echo -e "  📦 ${BOLD}Docker Containers:${NC}"
    echo -e "     • jimbomesh-still (JimboMesh API Gateway + Admin Panel)"
    if [ "$WITH_QDRANT" = true ]; then
        echo -e "     • jimbomesh-holler-qdrant (Vector Database)"
    fi
    echo ""
    echo -e "  🔒 ${BOLD}Security:${NC}"
    echo -e "     • Ollama bound to localhost only"
    echo -e "     • To stop:      ${CYAN}brew services stop ollama${NC}"
    echo -e "     • To uninstall: see ${CYAN}UNINSTALL-OLLAMA.md${NC}"
    echo ""
}

# Advisory shown when user chooses Secure (Docker) Mode on macOS.
show_mac_secure_notice() {
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  ✅ Secure Mode — Fully Containerized${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  🐳 Everything runs inside Docker (fully isolated)"
    echo -e "  ${YELLOW}⚠️  Ollama is in CPU-only mode (no Metal GPU access from Docker)${NC}"
    echo -e "  💡 Expected performance: ~5–8 tokens/sec for 7B models"
    echo -e "     (vs ~30–40 tokens/sec with native Metal GPU)"
    echo ""
    echo -e "  💡 ${BOLD}Tips for better performance in Docker:${NC}"
    echo -e "     • Increase Docker Desktop RAM to 24 GB:"
    echo -e "       Docker Desktop → Settings → Resources → Memory"
    echo -e "     • Use smaller models (3B or less) for faster responses"
    echo ""
    echo -e "  To switch to Performance Mode later: ${CYAN}./setup.sh${NC}"
    echo ""
}

# ============================================================
# Cross-platform sed in-place edit (GNU/BSD)
sed_inplace() {
    local expr="$1"
    local file="$2"
    if [ "$(uname -s)" = "Darwin" ]; then
        sed -i '' "$expr" "$file"
    else
        sed -i "$expr" "$file"
    fi
}

# Upsert KEY=VALUE in an env-style file.
set_env_var() {
    local file="$1"
    local key="$2"
    local value="$3"
    local assignment="${key}=${value}"
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        sed_inplace "s|^${key}=.*|${assignment}|" "$file"
    elif grep -q "^# *${key}=" "$file" 2>/dev/null; then
        sed_inplace "s|^# *${key}=.*|${assignment}|" "$file"
    else
        echo "$assignment" >> "$file"
    fi
}

get_env_var() {
    local file="$1"
    local key="$2"
    local value
    value=$(grep "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2-)
    echo "$value"
}

# Early compose command detection (for install menu before full prereq check)
if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
else
    COMPOSE_CMD=""
fi

run_nuclear_reset() {
    local compose_cmd="$COMPOSE_CMD"

    echo ""
    echo -e "${RED}☢️  NUCLEAR OPTION${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━${NC}"
    echo "This will DESTROY:"
    echo "  • All Docker containers and images"
    echo "  • All volumes and cached data"
    echo "  • All configuration files (.env, config)"
    echo "  • SQLite databases"
    echo "  • node_modules/"
    echo "  • All Holler registration data"
    echo ""
    echo "This will KEEP:"
    echo "  • Downloaded Ollama models (expensive to re-download)"
    echo "  • The source code / repo itself"
    echo ""
    echo -e "${YELLOW}⚠️  This action cannot be undone.${NC}"
    echo ""
    read -r -p "Type NUCLEAR to confirm: " nuclear_confirm
    if [ "$nuclear_confirm" != "NUCLEAR" ]; then
        echo ""
        echo "Aborted. Nothing was changed."
        echo ""
        return 1
    fi

    # Phase 1
    echo ""
    echo "[☢️] Stopping all containers..."
    cd "$SCRIPT_DIR"
    if [ -n "$compose_cmd" ]; then
        $compose_cmd down --remove-orphans >/dev/null 2>&1 || true
    fi
    pkill -f "api-gateway.js|jimbomesh|holler" >/dev/null 2>&1 || true

    # Phase 2
    echo "[☢️] Removing Docker images and volumes..."
    local project_network="jimbomesh-holler_default"
    local row cid cname cimage
    while IFS= read -r row; do
        [ -z "$row" ] && continue
        cid="$(echo "$row" | awk '{print $1}')"
        cname="$(echo "$row" | awk '{print $2}')"
        cimage="$(echo "$row" | awk '{print $3}')"
        if echo "$cname $cimage" | grep -qi 'ollama'; then
            continue
        fi
        docker stop "$cid" >/dev/null 2>&1 || true
        docker rm -f "$cid" >/dev/null 2>&1 || true
    done < <(docker ps -a --filter "network=${project_network}" --format '{{.ID}} {{.Names}} {{.Image}}' 2>/dev/null || true)
    docker network rm "$project_network" >/dev/null 2>&1 || true

    local ollama_volumes
    local keep_list=""
    ollama_volumes="$(docker volume ls --format '{{.Name}}' | grep -i 'ollama' || true)"
    if [ -n "$ollama_volumes" ]; then
        while IFS= read -r v; do
            [ -z "$v" ] && continue
            keep_list="${keep_list} ${v}"
        done <<< "$ollama_volumes"
    fi

    if [ -n "$compose_cmd" ]; then
        $compose_cmd down --remove-orphans --rmi local >/dev/null 2>&1 || true
    fi

    local volume
    while IFS= read -r volume; do
        [ -z "$volume" ] && continue
        if echo "$volume" | grep -qi 'ollama'; then
            continue
        fi
        if echo "$volume" | grep -qiE 'jimbomesh|holler'; then
            docker volume rm "$volume" >/dev/null 2>&1 || true
        fi
    done < <(docker volume ls --format '{{.Name}}')

    local image_id
    while IFS= read -r image_id; do
        [ -z "$image_id" ] && continue
        docker rmi -f "$image_id" >/dev/null 2>&1 || true
    done < <(docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -iE 'jimbomesh|holler' | grep -vi 'ollama' | awk '{print $2}' | sort -u)

    # Phase 3
    echo "[☢️] Wiping data and configuration..."
    rm -rf "$SCRIPT_DIR/data" "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/logs" "$SCRIPT_DIR/tmp" "$SCRIPT_DIR/temp" "$SCRIPT_DIR/.cache" "$SCRIPT_DIR/.tmp"
    rm -f "$SCRIPT_DIR/.env" "$SCRIPT_DIR/.setup-config.json"
    rm -f "$SCRIPT_DIR"/*.lock
    # Keep package-lock.json when possible to avoid unnecessary local/npm lockfile regeneration.
    rm -f "$SCRIPT_DIR/yarn.lock" "$SCRIPT_DIR/pnpm-lock.yaml" "$SCRIPT_DIR/bun.lockb"

    log_success "Nuclear cleanup complete. Starting fresh install..."
    echo ""
    return 0
}

# Main
print_banner

# Detect existing installation
EXISTING_INSTALL=false
CONTAINER_RUNNING=false
CONTAINER_EXISTS=false
IMAGE_EXISTS=false

CONTAINER_STATUS=$(docker ps -a --filter "name=jimbomesh-still" --format "{{.Status}}" 2>/dev/null || true)
if [ -n "$CONTAINER_STATUS" ]; then
    EXISTING_INSTALL=true
    CONTAINER_EXISTS=true
    echo "$CONTAINER_STATUS" | grep -qi "^Up" && CONTAINER_RUNNING=true
fi

IMAGE_ID=$(docker images "jimbomesh-still:latest" --format "{{.ID}}" 2>/dev/null || true)
if [ -n "$IMAGE_ID" ]; then
    EXISTING_INSTALL=true
    IMAGE_EXISTS=true
fi

[ -f "$SCRIPT_DIR/.env" ] && EXISTING_INSTALL=true

if [ "$EXISTING_INSTALL" = true ] && [ "$PULL_ONLY" = false ]; then
    echo -e "  ${YELLOW}Existing installation detected!${NC}"
    echo ""
    if [ "$CONTAINER_RUNNING" = true ]; then
        echo -e "  Container: ${GREEN}running${NC}"
    elif [ "$CONTAINER_EXISTS" = true ]; then
        echo -e "  Container: ${YELLOW}stopped${NC}"
    fi
    [ "$IMAGE_EXISTS" = true ] && echo -e "  Image:     jimbomesh-still:latest"
    [ -f "$SCRIPT_DIR/.env" ] && echo -e "  Config:    .env found"
    echo ""
    echo -e "  ${BOLD}What would you like to do?${NC}"
    echo ""
    echo -e "  ${CYAN}1) Update${NC}        — Rebuild image + restart (keeps models & data)"
    echo -e "  ${CYAN}2) Restart${NC}       — Just restart services (no rebuild)"
    echo -e "  ${CYAN}3) Reconfigure${NC}   — Re-run setup prompts (GPU, Qdrant) + rebuild"
    echo -e "  ${CYAN}4) Stop${NC}          — Shut down all services"
    echo -e "  ${CYAN}5) Quick Start${NC}   — Continue with guided setup"
    echo -e "  ${RED}6) Uninstall${NC}     — Remove containers, images, volumes, and config"
    echo -e "  ${RED}7) ☢️  Nuclear   - Wipe EVERYTHING and start fresh (keeps Ollama models)${NC}"
    echo -e "  ${CYAN}8) Cancel${NC}        — Exit without changes"
    echo ""
    read -r -p "  Choose [1-8] (default: 1): " install_choice
    install_choice="${install_choice:-1}"

    case "$install_choice" in
        2)
            log_step "Restarting services..."
            cd "$SCRIPT_DIR"
            $COMPOSE_CMD restart jimbomesh-still 2>/dev/null || $COMPOSE_CMD up -d
            repair_stats_schema
            log_success "Services restarted!"
            echo ""
            echo -e "  ${CYAN}Admin UI:${NC}   http://localhost:1920/admin"
            echo -e "  ${CYAN}Logs:${NC}       docker logs -f jimbomesh-still"
            echo ""
            exit 0
            ;;
        4)
            log_step "Stopping services..."
            cd "$SCRIPT_DIR"
            $COMPOSE_CMD down
            log_success "All services stopped."
            echo ""
            exit 0
            ;;
        6)
            echo ""
            echo -e "  ${RED}WARNING: This will permanently remove:${NC}"
            echo -e "  ${RED}  - All Docker containers (jimbomesh-still, qdrant)${NC}"
            echo -e "  ${RED}  - All Docker volumes (downloaded models, SQLite data, Qdrant storage)${NC}"
            echo -e "  ${RED}  - The Docker image (jimbomesh-still:latest)${NC}"
            echo -e "  ${RED}  - The .env configuration file${NC}"
            if [ "$OS_TYPE" = "Darwin" ] && [ -f "$SCRIPT_DIR/.setup-config.json" ]; then
                grep -q '"ollamaMode": "native"' "$SCRIPT_DIR/.setup-config.json" 2>/dev/null && \
                    echo -e "  ${RED}  - NOTE: Native Ollama (Homebrew) is NOT removed — see UNINSTALL-OLLAMA.md${NC}"
            fi
            echo ""
            read -r -p "  Type 'uninstall' to confirm: " uninstall_confirm
            if [ "$uninstall_confirm" != "uninstall" ]; then
                echo ""
                echo -e "  ${YELLOW}Uninstall cancelled.${NC}"
                echo ""
                exit 0
            fi
            echo ""
            log_step "Stopping and removing containers + volumes..."
            cd "$SCRIPT_DIR"
            $COMPOSE_CMD --profile qdrant down -v
            
            log_step "Removing Docker image..."
            if docker rmi "$IMAGE_NAME" 2>/dev/null; then
                log_success "Image removed: $IMAGE_NAME"
            else
                log_warning "Image not found or already removed"
            fi

            log_step "Removing configuration files..."
            for f in .env .setup-config.json; do
                if [ -f "$SCRIPT_DIR/$f" ]; then
                    rm -f "$SCRIPT_DIR/$f"
                    log_success "Removed $f"
                fi
            done

            echo ""
            log_success "JimboMesh Holler Server has been uninstalled."
            echo ""
            echo -e "  ${YELLOW}The source code in $SCRIPT_DIR is still intact.${NC}"
            echo -e "  ${YELLOW}To reinstall, run: ./setup.sh${NC}"
            if [ "$OS_TYPE" = "Darwin" ]; then
                echo -e "  ${YELLOW}To remove native Ollama: see UNINSTALL-OLLAMA.md${NC}"
            fi
            echo ""
            exit 0
            ;;
        7)
            if ! run_nuclear_reset; then
                exit 0
            fi
            # Treat post-nuclear state like a first-time install and continue below.
            EXISTING_INSTALL=false
            CONTAINER_RUNNING=false
            CONTAINER_EXISTS=false
            IMAGE_EXISTS=false
            WITH_GPU=false
            CPU_ONLY=false
            WITH_QDRANT=false
            ;;
        8)
            echo ""
            echo -e "  ${YELLOW}No changes made.${NC}"
            echo ""
            exit 0
            ;;
        5)
            log_step "Running guided quick start setup..."
            ;;
        3)
            echo ""
            log_step "Stopping current services..."
            cd "$SCRIPT_DIR"
            $COMPOSE_CMD down
            log_success "Services stopped. Re-running full setup (models & data on Docker volumes are preserved)..."
            ;;
        *)
            log_step "Updating — rebuilding image..."
            cd "$SCRIPT_DIR"
            $COMPOSE_CMD build jimbomesh-still
            log_success "Image rebuilt!"
            log_step "Restarting with updated code..."
            $COMPOSE_CMD up -d --force-recreate --no-deps jimbomesh-still
            repair_stats_schema
            log_success "Update complete! Models and data preserved."
            echo ""

            CONNECT_KEY=""
            if [ -f "$SCRIPT_DIR/.env" ]; then
                CONNECT_KEY=$(grep '^JIMBOMESH_HOLLER_API_KEY=' "$SCRIPT_DIR/.env" | head -1 | cut -d= -f2-)
            fi
            if [ -n "$CONNECT_KEY" ]; then
                echo -e "  ${BOLD}Connect:${NC} http://localhost:1920/admin#key=${CONNECT_KEY}"
            fi
            echo -e "  ${CYAN}Logs:${NC}    docker logs -f jimbomesh-still"
            echo ""
            exit 0
            ;;
    esac
fi

log_step "Checking prerequisites..."

# Check Docker
if ! check_command docker; then
    echo -e "\n${RED}Docker is required but not installed.${NC}"
    echo "Install Docker: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check Docker Compose
if docker compose version &> /dev/null; then
    log_success "Docker Compose found (plugin)"
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
    log_success "Docker Compose found (standalone)"
    COMPOSE_CMD="docker-compose"
else
    log_error "Docker Compose not found"
    echo -e "\n${RED}Docker Compose is required but not installed.${NC}"
    echo "Install Docker Compose: https://docs.docker.com/compose/install/"
    exit 1
fi

# Check Docker is running
DOCKER_INFO_OUTPUT=$(docker info 2>&1)
DOCKER_INFO_EXIT=$?

if [ $DOCKER_INFO_EXIT -ne 0 ]; then
    log_error "Docker is not running or you don't have permission to access it"
    if [ "$(id -u)" -ne 0 ] && echo "$DOCKER_INFO_OUTPUT" | grep -qi "permission denied"; then
        echo -e "\n${YELLOW}Tip: Add your user to the docker group:${NC}"
        echo -e "  ${CYAN}sudo usermod -aG docker \$USER${NC}"
        echo -e "  ${CYAN}(then log out and log back in)${NC}"
    else
        echo -e "\n${RED}Please start Docker and try again.${NC}"
    fi
    exit 1
fi
log_success "Docker is running"

# GPU detection and interactive prompt
OS_TYPE="$(uname -s)"
HAS_NVIDIA=false
if command -v nvidia-smi &> /dev/null && nvidia-smi &> /dev/null; then
    HAS_NVIDIA=true
fi

if [ "$GPU_FLAG_SET" = false ]; then
    if [ "$OS_TYPE" = "Darwin" ]; then
        # macOS: show security warning and let user choose Performance vs Secure mode.
        # --cpu flag (CPU_ONLY=true) bypasses the prompt and uses Secure Mode.
        if [ "$CPU_ONLY" = true ]; then
            OLLAMA_MODE="docker"
            echo ""
            log_warning "macOS + --cpu: Secure Mode (Docker CPU) selected"
            echo -e "  ${YELLOW}Metal GPU acceleration not available in this mode.${NC}"
            echo ""
        else
            MAC_ARCH="$(uname -m)"
            show_mac_mode_prompt "$MAC_ARCH"
        fi
    elif [ "$HAS_NVIDIA" = true ]; then
        log_success "NVIDIA GPU detected"
        echo ""
        echo -e "  GPU mode is recommended for much faster inference."
        echo -e "  Requires: NVIDIA Container Toolkit"
        echo ""
        read -r -p "  Enable GPU acceleration? [Y/n] (default: Y): " gpu_choice
        if [ -z "$gpu_choice" ] || echo "$gpu_choice" | grep -qi '^y'; then
            WITH_GPU=true
            log_success "GPU mode selected"
        else
            echo -e "  ${YELLOW}CPU mode selected${NC}"
        fi
    else
        log_warning "No NVIDIA GPU detected (nvidia-smi not found or failed)"
        echo ""
        echo -e "  GPU acceleration requires an NVIDIA GPU + Container Toolkit."
        echo -e "  Install: ${CYAN}https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/${NC}"
        echo ""
        read -r -p "  Enable GPU mode anyway? [y/N] (default: N): " gpu_choice
        if echo "$gpu_choice" | grep -qi '^y'; then
            WITH_GPU=true
            log_warning "GPU mode selected (no GPU detected — may fail)"
        else
            echo -e "  ${YELLOW}CPU mode selected${NC}"
        fi
    fi
elif [ "$WITH_GPU" = true ]; then
    if [ "$HAS_NVIDIA" = true ]; then
        log_success "NVIDIA GPU detected"
    else
        log_warning "nvidia-smi not found — GPU passthrough may not work"
        echo -e "  Install NVIDIA Container Toolkit: ${CYAN}https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/${NC}"
    fi
fi

# Qdrant interactive prompt
if [ "$WITH_QDRANT" = false ]; then
    echo ""
    echo -e "  Qdrant is a local vector database for storing embeddings."
    echo -e "  Required if you plan to use RAG (retrieval-augmented generation)."
    echo -e "  Skip if you only need the LLM and embedding API."
    echo ""
    read -r -p "  Include Qdrant vector database? [Y/n] (default: Y): " qdrant_choice
    if [ -z "$qdrant_choice" ] || echo "$qdrant_choice" | grep -qi '^y'; then
        WITH_QDRANT=true
        log_success "Qdrant enabled"
    else
        echo -e "  ${YELLOW}Qdrant skipped (can add later with: ./setup.sh --qdrant)${NC}"
    fi
fi

# Create .env if it doesn't exist
log_step "Checking configuration..."
if [ ! -f "$SCRIPT_DIR/.env" ]; then
    if [ -f "$SCRIPT_DIR/.env.example" ]; then
        cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
        log_success "Created .env from .env.example"
    else
        log_warning "No .env file found — using defaults"
    fi
else
    log_success "Existing .env found — preserving your configuration"
    echo -e "  ${YELLOW}To start fresh, delete .env and run setup again${NC}"
fi

# Auto-generate HOLLER_SERVER_NAME only when unset/commented/empty/default placeholder.
if ! grep -q '^HOLLER_SERVER_NAME=' "$SCRIPT_DIR/.env" || grep -q '^HOLLER_SERVER_NAME=$' "$SCRIPT_DIR/.env" || grep -q '^HOLLER_SERVER_NAME=Holler Server$' "$SCRIPT_DIR/.env" || grep -q '^# *HOLLER_SERVER_NAME=' "$SCRIPT_DIR/.env"; then
    LOCAL_HOSTNAME=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "unknown")
    set_env_var "$SCRIPT_DIR/.env" "HOLLER_SERVER_NAME" "Holler Server $LOCAL_HOSTNAME"
    log_success "Server name set to: Holler Server $LOCAL_HOSTNAME"
fi

# Persist defaults/choices so rebuilds and reinstalls are seamless.
CURRENT_OLLAMA_HOST_PORT=$(get_env_var "$SCRIPT_DIR/.env" "OLLAMA_HOST_PORT")
if [ -z "$CURRENT_OLLAMA_HOST_PORT" ]; then
    CURRENT_OLLAMA_HOST_PORT="1920"
fi
set_env_var "$SCRIPT_DIR/.env" "OLLAMA_HOST_PORT" "$CURRENT_OLLAMA_HOST_PORT"

CURRENT_GATEWAY_PORT=$(get_env_var "$SCRIPT_DIR/.env" "GATEWAY_PORT")
if [ -z "$CURRENT_GATEWAY_PORT" ]; then
    CURRENT_GATEWAY_PORT="1920"
fi
set_env_var "$SCRIPT_DIR/.env" "GATEWAY_PORT" "$CURRENT_GATEWAY_PORT"

CURRENT_MODELS=$(get_env_var "$SCRIPT_DIR/.env" "HOLLER_MODELS")
if [ -z "$CURRENT_MODELS" ]; then
    CURRENT_MODELS="nomic-embed-text,llama3.1:8b"
fi
set_env_var "$SCRIPT_DIR/.env" "HOLLER_MODELS" "$CURRENT_MODELS"

CURRENT_EMBED_MODEL=$(get_env_var "$SCRIPT_DIR/.env" "OLLAMA_EMBED_MODEL")
if [ -z "$CURRENT_EMBED_MODEL" ]; then
    CURRENT_EMBED_MODEL="nomic-embed-text"
fi
set_env_var "$SCRIPT_DIR/.env" "OLLAMA_EMBED_MODEL" "$CURRENT_EMBED_MODEL"

CURRENT_ADMIN_ENABLED=$(get_env_var "$SCRIPT_DIR/.env" "ADMIN_ENABLED")
if [ -z "$CURRENT_ADMIN_ENABLED" ]; then
    CURRENT_ADMIN_ENABLED="true"
fi
set_env_var "$SCRIPT_DIR/.env" "ADMIN_ENABLED" "$CURRENT_ADMIN_ENABLED"

# Default mesh name to hostname unless explicitly set.
CURRENT_MESH_HOLLER_NAME=$(get_env_var "$SCRIPT_DIR/.env" "JIMBOMESH_HOLLER_NAME")
if [ -z "$CURRENT_MESH_HOLLER_NAME" ] || grep -q '^# *JIMBOMESH_HOLLER_NAME=' "$SCRIPT_DIR/.env"; then
    HOSTNAME_DEFAULT=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "unknown")
    set_env_var "$SCRIPT_DIR/.env" "JIMBOMESH_HOLLER_NAME" "$HOSTNAME_DEFAULT"
fi

# Mesh connectivity interactive prompt
echo ""
echo -e "  ${BOLD}Connect to the JimboMesh mesh network?${NC}"
echo -e "  Share your GPU compute and earn Moonshine tokens."
echo -e "  You'll need an API key from ${CYAN}app.jimbomesh.ai${NC}"
echo ""
read -r -p "  Connect to mesh? [y/N] (default: N): " mesh_choice
if echo "$mesh_choice" | grep -qi '^y'; then
    echo ""
    read -r -p "  Mesh URL [https://api.jimbomesh.ai]: " mesh_url
    mesh_url="${mesh_url:-https://api.jimbomesh.ai}"
    read -r -p "  API Key: " mesh_key
    if [ -n "$mesh_key" ]; then
        HOSTNAME_DEFAULT=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "unknown")
        read -r -p "  Holler name (default: $HOSTNAME_DEFAULT): " holler_name
        holler_name="${holler_name:-$HOSTNAME_DEFAULT}"
        set_env_var "$SCRIPT_DIR/.env" "JIMBOMESH_API_KEY" "$mesh_key"
        set_env_var "$SCRIPT_DIR/.env" "JIMBOMESH_MESH_URL" "$mesh_url"
        set_env_var "$SCRIPT_DIR/.env" "JIMBOMESH_HOLLER_NAME" "$holler_name"
        set_env_var "$SCRIPT_DIR/.env" "JIMBOMESH_AUTO_CONNECT" "true"
        log_success "Mesh connectivity configured"
    else
        set_env_var "$SCRIPT_DIR/.env" "JIMBOMESH_AUTO_CONNECT" "false"
        echo -e "  ${YELLOW}No API key entered — mesh skipped${NC}"
    fi
else
    set_env_var "$SCRIPT_DIR/.env" "JIMBOMESH_AUTO_CONNECT" "false"
    echo -e "  ${YELLOW}Mesh skipped (can configure later in Admin UI > Configuration)${NC}"
fi

# macOS Performance Mode: install and start native Ollama before Docker
if [ "$OLLAMA_MODE" = "native" ]; then
    if ! setup_native_ollama_mac; then
        log_warning "Native Ollama setup failed — falling back to Secure Mode (Docker)"
        OLLAMA_MODE="docker"
    fi
fi

if [ "$OLLAMA_MODE" = "native" ]; then
    set_env_var "$SCRIPT_DIR/.env" "HOLLER_PERFORMANCE_MODE" "true"
    if [ "$(uname -s)" = "Darwin" ]; then
        HOST_MEM_BYTES=$(sysctl -n hw.memsize 2>/dev/null || echo "0")
        if [ "$HOST_MEM_BYTES" -gt 0 ] 2>/dev/null; then
            HOST_TOTAL_MEMORY_MB=$((HOST_MEM_BYTES / 1048576))
            set_env_var "$SCRIPT_DIR/.env" "HOST_TOTAL_MEMORY_MB" "$HOST_TOTAL_MEMORY_MB"
            log_success "Host memory detected: ${HOST_TOTAL_MEMORY_MB} MB"
        else
            log_warning "Could not detect host memory via sysctl; falling back to container memory"
        fi
    fi
else
    set_env_var "$SCRIPT_DIR/.env" "HOLLER_PERFORMANCE_MODE" "false"
fi

# macOS Performance Mode: detect host port collision with native Ollama on 11434.
# Default gateway port (1920) does not collide; only warn if explicitly set to 11434.
if [ "$OLLAMA_MODE" = "native" ] && [ -f "$SCRIPT_DIR/.env" ]; then
    CURRENT_OLLAMA_HOST_PORT=$(grep '^OLLAMA_HOST_PORT=' "$SCRIPT_DIR/.env" | head -1 | cut -d= -f2-)
    if [ "$CURRENT_OLLAMA_HOST_PORT" = "11434" ]; then
        set_env_var "$SCRIPT_DIR/.env" "OLLAMA_HOST_PORT" "11435"
        set_env_var "$SCRIPT_DIR/.env" "GATEWAY_PORT" "11435"
        log_success "Performance Mode: moved gateway to localhost:11435 to avoid collision with native Ollama on 11434"
    else
        [ -n "$CURRENT_OLLAMA_HOST_PORT" ] && set_env_var "$SCRIPT_DIR/.env" "GATEWAY_PORT" "$CURRENT_OLLAMA_HOST_PORT"
        log_success "Performance Mode gateway port: localhost:${CURRENT_OLLAMA_HOST_PORT:-1920}"
    fi
fi

# Persist compose selection even when --no-start is used.
if [ "$OLLAMA_MODE" = "native" ]; then
    generate_mac_compose
    set_env_var "$SCRIPT_DIR/.env" "COMPOSE_FILE" "docker-compose.yml:docker-compose.mac.yml"
elif [ "$WITH_GPU" = true ]; then
    set_env_var "$SCRIPT_DIR/.env" "COMPOSE_FILE" "docker-compose.yml:docker-compose.gpu.yml"
else
    set_env_var "$SCRIPT_DIR/.env" "COMPOSE_FILE" "docker-compose.yml"
fi

# Generate API keys if .env still has placeholder values
KEYS_GENERATED=false
if [ -f "$SCRIPT_DIR/.env" ]; then
    if grep -q 'JIMBOMESH_HOLLER_API_KEY=generate_with_openssl_rand_hex_32' "$SCRIPT_DIR/.env"; then
        if command -v openssl &> /dev/null; then
            API_KEY=$(openssl rand -hex 32)
        else
            API_KEY=$(head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n')
        fi
        sed_inplace "s/JIMBOMESH_HOLLER_API_KEY=generate_with_openssl_rand_hex_32/JIMBOMESH_HOLLER_API_KEY=$API_KEY/" "$SCRIPT_DIR/.env"
        KEYS_GENERATED=true
    fi

    if grep -q 'QDRANT_API_KEY=generate_with_openssl_rand_hex_32' "$SCRIPT_DIR/.env"; then
        if command -v openssl &> /dev/null; then
            QDRANT_KEY=$(openssl rand -hex 32)
        else
            QDRANT_KEY=$(head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n')
        fi
        sed_inplace "s/QDRANT_API_KEY=generate_with_openssl_rand_hex_32/QDRANT_API_KEY=$QDRANT_KEY/" "$SCRIPT_DIR/.env"
        KEYS_GENERATED=true
    fi

    if [ "$KEYS_GENERATED" = true ]; then
        log_success "API keys generated"
        echo ""
        echo -e "${YELLOW}================================================================${NC}"
        echo -e "${YELLOW}  YOUR API KEYS (save these — you will need them!):${NC}"
        echo ""
        [ -n "$API_KEY" ] && echo -e "  ${BOLD}JIMBOMESH_HOLLER_API_KEY=${API_KEY}${NC}"
        [ -n "$QDRANT_KEY" ] && echo -e "  ${BOLD}QDRANT_API_KEY=${QDRANT_KEY}${NC}"
        echo ""
        echo -e "${YELLOW}  Use the API key to:${NC}"
        echo -e "${YELLOW}    - Log into the Admin UI at /admin${NC}"
        echo -e "${YELLOW}    - Connect to the Holler Server API (X-API-Key header)${NC}"
        echo -e "${YELLOW}    - Configure JimboMesh embed.sh${NC}"
        echo ""
        echo -e "${YELLOW}  Qdrant key is used for vector database authentication.${NC}"
        echo -e "${YELLOW}  Paste either line directly into .env to update keys.${NC}"
        echo ""
        echo -e "${YELLOW}  Stored in: $SCRIPT_DIR/.env${NC}"
        echo -e "${YELLOW}================================================================${NC}"
    fi
fi

# Build image
if [ ! -f "$SCRIPT_DIR/package-lock.json" ]; then
    log_warning "package-lock.json is missing. Regenerating before Docker build..."
    if command -v npm >/dev/null 2>&1; then
        if ! npm install --package-lock-only --ignore-scripts --no-audit --no-fund; then
            log_error "Failed to regenerate package-lock.json with local npm."
            exit 1
        fi
    else
        log_warning "npm not found locally. Using Docker fallback (node:22-alpine) to regenerate package-lock.json..."
        if ! docker run --rm -v "$SCRIPT_DIR:/workspace" -w /workspace node:22-alpine sh -lc "npm install --package-lock-only --ignore-scripts --no-audit --no-fund"; then
            log_error "Failed to regenerate package-lock.json with Docker fallback."
            exit 1
        fi
    fi
    log_success "package-lock.json regenerated"
fi

log_step "Building JimboMesh Holler Server image..."
cd "$SCRIPT_DIR"
if ! build_image_with_diagnostics; then
    exit 1
fi
log_success "Image built successfully!"

if [ "$PULL_ONLY" = true ]; then
    echo -e "\n${GREEN}Done!${NC} Run the setup script again without --pull-only to start services."
    exit 0
fi

# Start services
if [ "$NO_START" = false ]; then
    log_step "Starting services..."
    cd "$SCRIPT_DIR"

    # COMPOSE_FILE is persisted earlier so choices survive even with --no-start.
    if [ "$OLLAMA_MODE" = "native" ]; then
        echo -e "  ${CYAN}Mac Performance Mode: docker-compose.mac.yml overlay active${NC}"
    elif [ "$WITH_GPU" = true ]; then
        echo -e "  ${CYAN}GPU passthrough enabled (written to .env)${NC}"
    fi

    # Qdrant still uses compose profiles
    PROFILES=""
    if [ "$WITH_QDRANT" = true ]; then
        PROFILES="$PROFILES --profile qdrant"
        echo -e "  ${CYAN}Local Qdrant enabled${NC}"
    fi

    $COMPOSE_CMD $PROFILES up -d

    # Wait for service to be ready
    # Performance Mode: Ollama is on host — poll host port with API key
    # Secure Mode: poll health server (no auth, checks internal Ollama)
    echo -n "Waiting for core services to start"
    ollama_ready=false
    for i in $(seq 1 60); do
        still_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' jimbomesh-still 2>/dev/null || true)"
        if [ "$still_status" = "healthy" ] || [ "$still_status" = "running" ]; then
            ollama_ready=true
            echo ""
            log_success "Core service is running!"
            break
        fi
        echo -n "."
        sleep 2
    done
    if [ "$ollama_ready" = false ]; then
        echo ""
        log_warning "Core service may still be starting. Check logs with: docker logs jimbomesh-still"
        show_startup_diagnostics "jimbomesh-still"
    fi

    # Performance Mode: pull default models on host Ollama
    if [ "$OLLAMA_MODE" = "native" ]; then
        _PULL_MODELS=""
        if [ -f "$SCRIPT_DIR/.env" ]; then
            _PULL_MODELS=$(grep '^HOLLER_MODELS=' "$SCRIPT_DIR/.env" | head -1 | cut -d= -f2-)
        fi
        pull_host_models "$_PULL_MODELS"
    fi

    # Check Qdrant if enabled
    if [ "$WITH_QDRANT" = true ]; then
        echo -n "Waiting for Qdrant to start"
        qdrant_ready=false
        for i in $(seq 1 30); do
            qdrant_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' jimbomesh-holler-qdrant 2>/dev/null || true)"
            if [ "$qdrant_status" = "healthy" ] || [ "$qdrant_status" = "running" ]; then
                qdrant_ready=true
                echo ""
                log_success "Qdrant is running!"
                break
            fi
            echo -n "."
            sleep 1
        done
        if [ "$qdrant_ready" = false ]; then
            echo ""
            log_warning "Qdrant may still be starting. Documents/RAG features may not be ready yet."
        fi
    fi

    # Always self-heal legacy stats schema after startup/reconfigure.
    repair_stats_schema
fi

# Read keys from .env for launch and summary
CONNECT_KEY=""
QDRANT_CONNECT_KEY=""
GATEWAY_HOST_PORT="1920"
if [ -f "$SCRIPT_DIR/.env" ]; then
    CONNECT_KEY=$(grep '^JIMBOMESH_HOLLER_API_KEY=' "$SCRIPT_DIR/.env" | head -1 | cut -d= -f2-)
    QDRANT_CONNECT_KEY=$(grep '^QDRANT_API_KEY=' "$SCRIPT_DIR/.env" | head -1 | cut -d= -f2-)
    _FINAL_PORT=$(grep '^GATEWAY_PORT=' "$SCRIPT_DIR/.env" | head -1 | cut -d= -f2-)
    if [ -z "$_FINAL_PORT" ]; then
        _FINAL_PORT=$(grep '^OLLAMA_HOST_PORT=' "$SCRIPT_DIR/.env" | head -1 | cut -d= -f2-)
    fi
    [ -n "$_FINAL_PORT" ] && GATEWAY_HOST_PORT="$_FINAL_PORT"
fi

# ── Launch Admin UI ──────────────────────────────────────────
echo ""
echo -e "${CYAN}Opening Admin Dashboard...${NC}"
LAUNCH_PORT="${GATEWAY_HOST_PORT:-1920}"
ADMIN_URL="http://localhost:${LAUNCH_PORT}/admin"
if [ -n "$CONNECT_KEY" ]; then
    ADMIN_URL="http://localhost:${LAUNCH_PORT}/admin#key=$CONNECT_KEY"
fi

READY=false
for i in $(seq 1 30); do
    sleep 2
    # Gateway readiness lives at /readyz (and /health as fallback), not /healthz.
    ready_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$LAUNCH_PORT/readyz" 2>/dev/null || true)"
    if [ "$ready_code" = "200" ]; then
        READY=true
        break
    fi
    health_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$LAUNCH_PORT/health" 2>/dev/null || true)"
    if [ "$health_code" = "200" ]; then
        READY=true
        break
    fi
    echo -e "    Waiting for Holler to start... ($((i * 2))s)"
done
open_admin_url() {
    local target_url="$1"
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$target_url" >/dev/null 2>&1 && return 0
    fi
    if command -v open >/dev/null 2>&1; then
        open "$target_url" >/dev/null 2>&1 && return 0
    fi
    if command -v start >/dev/null 2>&1; then
        start "$target_url" >/dev/null 2>&1 && return 0
    fi
    return 1
}

# Quick readiness check (non-blocking)
READY=false
for i in $(seq 0 2); do
    ADMIN_STATUS_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${LAUNCH_PORT}/admin" 2>/dev/null)"
    if [ "$ADMIN_STATUS_CODE" = "200" ] || [ "$ADMIN_STATUS_CODE" = "301" ] || [ "$ADMIN_STATUS_CODE" = "302" ]; then
        READY=true
        break
    fi
    if [ -n "$CONNECT_KEY" ]; then
        STATUS_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $CONNECT_KEY" "http://localhost:${LAUNCH_PORT}/api/tags" 2>/dev/null)"
    else
        STATUS_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${LAUNCH_PORT}/api/tags" 2>/dev/null)"
    fi
    if [ "$STATUS_CODE" = "200" ] || [ "$STATUS_CODE" = "401" ] || [ "$STATUS_CODE" = "403" ]; then
        READY=true
        break
    fi
    [ "$i" -lt 2 ] && sleep 1
done

if open_admin_url "$ADMIN_URL"; then
    echo -e "  ${GREEN}Browser opened!${NC}"
    if [ "$READY" = false ]; then
        echo -e "  ${YELLOW}Holler may still be warming up. If page is blank, refresh in a few seconds.${NC}"
    fi
else
    echo -e "  ${YELLOW}Could not auto-open browser. Open manually:${NC}"
    echo -e "  ${NC}$ADMIN_URL${NC}"
fi

# Persist final mode choices after runtime checks.
if [ -f "$SCRIPT_DIR/.env" ]; then
    if [ "$OLLAMA_MODE" = "native" ]; then
        set_env_var "$SCRIPT_DIR/.env" "HOLLER_PERFORMANCE_MODE" "true"
    else
        set_env_var "$SCRIPT_DIR/.env" "HOLLER_PERFORMANCE_MODE" "false"
    fi
fi

# macOS: write persistent artifacts and show mode-specific banner
if [ "$OS_TYPE" = "Darwin" ]; then
    write_setup_config "$OLLAMA_MODE"
    if [ "$OLLAMA_MODE" = "native" ]; then
        write_uninstall_guide
        show_mac_performance_summary "$(uname -m)"
    else
        show_mac_secure_notice
    fi
fi

# Success
echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}                                                                ${NC}"
echo -e "${GREEN}         JimboMesh Holler Server installed successfully!         ${NC}"
echo -e "${GREEN}                                                                ${NC}"
echo -e "${GREEN}         Now go make some moonshine!                            ${NC}"
echo -e "${GREEN}                                                                ${NC}"
if [ -n "$CONNECT_KEY" ]; then
echo -e "${GREEN}         Connect now from your browser at:                      ${NC}"
echo -e "${GREEN}                                                                ${NC}"
fi
echo -e "${GREEN}================================================================${NC}"

if [ -n "$CONNECT_KEY" ]; then
    echo ""
    echo -e "  ${BOLD}http://localhost:${GATEWAY_HOST_PORT}/admin#key=${CONNECT_KEY}${NC}"
    echo ""
    echo -e "  ${YELLOW}(This URL auto-logs you in. Bookmark it or save the key.)${NC}"
    echo -e "  ${YELLOW}⚠️  The Admin URL contains your API key in the hash fragment.${NC}"
    echo -e "  ${YELLOW}    It is NOT sent to any server — it stays in your browser only.${NC}"
    echo -e "  ${YELLOW}    Do NOT share the full URL with the #key= part.${NC}"
fi

if [ -f "$SCRIPT_DIR/.env" ]; then
    SUMMARY_SERVER_NAME=$(get_env_var "$SCRIPT_DIR/.env" "HOLLER_SERVER_NAME")
    SUMMARY_COMPOSE=$(get_env_var "$SCRIPT_DIR/.env" "COMPOSE_FILE")
    SUMMARY_GATEWAY_PORT=$(get_env_var "$SCRIPT_DIR/.env" "GATEWAY_PORT")
    SUMMARY_OLLAMA_PORT=$(get_env_var "$SCRIPT_DIR/.env" "OLLAMA_HOST_PORT")
    SUMMARY_MODELS=$(get_env_var "$SCRIPT_DIR/.env" "HOLLER_MODELS")
    SUMMARY_MESH_URL=$(get_env_var "$SCRIPT_DIR/.env" "JIMBOMESH_MESH_URL")
    SUMMARY_MESH_KEY=$(get_env_var "$SCRIPT_DIR/.env" "JIMBOMESH_API_KEY")
    SUMMARY_ADMIN_ENABLED=$(get_env_var "$SCRIPT_DIR/.env" "ADMIN_ENABLED")

    [ -z "$SUMMARY_SERVER_NAME" ] && SUMMARY_SERVER_NAME="Holler Server"
    [ -z "$SUMMARY_COMPOSE" ] && SUMMARY_COMPOSE="docker-compose.yml"
    [ -z "$SUMMARY_GATEWAY_PORT" ] && SUMMARY_GATEWAY_PORT="1920"
    [ -z "$SUMMARY_OLLAMA_PORT" ] && SUMMARY_OLLAMA_PORT="1920"
    [ -z "$SUMMARY_MODELS" ] && SUMMARY_MODELS="nomic-embed-text,llama3.1:8b"
    [ -z "$SUMMARY_ADMIN_ENABLED" ] && SUMMARY_ADMIN_ENABLED="true"

    SUMMARY_GPU_MODE="CPU"
    if echo "$SUMMARY_COMPOSE" | grep -q 'docker-compose.gpu.yml'; then
        SUMMARY_GPU_MODE="NVIDIA (docker-compose.gpu.yml)"
    elif echo "$SUMMARY_COMPOSE" | grep -q 'docker-compose.mac.yml'; then
        SUMMARY_GPU_MODE="METAL (docker-compose.mac.yml)"
    fi

    SUMMARY_MESH_STATUS="Disconnected"
    if [ -n "$SUMMARY_MESH_KEY" ]; then
        SUMMARY_MESH_STATUS="Connected (${SUMMARY_MESH_URL:-https://api.jimbomesh.ai})"
    fi
    SUMMARY_ADMIN_STATUS="Disabled"
    if echo "$SUMMARY_ADMIN_ENABLED" | grep -qi '^true$'; then
        SUMMARY_ADMIN_STATUS="Enabled"
    fi

    echo ""
    echo "  ╔═══════════════════════════════════════════════════════════╗"
    echo "  ║  Configuration saved to .env                             ║"
    echo "  ╠═══════════════════════════════════════════════════════════╣"
    printf "  ║  Server Name:    %-41s║\n" "$SUMMARY_SERVER_NAME"
    printf "  ║  GPU Mode:       %-41s║\n" "$SUMMARY_GPU_MODE"
    printf "  ║  Gateway Port:   %-41s║\n" "$SUMMARY_GATEWAY_PORT"
    printf "  ║  Ollama Port:    %-41s║\n" "$SUMMARY_OLLAMA_PORT"
    printf "  ║  Models:         %-41s║\n" "$SUMMARY_MODELS"
    printf "  ║  Mesh:           %-41s║\n" "$SUMMARY_MESH_STATUS"
    printf "  ║  Admin:          %-41s║\n" "$SUMMARY_ADMIN_STATUS"
    echo "  ║                                                           ║"
    echo "  ║  All settings persist across reinstalls.                 ║"
    echo "  ║  Edit .env directly or use Admin UI to change settings.  ║"
    echo "  ╚═══════════════════════════════════════════════════════════╝"
fi

echo -e "\n${BOLD}Quick reference:${NC}"
echo -e "  ${CYAN}Admin UI:${NC}       http://localhost:${GATEWAY_HOST_PORT}/admin"
echo -e "  ${CYAN}Gateway API:${NC}    http://localhost:${GATEWAY_HOST_PORT}"
if [ "$OLLAMA_MODE" = "native" ]; then
    echo -e "  ${CYAN}Native Ollama:${NC}  http://localhost:11434"
fi
if [ "$WITH_QDRANT" = true ]; then
    echo -e "  ${CYAN}Qdrant REST:${NC}    http://localhost:6333"
    echo -e "  ${CYAN}Qdrant gRPC:${NC}    localhost:6334"
fi
echo -e "  ${CYAN}API Key:${NC}        $(mask_key "$CONNECT_KEY")"
if [ -n "$QDRANT_CONNECT_KEY" ]; then
    echo -e "  ${CYAN}Qdrant Key:${NC}     $(mask_key "$QDRANT_CONNECT_KEY")"
fi
echo -e "  ${CYAN}Config:${NC}         $SCRIPT_DIR/.env"

echo -e "\n${BOLD}Useful commands:${NC}"
echo -e "  ${CYAN}View logs:${NC}      docker logs -f jimbomesh-still"
if [ "$OLLAMA_MODE" = "native" ]; then
    echo -e "  ${CYAN}List models:${NC}    ollama list"
    echo -e "  ${CYAN}Pull model:${NC}     ollama pull <model>"
    echo -e "  ${CYAN}Ollama logs:${NC}    tail -f ~/.ollama/logs/server.log"
else
    echo -e "  ${CYAN}List models:${NC}    curl -H 'X-API-Key: YOUR_KEY' http://localhost:${GATEWAY_HOST_PORT}/api/tags"
    echo -e "  ${CYAN}Pull model:${NC}     docker exec jimbomesh-still ollama pull <model>"
fi
echo -e "  ${CYAN}Stop:${NC}           cd $SCRIPT_DIR && $COMPOSE_CMD down"
echo -e "  ${CYAN}Start:${NC}          cd $SCRIPT_DIR && $COMPOSE_CMD up -d"
echo -e "  ${CYAN}Restart:${NC}        cd $SCRIPT_DIR && $COMPOSE_CMD restart jimbomesh-still"

echo -e "\n${BOLD}Test embedding:${NC}"
echo -e "  ${CYAN}curl http://localhost:${GATEWAY_HOST_PORT}/api/embed -d '{\"model\":\"nomic-embed-text\",\"input\":\"hello world\"}'${NC}"

echo -e "\n${BOLD}Documentation:${NC}    $SCRIPT_DIR/docs/"
echo -e "${BOLD}GitHub:${NC}           https://github.com/IngressTechnology/jimbomesh-holler-server"

echo -e "\n${YELLOW}Ollama is ready. Embeddings are local.${NC}\n"

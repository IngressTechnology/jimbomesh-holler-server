# Mac Setup Guide

This guide covers two independent topics:

1. **[Mac Metal GPU — Performance Mode](#mac-metal-gpu-performance-mode)** — Run Ollama natively on your Mac for Apple Silicon GPU acceleration, with Docker handling only the API gateway.
2. **[Mac and Windows Cross-Machine Setup](#mac-and-windows-cross-machine-setup)** — Connect JimboMesh running on Mac to the Holler Server running on a separate Windows machine.

---

## Mac Metal GPU — Performance Mode

### Why Performance Mode Exists

Docker Desktop on macOS runs all containers inside a Linux VM. That VM has no access to the host's Metal GPU framework — Ollama inside Docker is always CPU-only on macOS, regardless of what chip your Mac has.

**Performance Mode** solves this by running Ollama natively on your Mac (via Homebrew), while Docker continues to run the API gateway, authentication layer, and optional Qdrant. You get:

- Full Apple Metal GPU acceleration for embeddings and LLM inference
- The same authenticated API gateway, Admin UI, and Qdrant integration
- Automatic model management (the entrypoint pulls models through the native Ollama)

**Secure Mode** (the alternative) keeps everything in Docker — CPU-only, fully isolated, appropriate for shared machines or security-sensitive deployments.

### Security Implications

**Before you install, understand the difference:**

| | Performance Mode | Secure Mode |
|---|---|---|
| Ollama process | Runs natively on macOS | Runs inside Docker container |
| Container isolation | None for Ollama | Full Docker sandbox |
| Ollama data location | `~/.ollama/` (home directory) | Docker volume (isolated) |
| Binding | Must be localhost only | Internal Docker network |
| Metal GPU | Yes | No |
| Recommended for | Personal dev machines | Shared machines, security-sensitive |

The installer displays a full security warning and requires explicit consent on every macOS install — this prompt cannot be skipped.

### Installation

Run `./setup.sh` and select **[P]** at the mode prompt:

```
[jimbomesh-still] macOS detected — Apple Silicon (arm64)

  ⚠  SECURITY NOTICE — macOS Performance Mode
  ...

  [P] Performance Mode  — native Ollama (Metal GPU, faster, less isolated)
  [S] Secure Mode       — fully in Docker (CPU-only, more isolated)
  [?] Learn more        — opens security documentation in browser

Select mode [P/S/?]:
```

The installer then:

1. Checks for / installs **Homebrew** (with your consent)
2. Runs `brew install ollama` and `brew services start ollama`
3. Verifies Ollama is bound to **localhost only** (rejects 0.0.0.0 binding)
4. Sets `chmod 700 ~/.ollama` to restrict model directory access
5. Uses the committed `docker-compose.mac.yml` overlay and refreshes it for the current install
6. Writes `COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml` to `.env`
7. Builds and starts the Docker API gateway
8. Pulls configured models through the native Ollama
9. Writes `.setup-config.json` and `UNINSTALL-OLLAMA.md` to the project directory

To skip the prompt and use Secure Mode automatically:

```bash
./setup.sh --cpu
```

### How It Works

```
┌─────────────────────────────────────────────────────────┐
│  macOS Host                                              │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Docker Network                                  │    │
│  │                                                  │    │
│  │  ┌────────────────────────┐                      │    │
│  │  │  jimbomesh-still        │                      │    │
│  │  │  API Gateway :1920     │                      │    │
│  │  │  Tiered auth           │                      │    │
│  │  │  /admin (UI)           │─────────────────┐    │    │
│  │  │  SQLite (holler.db)    │                 │    │    │
│  │  └────────────────────────┘                 │    │    │
│  │         │ OLLAMA_EXTERNAL_URL               │    │    │
│  │         │ host.docker.internal:11434        │    │    │
│  └─────────┼──────────────────────────────────┼────┘    │
│            │                                  │          │
│            ▼                                  ▼          │
│  ┌────────────────────────┐    ┌──────────────────────┐  │
│  │  Ollama (native)        │    │  jimbomesh-qdrant    │  │
│  │  localhost:11434        │    │  (optional profile) │  │
│  │  Metal GPU              │    │  :6333               │  │
│  │  brew services          │    └──────────────────────┘  │
│  │  Models: ~/.ollama/     │                              │
│  └────────────────────────┘                              │
└─────────────────────────────────────────────────────────┘
```

The `docker-compose.mac.yml` overlay sets:

```yaml
services:
  jimbomesh-still:
    environment:
      - OLLAMA_EXTERNAL_URL=http://host.docker.internal:11434
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

When `OLLAMA_EXTERNAL_URL` is set, `docker-entrypoint.sh` skips starting its internal Ollama and instead routes the API gateway to the native Ollama on your Mac.

### Expected Performance — Apple Silicon

Approximate embedding latency with native Ollama (Metal GPU):

| Chip | nomic-embed-text (short) | nomic-embed-text (medium) | chat model (tokens/sec) |
|------|--------------------------|---------------------------|--------------------------|
| M1 | ~8–20ms | ~15–40ms | ~25–40 t/s |
| M1 Pro/Max | ~5–15ms | ~10–30ms | ~40–65 t/s |
| M2 | ~7–18ms | ~12–35ms | ~30–45 t/s |
| M2 Pro/Max | ~4–12ms | ~8–25ms | ~50–75 t/s |
| M3 / M3 Pro/Max | ~3–10ms | ~6–20ms | ~55–90 t/s |
| M4 / M4 Pro/Max | ~2–8ms | ~5–15ms | ~65–110 t/s |

> These are rough estimates. Actual performance depends on RAM, thermal state, and concurrent workloads. For comparison, Docker CPU mode on the same chips is typically 5–15× slower for embeddings and 3–8× slower for LLM generation.

**Unified memory advantage:** Apple Silicon uses shared CPU/GPU memory. A Mac with 32 GB RAM has all 32 GB available to Ollama — there is no separate VRAM ceiling. This allows running models that would require a discrete GPU on PC hardware.

### Managing Models in Performance Mode

In Performance Mode, Ollama runs natively. Use the `ollama` CLI directly on your Mac (or the Admin UI):

```bash
# List installed models
ollama list

# Pull a new model
ollama pull mxbai-embed-large

# Remove a model
ollama rm llama3.2:1b

# Check what's loaded in memory
ollama ps
```

Models are stored in `~/.ollama/models/` on your Mac (not in a Docker volume).

The Docker container also has access to `ollama` CLI commands (they target the native Ollama via `OLLAMA_HOST`):

```bash
# From inside the container (same effect as running on host)
docker exec jimbomesh-still ollama list
```

### Switching Modes

**Performance → Secure Mode:**

```bash
# Edit .env — remove or comment out docker-compose.mac.yml
COMPOSE_FILE=docker-compose.yml

# Restart — Docker will start its own internal Ollama (CPU-only)
docker compose up -d --force-recreate
```

Your native Ollama service keeps running but the gateway uses Docker's internal Ollama. Stop native Ollama if you no longer need it:

```bash
brew services stop ollama
```

**Secure → Performance Mode:**

Re-run `./setup.sh` and select **[P]** at the mode prompt. The installer is idempotent — it skips steps that are already done (Homebrew, existing Ollama install).

### Uninstalling Native Ollama

See [UNINSTALL-OLLAMA.md](../UNINSTALL-OLLAMA.md) in the project root for step-by-step instructions.

---

## Mac and Windows Cross-Machine Setup

This section documents how to set up JimboMesh (running on Mac) to use the Holler Server (running on a separate Windows machine).

For most IDEs and third-party tools, the simplest integration path is the OpenAI-compatible `/v1` API on the Holler. The `embed.sh` flow documented here remains the drop-in path for JimboMesh's existing ingestion pipeline.

### Overview

```
JimboMesh (Mac)
  ↓ calls embed.sh with text
  ↓ detects OLLAMA_URL environment variable
  ↓ sends POST to http://your-server-ip:1920/api/embed
Ollama Server (Windows)
  ↓ returns {"embeddings": [[768d vector]]}
JimboMesh embed.sh
  ↓ extracts vector from response
  ↓ upserts to Qdrant with vector + payload
JimboMesh's Qdrant
  ✅ Done!
```

### Prerequisites

- **Windows Machine**: Running Docker with jimbomesh-holler-server
- **Mac Machine**: Running JimboMesh
- **Network**: Both machines on the same local network
- **Ports**: Windows firewall allows ports 1920 (Ollama) and 9090 (Health)

### Step 1: Windows Server Setup

### 1.1 Get Windows IP Address

On the Windows machine:

```bash
ipconfig
# Example output: IPv4 Address. . . . . . . . . . . : your-server-ip
```

Note your IP address (e.g., `your-server-ip`).

### 1.2 Start Holler on Windows

```bash
cd D:/Source/jimbomesh-holler-server

# Recommended first run (PowerShell 7+)
pwsh .\setup.ps1

# With GPU support (add to .env: COMPOSE_FILE=docker-compose.yml;docker-compose.gpu.yml):
docker compose up -d

# With local Qdrant:
docker compose --profile qdrant up -d
```

### 1.3 Verify Server is Running

```bash
# Check container status
docker ps --filter name=jimbomesh-still

# Check models are loaded
docker exec jimbomesh-still ollama list

# Test embedding API
curl -H "X-API-Key: YOUR_KEY" \
  -X POST http://localhost:1920/api/embed \
  -H "Content-Type: application/json" \
  -d '{"model":"nomic-embed-text","input":"test"}'

# Optional: OpenAI-compatible endpoint
curl -H "X-API-Key: YOUR_KEY" \
  -X POST http://localhost:1920/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"nomic-embed-text","input":"test"}'
```

### Step 2: Mac Configuration (JimboMesh)

### 2.1 Update JimboMesh embed.sh

The `scripts/embed.sh` script has been modified to support both Ollama and OpenRouter backends. Key changes:

**Added Ollama Backend Support:**
- Detects `OLLAMA_URL` environment variable
- Uses Ollama API format: `/api/embed` endpoint
- Handles Ollama response format: `{"embeddings": [[...]]}` or `{"embedding": [...]}`
- Falls back to OpenRouter when `OLLAMA_URL` is not set

**Dual Backend Logic:**
```bash
if [ -n "$OLLAMA_URL" ]; then
    # Use Ollama backend
    USE_OLLAMA=true
    MODEL="${OLLAMA_EMBED_MODEL:-nomic-embed-text}"
    DIMENSIONS="${EMBED_DIMENSIONS:-768}"
else
    # Use OpenRouter backend
    USE_OLLAMA=false
    MODEL="${EMBED_MODEL:-openai/text-embedding-3-small}"
    DIMENSIONS="${EMBED_DIMENSIONS:-1536}"
fi
```

### 2.2 Update .env File

Add the following to your JimboMesh `.env` file:

```bash
# Ollama Embedding Server (on-prem, Windows)
# Set OLLAMA_URL to use Ollama instead of OpenRouter for embeddings
OLLAMA_URL=http://your-server-ip:1920  # Replace with your Windows IP
JIMBOMESH_HOLLER_API_KEY=your_generated_api_key_here  # Must match Ollama server
OLLAMA_EMBED_MODEL=nomic-embed-text
EMBED_DIMENSIONS=768
```

**Important Notes:**
- Replace `your-server-ip` with your actual Windows machine IP
- The `EMBED_DIMENSIONS=768` reflects nomic-embed-text's native dimension
- OpenRouter uses 1536d (text-embedding-3-small)

### Step 3: Testing

### 3.1 Test Network Connectivity (from Mac)

```bash
# Test Ollama API
curl -H "X-API-Key: YOUR_KEY" http://your-server-ip:1920/api/tags

# Expected response: JSON list of available models
```

### 3.2 Test Embedding (from Mac)

```bash
cd ~/path/to/JimboMesh

# Test embedding pipeline
echo "Hello from Mac to Windows Ollama!" | \
  bash scripts/embed.sh knowledge_base test-mac-001 \
  '{"source":"test","title":"Mac to Windows Test"}'

# Expected output:
# [embed] using Ollama backend: http://your-server-ip:1920 (model=nomic-embed-text, 768d)
# [embed] upserted test-mac-001 into knowledge_base (42 chars, 768d)
```

### Step 4: Dimension Migration

### Important: Qdrant Collection Dimensions

**Issue**: JimboMesh previously used 1536-dimensional embeddings (OpenAI via OpenRouter). Ollama uses 768-dimensional embeddings (nomic-embed-text). You **cannot mix dimensions** in the same Qdrant collection.

### Option A: Create New Collections (Recommended)

Use fresh 768d collections for Ollama embeddings:

1. Your existing collections remain unchanged (1536d)
2. New embeddings go to new collections or overwrite existing with 768d vectors
3. Qdrant will reject dimension mismatches automatically

### Option B: Migrate Existing Data

If you want to migrate existing embeddings to Ollama:

1. Export all data from existing collections
2. Delete old collections or create new ones with 768d
3. Re-embed all content using Ollama
4. Verify migration before deleting old data

### Configuration Reference

### Environment Variables (JimboMesh)

| Variable | Purpose | Default (Ollama) | Default (OpenRouter) |
|----------|---------|------------------|----------------------|
| `OLLAMA_URL` | Ollama server endpoint | N/A | N/A (triggers Ollama mode) |
| `OLLAMA_EMBED_MODEL` | Embedding model name | `nomic-embed-text` | N/A |
| `EMBED_DIMENSIONS` | Vector dimensions | `768` | `1536` |
| `OPENROUTER_API_KEY` | OpenRouter API key | N/A | Required |
| `QDRANT_URL` | Qdrant endpoint | `http://jimbomesh-qdrant:6333` | Same |
| `QDRANT_API_KEY` | Qdrant authentication | Required | Required |

### Windows Server Services

| Service | Port | Purpose |
|---------|------|---------|
| Holler API Gateway | 1920 | Authenticated Ollama + OpenAI-compatible API |
| Health Server | 9090 | Health checks (/healthz, /readyz, /status) |
| Qdrant (optional) | 6333 | Vector database |
| Qdrant gRPC (optional) | 6334 | Qdrant gRPC API |

### Switching Between Backends

### Use Ollama (On-Prem)

In JimboMesh `.env`:
```bash
OLLAMA_URL=http://your-server-ip:1920
JIMBOMESH_HOLLER_API_KEY=your_api_key_here
OLLAMA_EMBED_MODEL=nomic-embed-text
EMBED_DIMENSIONS=768
```

### Use OpenRouter (Cloud)

In JimboMesh `.env`:
```bash
# Comment out or remove OLLAMA_URL
# OLLAMA_URL=http://your-server-ip:1920
OPENROUTER_API_KEY=sk-or-v1-...
EMBED_DIMENSIONS=1536  # Optional, will default to 1536
```

The script automatically detects which backend to use based on `OLLAMA_URL` presence.

### Performance Considerations

### Network Latency
- Cross-machine embedding is slower than local
- Typical latency: 50-200ms depending on network
- Consider batch processing for large ingestion jobs

### Model Loading
- First embedding request after server start is slower (model loading)
- Subsequent requests are fast (~50-100ms for typical inputs)
- Configure `OLLAMA_KEEP_ALIVE=5m` to keep models in memory

### Batch Processing
For ingesting large amounts of content:

```bash
# Process multiple documents
for file in docs/*.txt; do
  cat "$file" | bash scripts/embed.sh knowledge_base "$(basename "$file")" \
    '{"source":"docs","title":"'$(basename "$file")'"}'
  sleep 0.1  # Small delay to avoid overwhelming the server
done
```

### Troubleshooting

#### Connection Refused

**Symptom**: `curl: (7) Failed to connect to your-server-ip port 1920`

**Solutions**:
1. Verify Windows IP address: `ipconfig`
2. Check container is running: `docker ps`
3. Test from Windows: `curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/api/tags`
4. Check Windows Firewall:
   - Allow inbound connections on port 1920
   - Allow Docker Desktop network

#### Dimension Mismatch Error

**Symptom**: Qdrant returns error about vector dimension mismatch

**Solution**: You're trying to insert 768d vectors into 1536d collection (or vice versa)
- Create new collections with correct dimensions
- Or migrate existing data

#### Slow Embedding Performance

**Symptom**: Embeddings take several seconds

**Causes**:
1. Model not loaded (first request after start)
2. Network latency
3. CPU-only mode (consider GPU profile)

**Solutions**:
- Wait for first request to complete (loads model)
- Set `COMPOSE_FILE` in `.env` if NVIDIA GPU available
- Increase `OLLAMA_NUM_PARALLEL` for concurrent requests

#### Backend Not Switching

**Symptom**: still using OpenRouter despite setting `OLLAMA_URL`

**Solution**: Verify environment is sourced:
```bash
# Check which backend will be used
cd ~/path/to/JimboMesh
bash scripts/embed.sh knowledge_base test-check '{"test":"true"}' < /dev/null 2>&1 | head -1
# Should show: [embed] using Ollama backend: http://your-server-ip:1920 (model=nomic-embed-text, 768d)
```

### Security Considerations

#### Network Security
- All Ollama API requests require `X-API-Key` header authentication
- Rate limiting is enforced (60 req/min per IP by default)
- Ollama runs on internal port (localhost only), accessible only via the authenticated API gateway
- Consider using VPN or SSH tunneling for remote access
- Do not expose port 1920 to the internet without authentication configured

#### API Keys
- Ollama API key is required for all API and admin requests (`JIMBOMESH_HOLLER_API_KEY`)
- Qdrant API key is required for database access (`QDRANT_API_KEY`)
- Keep `.env` files secure and never commit to git
- Use `.gitignore` to exclude `.env`

#### Trust Boundaries
- Embedded content is wrapped in `<retrieved_context>` XML tags
- This maintains the trust boundary when presenting context to LLMs
- Both OpenRouter and Ollama backends preserve this security feature

### Additional Resources

- [Ollama Documentation](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [nomic-embed-text Model Card](https://ollama.com/library/nomic-embed-text)
- [Qdrant Documentation](https://qdrant.tech/documentation/)
- [jimbomesh-holler-server ARCHITECTURE.md](ARCHITECTURE.md)
- [jimbomesh-holler-server DEPLOYMENT.md](DEPLOYMENT.md)

### Changelog

#### 2026-02-27 — macOS Metal GPU Support (Performance Mode)
- Added Performance Mode: native Ollama via Homebrew, Metal GPU access
- Added Secure Mode advisory for shared/sensitive machines
- Added `docker-compose.mac.yml` overlay documentation
- Added Apple Silicon performance benchmarks table
- Restructured as a dual-purpose guide (Mac local GPU + Mac → Windows)

#### 2026-02-22 — Initial Mac → Windows Setup
- Added Ollama backend support to JimboMesh embed.sh
- Configured dual-backend system (Ollama + OpenRouter)
- Fixed Docker entrypoint issues (line endings, path, shell compatibility)
- Updated default chat model guidance over time as releases evolved
- Created Qdrant collections with 768d vectors
- Generated Qdrant API key for Windows server
- Documented complete setup process

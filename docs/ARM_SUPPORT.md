# ARM64 Support

Running JimboMesh Holler Server on ARM64 platforms (Apple Silicon, Raspberry Pi, AWS Graviton).

## Platform Compatibility

| Platform | Status | Notes |
|----------|--------|-------|
| Apple Silicon (M1/M2/M3/M4) | Supported | Best ARM64 experience, Docker Desktop required |
| Raspberry Pi 5 (8 GB) | Supported | Embedding models only, LLM is too slow |
| Raspberry Pi 4 (8 GB) | Limited | `all-minilm` only, other models too large |
| AWS Graviton (c7g, m7g) | Supported | Good performance with sufficient RAM |
| Oracle Ampere (A1) | Supported | Free tier instances have limited RAM |

## Quick Start (Apple Silicon)

The recommended path for Apple Silicon is **Performance Mode** — it gives you full Metal GPU acceleration with a single command:

```bash
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git
cd jimbomesh-holler-server
./setup.sh
# Select [P] Performance Mode when prompted
```

The installer handles everything: Homebrew, native Ollama, the compose overlay, model pulls, and the API gateway. See [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md) for the full walkthrough.

**Secure Mode (Docker CPU only):**

If you prefer fully Docker-based operation (CPU-only, more isolated):

```bash
./setup.sh --cpu
```

Or manually:

```bash
cp .env.example .env
# Edit .env — set JIMBOMESH_HOLLER_API_KEY
docker compose build jimbomesh-still
docker compose up -d
```

Docker Desktop on macOS handles ARM64 natively. No additional configuration needed for Secure Mode.

## Quick Start (Raspberry Pi / Linux ARM64)

### Prerequisites

1. **64-bit OS** — Raspberry Pi OS (64-bit) or Ubuntu 22.04+ ARM64.
   32-bit (armhf) is NOT supported.

   ```bash
   # Verify 64-bit
   uname -m
   # Must output: aarch64
   ```

2. **Docker Engine** — Install Docker CE for ARM64:

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   # Log out and back in
   ```

3. **Docker Compose** — Included with Docker CE (v2+):

   ```bash
   docker compose version
   ```

4. **Sufficient RAM** — See [Memory Requirements](#memory-requirements) below.

### Setup

```bash
git clone https://github.com/IngressTechnology/jimbomesh-holler-server.git
cd jimbomesh-holler-server
cp .env.example .env
# Edit .env — set JIMBOMESH_HOLLER_API_KEY
# For Raspberry Pi: consider HOLLER_MODELS=nomic-embed-text (skip LLM)

docker compose build jimbomesh-still
docker compose up -d
```

## Docker Image

The `ollama/ollama:latest` base image is multi-architecture and includes ARM64 variants. Docker automatically pulls the correct platform:

```bash
# Verify platform
docker inspect jimbomesh-still --format '{{.Architecture}}'
# Output: arm64
```

### NodeSource on ARM64

Node.js 22.x from NodeSource supports `aarch64` natively. The Dockerfile works without modification on ARM64.

## Memory Requirements

Ollama loads the entire model into memory. ARM devices typically have less RAM than x86 servers.

| Model | RAM Required | Raspberry Pi 4 (8 GB) | Raspberry Pi 5 (8 GB) | Apple Silicon |
|-------|-------------|----------------------|----------------------|--------------|
| `all-minilm` | ~200 MB | OK | OK | OK |
| `nomic-embed-text` | ~600 MB | OK | OK | OK |
| `mxbai-embed-large` | ~1.4 GB | Tight | OK | OK |
| `snowflake-arctic-embed` | ~1.4 GB | Tight | OK | OK |
| `llama3.1:8b` | ~5.5 GB | No | Tight | OK |

> "Tight" means it works but leaves little room for the OS, API gateway, and Qdrant. Consider running embedding-only on constrained devices.

### Recommended Configurations

**Raspberry Pi 4 (8 GB)**
```bash
# .env
HOLLER_MODELS=nomic-embed-text
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_NUM_PARALLEL=1
OLLAMA_KEEP_ALIVE=1m
```

**Raspberry Pi 5 (8 GB)**
```bash
# .env
HOLLER_MODELS=nomic-embed-text
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_NUM_PARALLEL=2
OLLAMA_KEEP_ALIVE=5m
```

**Apple Silicon (16+ GB)**
```bash
# .env — default configuration works well
HOLLER_MODELS=nomic-embed-text,llama3.1:8b
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_MAX_LOADED_MODELS=2
OLLAMA_NUM_PARALLEL=4
```

## Model Availability

All embedding models used by JimboMesh are available for ARM64 through Ollama:

| Model | ARM64 Available | Notes |
|-------|----------------|-------|
| `nomic-embed-text` | Yes | Full support |
| `mxbai-embed-large` | Yes | Full support |
| `snowflake-arctic-embed` | Yes | Full support |
| `all-minilm` | Yes | Full support |
| `bge-large` | Yes | Full support |
| `llama3.1:8b` | Yes | Full support, needs 6+ GB RAM |

Ollama serves GGUF model files which are architecture-independent. The Ollama runtime handles hardware-specific optimizations (NEON SIMD on ARM, AVX on x86).

## Performance Expectations

ARM64 embedding performance varies significantly by platform. See [MODEL_BENCHMARKS.md](MODEL_BENCHMARKS.md) for detailed numbers.

### General Guidelines

- **Apple Silicon** — 2-5x faster than Raspberry Pi due to higher clock speeds and memory bandwidth. Performance is competitive with mid-range x86 CPUs.
- **Raspberry Pi 5** — Adequate for low-throughput embedding (a few requests per second with `nomic-embed-text`). Not suitable for bulk ingestion of thousands of documents.
- **Raspberry Pi 4** — Viable only for very low-throughput use cases. Consider `all-minilm` for acceptable latency.
- **AWS Graviton** — On par with or better than equivalent x86 instances for embedding workloads, often at lower cost.

### Tuning for ARM

1. **Reduce parallelism** on constrained devices:
   ```bash
   OLLAMA_NUM_PARALLEL=1
   OLLAMA_MAX_LOADED_MODELS=1
   ```

2. **Shorten keep-alive** to free memory sooner:
   ```bash
   OLLAMA_KEEP_ALIVE=1m
   ```

3. **Skip the LLM** if only embeddings are needed:
   ```bash
   HOLLER_MODELS=nomic-embed-text
   ```

4. **Use swap** on Raspberry Pi (not recommended for performance, but prevents OOM):
   ```bash
   sudo dphys-swapfile swapoff
   sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
   sudo dphys-swapfile setup
   sudo dphys-swapfile swapon
   ```

## GPU Acceleration on ARM

### Apple Silicon (Metal)

Docker Desktop on macOS does **not** pass through Metal GPU access to containers. Ollama inside Docker runs CPU-only on Apple Silicon, regardless of chip generation.

**Performance Mode** solves this by running Ollama natively on the host (via Homebrew), with Docker handling only the API gateway and authentication. This gives full Metal GPU access while keeping the Holler Server's auth, admin UI, and Qdrant integration intact.

**Automated setup (recommended):**

```bash
./setup.sh
# Select [P] Performance Mode when prompted
```

The installer handles Homebrew installation, native Ollama setup, security hardening, and generates the `docker-compose.mac.yml` overlay automatically. See [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md) for the full guide.

**Manual setup (if you prefer):**

```bash
# Install and start Ollama natively
brew install ollama
brew services start ollama

# Verify localhost binding (must NOT bind to 0.0.0.0)
lsof -iTCP:11434 -sTCP:LISTEN

# Secure model directory
chmod 700 ~/.ollama

# Create docker-compose.mac.yml overlay
cat > docker-compose.mac.yml << 'EOF'
services:
  jimbomesh-still:
    environment:
      - OLLAMA_EXTERNAL_URL=http://host.docker.internal:11434
    extra_hosts:
      - "host.docker.internal:host-gateway"
EOF

# Activate the overlay in .env
echo "COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml" >> .env

# Start the API gateway
docker compose up -d
```

**Deployment type comparison:**

| | Docker CPU (Secure Mode) | Native Ollama (Performance Mode) |
|---|---|---|
| Metal GPU | No | Yes |
| Container isolation | Full | Gateway only |
| Model storage | Docker volume | `~/.ollama/` |
| Model management | `docker exec ... ollama` | `ollama` CLI directly |
| Recommended for | Shared machines | Personal dev machines |

### Raspberry Pi (VideoCore / Mali)

No GPU acceleration is available for Ollama on Raspberry Pi. Embedding runs on CPU only.

### AWS Graviton

Graviton instances do not have GPUs. For GPU-accelerated ARM workloads on AWS, use `g5g` instances (Graviton2 + NVIDIA T4G), though availability is limited.

## Known Limitations

1. **No GPU passthrough on Docker Desktop for Mac** — Ollama runs CPU-only inside Docker on Apple Silicon. Use Performance Mode (native Ollama via Homebrew) for Metal GPU acceleration. See [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md).

2. **Raspberry Pi SD card I/O** — Model loading from SD cards is slow. Use a USB 3.0 SSD for significantly better startup times.

3. **32-bit ARM is not supported** — Ollama requires 64-bit ARM (aarch64). Raspberry Pi OS must be the 64-bit variant.

4. **Model cold start** — First embedding request after container start loads the model into RAM. On Raspberry Pi this can take 10-30 seconds for `nomic-embed-text`. The `HEALTH_WARMUP=true` option triggers a warmup embedding during readiness checks.

5. **Swap thrashing** — If a model barely fits in RAM, performance degrades severely due to swapping. Monitor with `free -h` and choose a smaller model if swap usage is high.

## Troubleshooting

### "exec format error" on container start

You're running a 32-bit OS. Verify:

```bash
uname -m
# Must be: aarch64
```

Install 64-bit Raspberry Pi OS if needed.

### Container is killed (OOM)

The model exceeds available RAM. Check Docker memory limits:

```bash
docker stats jimbomesh-still --no-stream
```

Solutions:
- Use a smaller model (`all-minilm`)
- Increase swap (temporary workaround)
- Add more RAM

### Very slow first embedding

Model is loading from disk. Subsequent requests will be fast. To pre-warm:

```bash
# Set in .env
HEALTH_WARMUP=true
```

Or manually warm up:

```bash
curl -H "X-API-Key: YOUR_KEY" \
  http://localhost:11434/api/embed \
  -d '{"model": "nomic-embed-text", "input": "warmup"}'
```

### Docker build fails on ARM

NodeSource setup may fail on older ARM distributions. Ensure you're running:
- Ubuntu 22.04+ or Debian 12+ (64-bit ARM)
- Raspberry Pi OS Bookworm (64-bit)

```bash
# Check OS version
cat /etc/os-release
```

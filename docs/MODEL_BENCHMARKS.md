# Model Benchmarks

Embedding model comparison for JimboMesh Holler Server.
Helps you choose the right model for your hardware and quality requirements.

## Quick Recommendation

| Use Case | Recommended Model | Why |
|----------|-------------------|-----|
| **General RAG / knowledge base** | `nomic-embed-text` | Best balance of quality, speed, and size |
| **Higher retrieval accuracy** | `mxbai-embed-large` | Better quality, reasonable speed increase |
| **Resource-constrained / edge** | `all-minilm` | Tiny (45 MB), fast, acceptable quality |
| **Multilingual content** | `bge-large` | Strong cross-language retrieval |

## Model Overview

| Model | Dimensions | Size | Context | Architecture |
|-------|-----------|------|---------|-------------|
| `nomic-embed-text` | 768 | ~274 MB | 8192 tokens | Nomic BERT |
| `mxbai-embed-large` | 1024 | ~670 MB | 512 tokens | BERT-based |
| `snowflake-arctic-embed` | 1024 | ~670 MB | 512 tokens | BERT-based |
| `all-minilm` | 384 | ~45 MB | 512 tokens | MiniLM |
| `bge-large` | 1024 | ~670 MB | 512 tokens | BERT-based |

### Key Differences

**nomic-embed-text** is the default for good reason: it has the longest context window (8192 tokens vs 512 for most alternatives), produces 768-dimensional vectors (good balance between quality and storage), and is the smallest of the full-size models at ~274 MB.

**mxbai-embed-large** and **snowflake-arctic-embed** produce 1024-dimensional vectors, offering more expressive embeddings at the cost of ~2.5x larger model size and increased Qdrant storage per vector.

**all-minilm** is the lightweight option at ~45 MB and 384 dimensions. Quality is noticeably lower on complex retrieval tasks, but it runs well on minimal hardware.

## Running the Benchmark

The benchmark script measures embedding latency across different text lengths and batch sizes.

### Prerequisites

- Running Ollama server (JimboMesh Holler Server or standalone)
- `curl`, `jq`, `bash` installed
- Models will be auto-pulled if not already present

### Usage

```bash
# Benchmark all default models
./scripts/benchmark-models.sh

# Benchmark specific models
./scripts/benchmark-models.sh nomic-embed-text mxbai-embed-large

# With authentication
JIMBOMESH_HOLLER_API_KEY=your_key ./scripts/benchmark-models.sh

# Against a remote server
OLLAMA_URL=http://your-server-ip:1920 JIMBOMESH_HOLLER_API_KEY=your_key ./scripts/benchmark-models.sh

# More rounds for statistical accuracy
BENCH_ROUNDS=10 BENCH_WARMUP=2 ./scripts/benchmark-models.sh
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://localhost:1920` | Ollama API endpoint |
| `JIMBOMESH_HOLLER_API_KEY` | (none) | API key for authentication |
| `BENCH_ROUNDS` | `5` | Number of timed rounds per test |
| `BENCH_WARMUP` | `1` | Warmup rounds (excluded from results) |

### Output

The script prints a comparison table and saves detailed results to `benchmark-results.json`.

## Benchmark Methodology

### What We Measure

1. **Single embedding latency** — Time to embed one text of varying length:
   - Short (~50 tokens): simulates metadata, titles, short descriptions
   - Medium (~200 tokens): simulates paragraphs, email bodies, Slack messages
   - Long (~500 tokens): simulates document chunks, wiki pages, meeting notes

2. **Batch embedding latency** — Time to embed 5 texts in a single API call. Measures throughput for bulk ingestion scenarios.

### What We Don't Measure

- **Retrieval quality** — Requires domain-specific evaluation datasets. The MTEB leaderboard provides general-purpose quality rankings (see [External Benchmarks](#external-benchmarks)).
- **Memory usage** — Ollama loads models into RAM/VRAM. Monitor with `docker stats jimbomesh-still` during benchmarking.
- **Cold start time** — First embedding after model pull is slower. The warmup phase handles this.

### Interpreting Results

- **Latency varies by hardware.** CPU-only is 5-20x slower than GPU. Always benchmark on your actual deployment target.
- **Median is more reliable than mean** for latency measurements (less affected by GC pauses, network jitter).
- **Batch is not 5x single.** Batch embedding amortizes model loading overhead, so batch-of-5 is typically faster than 5 sequential single calls.
- **Larger models are slower** but produce higher-quality embeddings. The right trade-off depends on your retrieval accuracy requirements.

## Expected Performance Ranges

These are rough expectations. Your actual numbers will vary.

### CPU-Only (8-core Intel/AMD)

| Model | Short | Medium | Long | Batch(5) |
|-------|-------|--------|------|----------|
| `nomic-embed-text` | 50-150ms | 100-300ms | 200-500ms | 150-400ms |
| `mxbai-embed-large` | 80-200ms | 150-400ms | 300-700ms | 200-600ms |
| `snowflake-arctic-embed` | 80-200ms | 150-400ms | 300-700ms | 200-600ms |
| `all-minilm` | 20-60ms | 40-120ms | 80-250ms | 50-150ms |

### GPU (NVIDIA RTX 3060+)

| Model | Short | Medium | Long | Batch(5) |
|-------|-------|--------|------|----------|
| `nomic-embed-text` | 5-20ms | 10-30ms | 15-50ms | 10-40ms |
| `mxbai-embed-large` | 8-30ms | 15-50ms | 25-80ms | 15-60ms |
| `snowflake-arctic-embed` | 8-30ms | 15-50ms | 25-80ms | 15-60ms |
| `all-minilm` | 3-10ms | 5-15ms | 8-25ms | 5-20ms |

### Apple Silicon — Secure Mode (Docker CPU)

Docker Desktop on macOS runs in a Linux VM with no Metal GPU passthrough. Ollama runs CPU-only regardless of chip generation.

| Model | Short | Medium | Long | Batch(5) |
|-------|-------|--------|------|----------|
| `nomic-embed-text` | 15-50ms | 30-80ms | 50-150ms | 30-100ms |
| `mxbai-embed-large` | 25-70ms | 50-120ms | 80-200ms | 50-150ms |
| `snowflake-arctic-embed` | 25-70ms | 50-120ms | 80-200ms | 50-150ms |
| `all-minilm` | 5-20ms | 10-30ms | 20-60ms | 10-40ms |

### Apple Silicon — Performance Mode (Metal GPU)

Performance Mode runs Ollama natively on the host via Homebrew, giving it full access to the Apple Neural Engine and Metal GPU. This yields 3-10x faster embedding and significantly higher LLM throughput compared to Docker CPU mode.

> **Note:** Numbers below are approximate estimates based on known Apple Silicon GPU characteristics. Run `./scripts/benchmark-models.sh` on your machine for precise results.

**Embedding latency:**

| Model | Short | Medium | Long | Batch(5) | vs. Docker CPU |
|-------|-------|--------|------|----------|----------------|
| `nomic-embed-text` | 3-10ms | 6-20ms | 10-35ms | 8-25ms | ~5x faster |
| `mxbai-embed-large` | 5-15ms | 10-30ms | 18-50ms | 12-40ms | ~5x faster |
| `snowflake-arctic-embed` | 5-15ms | 10-30ms | 18-50ms | 12-40ms | ~5x faster |
| `all-minilm` | 1-5ms | 3-8ms | 5-15ms | 3-10ms | ~4x faster |

**LLM throughput** (`llama3.2:1b` via `/api/chat`):

| Chip | Tokens/sec (approx) | Notes |
|------|---------------------|-------|
| M1 (8-core GPU) | 15-25 t/s | 8 GB model fits comfortably |
| M2 (10-core GPU) | 20-35 t/s | Significant improvement over M1 |
| M3 (10-core GPU) | 25-45 t/s | M3 Pro/Max higher end of range |
| M4 (10-core GPU) | 30-55 t/s | M4 Pro/Max higher end of range |

**Unified memory advantage:** Apple Silicon has no discrete VRAM ceiling — all installed RAM is available to Ollama. A Mac with 32 GB unified memory can comfortably hold a 13B or 30B parameter model in memory, with no VRAM overflow to slower system RAM.

See [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md) for setup instructions.

## External Benchmarks

For retrieval quality comparisons beyond latency, refer to:

- **[MTEB Leaderboard](https://huggingface.co/spaces/mteb/leaderboard)** — Massive Text Embedding Benchmark. Ranks models on retrieval, classification, clustering, and more.
- **[Ollama Model Library](https://ollama.com/library)** — Official model pages with parameter counts and descriptions.

### MTEB Retrieval Scores (Approximate)

| Model | MTEB Retrieval (avg) | Notes |
|-------|---------------------|-------|
| `nomic-embed-text` | ~54 | Strong for size, long context |
| `mxbai-embed-large` | ~55 | Slightly better retrieval |
| `snowflake-arctic-embed` | ~56 | Top retrieval quality |
| `all-minilm` | ~42 | Noticeably lower |
| `bge-large` | ~54 | Good multilingual |

> Scores are approximate and vary by dataset. Run on your own data for definitive results.

## Choosing a Model

### Decision Flowchart

```
Is retrieval quality critical?
├── Yes → Is multilingual content involved?
│   ├── Yes → bge-large (1024d, 670 MB)
│   └── No → mxbai-embed-large or snowflake-arctic-embed (1024d, 670 MB)
└── No → Is hardware constrained?
    ├── Yes → all-minilm (384d, 45 MB)
    └── No → nomic-embed-text (768d, 274 MB) ← DEFAULT
```

### Switching Models

Changing embedding models requires re-embedding all content and re-creating Qdrant collections, because you cannot mix different dimensions in the same collection.

1. Update `.env`:
   ```bash
   HOLLER_MODELS=mxbai-embed-large,llama3.2:1b
   OLLAMA_EMBED_MODEL=mxbai-embed-large
   EMBED_DIMENSIONS=1024
   ```

2. Re-create Qdrant collections and re-embed:
   ```bash
   docker compose --profile qdrant down -v
   docker compose --profile qdrant up -d
   # Trigger full re-sync in your application
   ```

See [INTEGRATION.md](INTEGRATION.md) for the complete dimension migration procedure.

## Storage Impact

Higher dimensions increase Qdrant storage per vector:

| Dimensions | Bytes per Vector | 100K Vectors | 1M Vectors |
|-----------|-----------------|-------------|-----------|
| 384 | 1,536 B | ~147 MB | ~1.4 GB |
| 768 | 3,072 B | ~293 MB | ~2.9 GB |
| 1024 | 4,096 B | ~391 MB | ~3.8 GB |

> Qdrant also stores payloads and indexes. Actual storage is 2-3x the raw vector size.

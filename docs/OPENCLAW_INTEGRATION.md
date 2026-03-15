# Connecting Your Holler to OpenClaw

Use JimboMesh Holler as your OpenClaw backend for chat and embeddings with zero cloud API cost and local data control.

## Overview

This integration points OpenClaw at Holler's OpenAI-compatible API on port `1920`:

- Chat completions: `/v1/chat/completions`
- Embeddings: `/v1/embeddings`
- Model list: `/v1/models`

Holler accepts both authentication styles on user-facing endpoints:

- `Authorization: Bearer <key>`
- `X-API-Key: <key>`

OpenClaw sends `apiKey` as `Authorization: Bearer <key>` when using `api: "openai-completions"`, which works directly with Holler.

## Prerequisites

1. **A running Holler Server** (see [Quick Start](../QUICK_START.md))
2. **An OpenClaw instance** (see [openclaw.ai](https://openclaw.ai))
3. **Network reachability** between OpenClaw and Holler on port `1920`

## Step 1: Get Your Holler Details

From the Holler admin panel or `.env`:

- **Base URL**: `http://<holler-host-or-ip>:1920/v1`
- **API key**: `JIMBOMESH_HOLLER_API_KEY` or a `jmh_` bearer token
- **Available models**: Models tab, or API call below

```bash
# Authorization: Bearer
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:1920/v1/models

# X-API-Key
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/v1/models
```

## Step 2: Configure OpenClaw

Use OpenClaw's verified `models.providers` schema.

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "jimbomesh": {
        "baseUrl": "http://<holler-ip>:1920/v1",
        "apiKey": "<your-holler-api-key>",
        "api": "openai-completions",
        "models": [
          {
            "id": "llama3.2:1b",
            "name": "Llama 3.2 1B (JimboMesh Holler)",
            "contextWindow": 8192,
            "maxTokens": 4096
          }
        ]
      }
    }
  }
}
```

Notes:

- `models.mode = "merge"` preserves your existing OpenClaw providers.
- Provider entries live under `models.providers` (not top-level `providers`).
- Use `api: "openai-completions"` (not `type: "openai"`).
- OpenClaw sends `apiKey` as `Authorization: Bearer <key>` and Holler accepts it.

## Step 3: Test the Connection

### Test model list

```bash
# Authorization: Bearer
curl -H "Authorization: Bearer YOUR_KEY" http://YOUR_HOLLER_IP:1920/v1/models

# X-API-Key
curl -H "X-API-Key: YOUR_KEY" http://YOUR_HOLLER_IP:1920/v1/models
```

### Test chat completions

```bash
# Authorization: Bearer (non-streaming)
curl -X POST http://YOUR_HOLLER_IP:1920/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model": "llama3.2:1b",
    "messages": [{"role": "user", "content": "Say hello"}],
    "stream": false
  }'

# X-API-Key (streaming)
curl -X POST http://YOUR_HOLLER_IP:1920/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{
    "model": "llama3.2:1b",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true
  }'
```

### Test embeddings

```bash
# Authorization: Bearer
curl -X POST http://YOUR_HOLLER_IP:1920/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model": "nomic-embed-text",
    "input": "Your text here"
  }'

# X-API-Key
curl -X POST http://YOUR_HOLLER_IP:1920/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{
    "model": "nomic-embed-text",
    "input": "Your text here"
  }'
```

## Docker Networking

### Scenario 1: Same host, different Docker Compose projects

```bash
# Find OpenClaw network
docker network ls

# Bridge Holler container into OpenClaw network
docker network connect <openclaw_network> <holler_container_name>
# Example:
docker network connect dutchess_default jimbomesh-holler-mac1
```

Then configure OpenClaw with the Holler container name:

- `baseUrl: "http://jimbomesh-holler-mac1:1920/v1"`

### Scenario 2: Holler on a different LAN machine

Docker Desktop on macOS/Windows may not route container traffic directly to LAN hosts (`192.168.x.x`) in some setups. Use one of these:

**Option A: socat forward on OpenClaw host**

```bash
# Run on machine hosting OpenClaw
socat TCP-LISTEN:1920,fork,reuseaddr TCP:<holler-ip>:1920 &
```

Then set:

- `baseUrl: "http://host.docker.internal:1920/v1"`

**Option B: Cloudflare Tunnel or ngrok**

```bash
# Run on Holler machine
cloudflared tunnel --url http://localhost:1920
```

Then set:

- `baseUrl: "https://your-holler.trycloudflare.com/v1"`

**Option C: mDNS (`.local`)**

If your Docker stack resolves mDNS names:

- `baseUrl: "http://jimbomesh-holler-mac1.local:1920/v1"`

### Scenario 3: Via JimboMesh SaaS

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "jimbomesh-saas": {
        "baseUrl": "https://api.jimbomesh.ai/v1",
        "apiKey": "<your-saas-api-key>",
        "api": "openai-completions",
        "models": [
          {
            "id": "auto",
            "name": "JimboMesh Auto (best available)",
            "contextWindow": 32768,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

### Persistent Docker network setup

For production-style setups that survive `docker compose up -d` rebuilds, create and use one external shared network.

```bash
# Run once
docker network create jimbomesh-bridge
```

OpenClaw `docker-compose.yml`:

```yaml
networks:
  jimbomesh:
    external: true
    name: jimbomesh-bridge
services:
  gateway:
    networks:
      - default
      - jimbomesh
```

Holler `docker-compose.yml`:

```yaml
networks:
  openclaw:
    external: true
    name: jimbomesh-bridge
services:
  jimbomesh-still:
    networks:
      - default
      - openclaw
```

`docker network connect` survives container restarts, but not `docker compose up -d` rebuilds. Shared external networks are the durable fix.

## Using JimboMesh Models in OpenClaw

Reference format is `<provider-key>/<model-id>`.

Examples:

- `jimbomesh/llama3.2:1b`
- `jimbomesh/llama3.2:1b`
- `jimbomesh/qwen3.5:35b-a3b`

```bash
# Session override
/model jimbomesh/llama3.2:1b
```

```yaml
# Cron jobs (zero API-cost scheduled tasks)
model: "jimbomesh/llama3.2:1b"
```

```yaml
# Sub-agents
model: "jimbomesh/llama3.2:1b"
```

## Recommended Models

| Model | Size | VRAM | Best For | Speed |
|-------|------|------|----------|-------|
| `llama3.2:1b` | 1.3 GB | 2 GB | Quick tasks, testing | Very fast |
| `llama3.2:1b` | 1.3 GB | 2 GB | Default assistant, broad compatibility | Very fast |
| `qwen3.5:9b` | 5.4 GB | 8 GB | Coding, multilingual | Fast |
| `qwen3.5:35b-a3b` | 20 GB | 8 GB | Best coding-per-VRAM (MoE, 3B active) | Fast |
| `qwen3.5:27b` | 16 GB | 20 GB | Strong reasoning, dense | Medium |
| `llama3.1:70b` | 40 GB | 48 GB | Complex reasoning | Slower |
| `nomic-embed-text` | 274 MB | 1 GB | Embeddings only | Instant |

Install models from Holler admin (Models tab) or pull via API:

```bash
curl -X POST http://localhost:1920/admin/api/models/pull \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"qwen3.5:35b-a3b"}'
```

## Multiple Hollers

Configure multiple Holler providers for model specialization or load split:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "holler-gpu": {
        "baseUrl": "http://192.168.1.100:1920/v1",
        "apiKey": "gpu-holler-key",
        "api": "openai-completions",
        "models": [
          {
            "id": "llama3.1:70b",
            "name": "GPU Holler 70B",
            "contextWindow": 8192,
            "maxTokens": 4096
          }
        ]
      },
      "holler-cpu": {
        "baseUrl": "http://192.168.1.101:1920/v1",
        "apiKey": "cpu-holler-key",
        "api": "openai-completions",
        "models": [
          {
            "id": "llama3.2:1b",
            "name": "CPU Holler 1B",
            "contextWindow": 8192,
            "maxTokens": 4096
          }
        ]
      }
    }
  }
}
```

Use `holler-gpu/llama3.1:70b` for heavy reasoning and `holler-cpu/llama3.2:1b` for lower-latency tasks.

## Via JimboMesh SaaS

Use SaaS as the OpenAI-compatible backend when you want hosted routing:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "jimbomesh-saas": {
        "baseUrl": "https://api.jimbomesh.ai/v1",
        "apiKey": "<your-saas-api-key>",
        "api": "openai-completions",
        "models": [
          {
            "id": "auto",
            "name": "JimboMesh Auto (best available)",
            "contextWindow": 32768,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

## What's Supported

| Feature | Status | Notes |
|---------|--------|-------|
| Chat completions | ✅ | `/v1/chat/completions` (streaming and non-streaming) |
| Embeddings | ✅ | `/v1/embeddings` (batch support) |
| Model list | ✅ | `GET /v1/models` |
| Streaming | ✅ | SSE format (OpenAI-compatible) |
| Auth: X-API-Key | ✅ | `X-API-Key: <key>` |
| Auth: Bearer | ✅ | `Authorization: Bearer <key>` |
| Tool/Function calling | ⚠️ | Depends on model and Ollama version |
| Vision (multimodal) | ⚠️ | Depends on model (`llava`, `llama3.2-vision`) |

## Troubleshooting

### "Connection refused"

- Verify Holler is running: `docker ps`
- Check health endpoint: `curl http://localhost:9090/healthz`
- Verify OpenAI endpoint reachability: `curl http://HOLLER_IP:1920/v1/models`
- Confirm firewall allows inbound `1920`

### "401 Unauthorized"

- Confirm key value from `.env`:
  ```bash
  rg JIMBOMESH_HOLLER_API_KEY .env
  ```
- Verify both auth header styles:
  ```bash
  curl -H "Authorization: Bearer YOUR_KEY" http://HOLLER_IP:1920/v1/models
  curl -H "X-API-Key: YOUR_KEY" http://HOLLER_IP:1920/v1/models
  ```
- In OpenClaw, ensure provider uses `api: "openai-completions"` and correct `apiKey`

### "Model not found"

- List models:
  ```bash
  curl -H "Authorization: Bearer YOUR_KEY" http://HOLLER_IP:1920/v1/models
  ```
- Pull missing model:
  ```bash
  curl -X POST http://HOLLER_IP:1920/admin/api/models/pull \
    -H "X-API-Key: YOUR_KEY" \
    -H "Content-Type: application/json" \
    -d '{"name":"llama3.2:1b"}'
  ```

### Slow responses

- Check model size versus available VRAM
- Start with `llama3.2:1b`, then move up to `qwen3.5:9b` as needed
- On macOS, use Performance Mode (Metal) when available; see [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md)

### Streaming not working

- Confirm client requests `"stream": true`
- Manually test SSE:
  ```bash
  curl -N -X POST http://HOLLER_IP:1920/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_KEY" \
    -d '{"model":"llama3.2:1b","messages":[{"role":"user","content":"stream test"}],"stream":true}'
  ```
- Inspect service logs: `docker compose logs -f jimbomesh-still`

## Advanced Configuration

### Rate limiting

Tune request throttling in Admin UI (Configuration) or `.env`:

```bash
RATE_LIMIT_PER_MIN=120
RATE_LIMIT_BURST=20
```

### TLS

For HTTPS directly at Holler:

```bash
TLS_CERT_PATH=/path/to/fullchain.pem
TLS_KEY_PATH=/path/to/privkey.pem
```

### Custom default model

Set fallback model in `.env`:

```bash
HOLLER_DEFAULT_CHAT_MODEL=qwen3.5:9b
```

### Enhanced Security tokens

Holler supports scoped bearer tokens (`jmh_...`) with `Authorization: Bearer`:

1. Enable Enhanced Security in Admin UI
2. Create token(s) with required scopes
3. Use token in OpenClaw provider `apiKey`

See [SECURITY.md](SECURITY.md) for policy and token details.

## Next Steps

- [Configuration guide](CONFIGURATION.md)
- [Deployment guide](DEPLOYMENT.md)
- [Security guide](SECURITY.md)
- [Troubleshooting guide](TROUBLESHOOTING.md)

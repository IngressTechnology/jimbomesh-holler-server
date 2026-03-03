# Connecting Your Holler to OpenClaw

Use your JimboMesh Holler as a local LLM backend for OpenClaw — zero cloud API costs, all data stays on your hardware.

## Prerequisites

1. **A running Holler Server** (see [Quick Start](../QUICK_START.md))
2. **An OpenClaw instance** (see [openclaw.ai](https://openclaw.ai))
3. Both on the same network (or port-forwarded)

## Step 1: Get Your Holler Details

From your Holler admin panel or `.env` file:

- **Holler URL**: `http://localhost:11434` (or your Holler's IP/hostname)
- **API Key**: Your `JIMBOMESH_HOLLER_API_KEY`
- **Available Models**: Check the Models tab or run:

OpenAPI schema for these model-list examples: response `OpenAIModelListResponse`.

```bash
# Using X-API-Key header
curl -H "X-API-Key: YOUR_KEY" http://localhost:11434/v1/models

# Or using Authorization: Bearer (OpenAI-compatible)
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:11434/v1/models
```

Both authentication methods work identically with all endpoints.

## Step 2: Configure OpenClaw

Add your Holler as a custom OpenAI-compatible provider in your OpenClaw config (`openclaw.json`):

```json
{
  "providers": {
    "holler": {
      "type": "openai",
      "baseUrl": "http://YOUR_HOLLER_IP:11434/v1",
      "apiKey": "your-holler-api-key"
    }
  }
}
```

Then reference models as `holler/model-name`:

```json
{
  "model": "holler/llama3.1:8b"
}
```

## Step 3: Test the Connection

### Test Chat Completions

OpenAPI schemas: request `OpenAIChatRequest`, response `OpenAIChatResponse` (or SSE stream).

```bash
# Non-streaming (with X-API-Key)
curl -X POST http://YOUR_HOLLER_IP:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{
    "model": "llama3.1:8b",
    "messages": [{"role": "user", "content": "Say hello"}],
    "stream": false
  }'

# Streaming (with Authorization: Bearer)
curl -X POST http://YOUR_HOLLER_IP:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "model": "llama3.1:8b",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true
  }'
```

**Note:** Both `X-API-Key` and `Authorization: Bearer` headers work with all endpoints. OpenClaw typically uses `Authorization: Bearer` for OpenAI-compatible providers.

### Test Model List

OpenAPI schema: response `OpenAIModelListResponse`.

```bash
curl -H "X-API-Key: YOUR_KEY" http://YOUR_HOLLER_IP:11434/v1/models
```

### Test Embeddings

OpenAPI schemas: request `OpenAIEmbeddingsRequest`, response `OpenAIEmbeddingsResponse`.

```bash
curl -X POST http://YOUR_HOLLER_IP:11434/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{
    "model": "nomic-embed-text",
    "input": "Your text here"
  }'
```

## Network Setup

### Same Machine

- **URL**: `http://localhost:11434`
- **No firewall changes needed**

### Same LAN

- **URL**: `http://192.168.x.x:11434` (Holler machine's IP)
- **Ensure port 11434 is accessible** (check firewall)

### Docker-to-Docker (same host)

- **URL**: `http://host.docker.internal:11434`
- **Works on macOS/Windows Docker Desktop**
- **On Linux**: use `--add-host=host.docker.internal:host-gateway`

### Remote / Cloud

- **Use a reverse proxy** (nginx, Caddy) with TLS
- **Or use the Holler's built-in TLS** (`TLS_CERT_PATH` + `TLS_KEY_PATH`)
- **Never expose port 11434 to the internet without TLS and auth**

## Recommended Models for OpenClaw

| Model | Size | Best For | Speed |
|-------|------|----------|-------|
| `llama3.1:8b` | 4.9 GB | General assistant, coding, analysis | Fast |
| `llama3.1:70b` | 40 GB | Complex reasoning (needs 48GB+ RAM) | Slower |
| `mistral:7b` | 4.1 GB | Fast general purpose | Very fast |
| `codestral:22b` | 12 GB | Code generation | Medium |
| `qwen2.5-coder:7b` | 4.7 GB | Code-focused, good instruction following | Fast |
| `deepseek-coder-v2:16b` | 8.9 GB | Code completion and generation | Medium |
| `nomic-embed-text` | 274 MB | Embeddings only | Instant |

**Install models** via the Holler admin panel (Models → Marketplace tab) or:

OpenAPI schema for request body: `PullRequest` (response is `text/event-stream`).

```bash
# Using X-API-Key
curl -X POST http://localhost:11434/admin/api/models/pull \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "llama3.1:8b"}'

# Admin model-management endpoints use X-API-Key
```

## Troubleshooting

### "Connection refused"

- **Is the Holler running?** `docker ps` or check `http://localhost:11434/health`
- **Is the port accessible?** `curl http://HOLLER_IP:11434/health`
- **Firewall blocking?** Check `ufw status` or Windows Firewall

### "401 Unauthorized"

- **Check your API key** matches the Holler's `JIMBOMESH_HOLLER_API_KEY`:
  ```bash
  grep JIMBOMESH_HOLLER_API_KEY .env
  ```

- **Test authentication** with curl:
  ```bash
  # OpenClaw typically uses Bearer auth
  curl -H "Authorization: Bearer YOUR_KEY" http://HOLLER_IP:11434/v1/models

  # X-API-Key also works
  curl -H "X-API-Key: YOUR_KEY" http://HOLLER_IP:11434/v1/models
  ```

- **OpenClaw must send the key** as `Authorization: Bearer <key>` or `X-API-Key: <key>`

### "Model not found"

- **List available models**: `curl -H "X-API-Key: KEY" http://HOLLER_IP:11434/v1/models`
- **Pull the model**: Open Holler admin → Models → search and install
- **Or via API**: `curl -X POST http://HOLLER_IP:11434/admin/api/models/pull -H "X-API-Key: KEY" -H "Content-Type: application/json" -d '{"name": "llama3.1:8b"}'`

### Slow responses

- **Check GPU status** in Holler admin dashboard
- **Larger models = slower**. Start with 7-8B parameter models
- **On Mac**: Ensure Performance Mode (Metal GPU), not Secure Mode (CPU) — see [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md)

### Streaming not working

- **Check OpenClaw config** supports streaming for your use case
- **Test streaming manually** with curl (see Step 3)
- **Check logs**: `docker compose logs -f jimbomesh-still`

## Advanced Configuration

### Custom Default Model

Set a default chat model in `.env`:

```bash
HOLLER_DEFAULT_CHAT_MODEL=qwen2.5-coder:7b
```

When OpenClaw doesn't specify a model, this one will be used.

### Multiple Hollers

Configure multiple Holler instances for load balancing or model variety:

```json
{
  "providers": {
    "holler-gpu": {
      "type": "openai",
      "baseUrl": "http://192.168.1.100:11434/v1",
      "apiKey": "gpu-holler-key"
    },
    "holler-cpu": {
      "type": "openai",
      "baseUrl": "http://192.168.1.101:11434/v1",
      "apiKey": "cpu-holler-key"
    }
  }
}
```

Then use `holler-gpu/llama3.1:70b` for heavy tasks and `holler-cpu/llama3.1:8b` for light ones.

### Rate Limiting

Holler enforces rate limits (default: 60 requests/min per IP). Adjust in Admin UI → Configuration:

- `RATE_LIMIT_PER_MIN` — Base rate limit
- `RATE_LIMIT_BURST` — Burst allowance

Or set in `.env`:

```bash
RATE_LIMIT_PER_MIN=120
RATE_LIMIT_BURST=20
```

### Enhanced Security (Bearer Tokens)

For more granular access control, use Holler's bearer token system:

1. **Enable Enhanced Security** in Admin UI
2. **Create a token** with `chat` permission
3. **Use in OpenClaw** as `Authorization: Bearer jmh_...`

See [SECURITY.md](SECURITY.md) for details.

## What's Supported

| Feature | Holler Support | Notes |
|---------|----------------|-------|
| Chat completions | ✅ | `/v1/chat/completions` (streaming & non-streaming) |
| Embeddings | ✅ | `/v1/embeddings` (batch support) |
| Model list | ✅ | `GET /v1/models` |
| Streaming | ✅ | SSE format (OpenAI-compatible) |
| Temperature | ✅ | Passed to Ollama |
| Top-P | ✅ | Passed to Ollama |
| Max tokens | ✅ | Mapped to `num_predict` |
| Stop sequences | ✅ | Passed to Ollama |
| Presence penalty | ✅ | Passed to Ollama |
| Frequency penalty | ✅ | Passed to Ollama |
| Function calling | ❌ | Not supported by Ollama |
| Vision (multimodal) | ⚠️ | Depends on model (llava, bakllava) |

## Next Steps

- [Install more models](CONFIGURATION.md#alternative-embedding-models)
- [Enable Qdrant vector DB](DEPLOYMENT.md#mode-2-ollama--qdrant) for document search
- [Set up TLS](SECURITY.md) for production use
- [Monitor performance](TROUBLESHOOTING.md) in the admin dashboard

---

**Need help?** See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) or file an issue on GitHub.

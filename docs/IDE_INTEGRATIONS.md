# IDE & Tool Integrations

Use your JimboMesh Holler as the AI backend for your favorite development tools. Replace cloud AI subscriptions with your own hardware — same features, zero monthly cost, complete privacy.

## Supported IDEs & Tools

| IDE/Tool | Type | Chat | Autocomplete | Inline Edit | Embeddings | Guide |
|----------|------|------|--------------|-------------|------------|-------|
| Cursor | IDE | ✅ | ✅ | ✅ | ✅ | [Setup →](#cursor) |
| VS Code + Continue | Extension | ✅ | ✅ | ✅ | ✅ | [Setup →](#vs-code--continue) |
| VS Code + Cody | Extension | ✅ | ✅ | ✅ | ❌ | [Setup →](#vs-code--cody) |
| JetBrains + Continue | Plugin | ✅ | ✅ | ✅ | ✅ | [Setup →](#jetbrains-ides) |
| Neovim | Editor | ✅ | ✅ | ✅ | Varies | [Setup →](#neovim) |
| Zed | IDE | ✅ | ✅ | ❌ | ❌ | [Setup →](#zed) |
| Aider | CLI | ✅ | N/A | ✅ | ❌ | [Setup →](#aider) |
| Windsurf | IDE | ✅ | ⚠️ | ⚠️ | ❌ | [Setup →](#windsurf) |

**Legend:** ✅ = Fully supported | ⚠️ = Partial/experimental | ❌ = Not supported

## Before You Start

### Prerequisites

1. **Holler must be running** — see [Quick Start](../QUICK_START.md)
2. **Note your Holler URL** — default: `http://localhost:11434`
3. **Note your API key** — from `.env` file: `JIMBOMESH_HOLLER_API_KEY`

**Note on Authentication:** The Holler accepts API keys via both methods:
- `X-API-Key: your-key` (traditional API key header)
- `Authorization: Bearer your-key` (OpenAI-compatible)

When you configure `apiKey` in IDE settings, most tools automatically send it as `Authorization: Bearer <key>`, which works perfectly. Both methods support the same authentication tiers (API keys, bearer tokens, JWT).

### Recommended Models for Coding

| Model | Size | Best For |
|-------|------|----------|
| `codestral:22b` | 12 GB | Code generation, refactoring (best quality) |
| `deepseek-coder-v2:16b` | 8.9 GB | Code completion, fast and accurate |
| `llama3.1:8b` | 4.9 GB | General coding + chat (good all-rounder) |
| `qwen2.5-coder:7b` | 4.7 GB | Strong coding, good at following instructions |
| `codellama:7b` | 3.8 GB | Code-specific, smaller/faster |
| `starcoder2:7b` | 4 GB | Code completion, multi-language |
| `starcoder2:3b` | 1.7 GB | Fast autocomplete (low latency) |

**Install models** via the Holler admin panel (Models tab) or:

```bash
# Using X-API-Key
curl -X POST http://localhost:11434/admin/api/models/pull \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "qwen2.5-coder:7b"}'

# Admin model-management endpoints use X-API-Key
# (Bearer auth is for OpenAI-compatible inference endpoints)
```

### What You're Replacing

| Cloud Service | Monthly Cost | Holler Replacement |
|---------------|--------------|-------------------|
| GitHub Copilot | $10-39/mo | Free (your hardware) |
| Cursor Pro | $20/mo | Free (your hardware) |
| Cody Pro | $9/mo | Free (your hardware) |
| Claude Pro | $20/mo | Free (your hardware) |
| ChatGPT Plus | $20/mo | Free (your hardware) |

**Total savings: $79-108/month per developer**

---

## Cursor

Cursor natively supports custom OpenAI-compatible API endpoints.

### Setup

1. Open Cursor Settings (`Cmd+,` / `Ctrl+,`)
2. Navigate to **Models** section
3. Under **OpenAI API Key**, enter your Holler API key
4. Under **Override OpenAI Base URL**, enter: `http://localhost:11434/v1`
5. Click **Add Model** and enter your model name (e.g., `llama3.1:8b`)
6. Select your model as the default for Chat and/or Composer

### Configuration

| Setting | Value |
|---------|-------|
| OpenAI API Key | `your-holler-api-key` |
| Override OpenAI Base URL | `http://localhost:11434/v1` |
| Model | `llama3.1:8b` (or any installed model) |

### Using Multiple Models

Add multiple models for different tasks:
- `qwen2.5-coder:7b` → Code generation (Composer)
- `llama3.1:8b` → Chat and explanations
- `codestral:22b` → Complex refactoring (if you have the RAM)

### Tab Completion

For Cursor's Tab autocomplete with your Holler:
1. Settings → **Cursor Tab** section
2. Set the model to your preferred coding model
3. Smaller models (`codellama:7b`, `starcoder2:3b`) work best for fast completions

### Known Limitations

- Cursor's built-in features (Copilot++, smart rewrites) may not work with custom models
- Some Cursor-specific prompt formatting may produce different results than with native models
- For best results, use models specifically tuned for code (codestral, deepseek-coder, qwen2.5-coder)

---

## VS Code + Continue

Continue is the best open-source AI coding extension for VS Code. Full chat, autocomplete, and inline edit — all pointing at your Holler.

### Install

- **VS Code → Extensions → Search "Continue" → Install**
- Or: `code --install-extension continue.continue`

### Configure

Edit `~/.continue/config.json` (Continue creates this on first launch):

```json
{
  "models": [
    {
      "title": "Holler — Llama 3.1 8B",
      "provider": "openai",
      "model": "llama3.1:8b",
      "apiBase": "http://localhost:11434/v1",
      "apiKey": "your-holler-api-key"
    },
    {
      "title": "Holler — Qwen Coder",
      "provider": "openai",
      "model": "qwen2.5-coder:7b",
      "apiBase": "http://localhost:11434/v1",
      "apiKey": "your-holler-api-key"
    }
  ],
  "tabAutocompleteModel": {
    "title": "Holler Autocomplete",
    "provider": "openai",
    "model": "starcoder2:3b",
    "apiBase": "http://localhost:11434/v1",
    "apiKey": "your-holler-api-key"
  },
  "embeddingsProvider": {
    "provider": "openai",
    "model": "nomic-embed-text",
    "apiBase": "http://localhost:11434/v1",
    "apiKey": "your-holler-api-key"
  }
}
```

### Features Working with Holler

- **Chat (`Cmd+L`)**: Ask questions, explain code, debug
- **Inline Edit (`Cmd+I`)**: Select code → describe changes → applied inline
- **Tab Autocomplete**: Real-time code suggestions as you type
- **Embeddings**: Codebase indexing for `@codebase` context (uses `nomic-embed-text`)
- **@docs**: Index documentation sites for context
- **Slash commands**: `/edit`, `/comment`, `/share` all work

### Recommended Model Pairing

```json
// Chat: smart, general purpose
"models": [{"model": "llama3.1:8b", ...}],

// Autocomplete: fast, code-focused
"tabAutocompleteModel": {"model": "starcoder2:3b", ...},

// Embeddings: lightweight
"embeddingsProvider": {"model": "nomic-embed-text", ...}
```

---

## VS Code + Cody

Cody (by Sourcegraph) supports custom LLM providers via experimental configuration.

### Install

1. **VS Code → Extensions → Search "Cody AI" → Install**
2. Sign in to Sourcegraph (free tier works)

### Configure Custom LLM

In VS Code `settings.json`:

```json
{
  "cody.experimental.ollamaChat": true,
  "cody.autocomplete.advanced.provider": "experimental-ollama",
  "cody.autocomplete.advanced.serverEndpoint": "http://localhost:11434",
  "cody.autocomplete.advanced.model": "starcoder2:3b"
}
```

**Note:** Cody's Ollama integration connects to the native Ollama API format (not OpenAI-compatible). The Holler proxies both formats, so this works directly.

### Alternative: OpenAI-Compatible Mode

If Cody adds full OpenAI-compatible provider support (check latest docs), configure as:

```json
{
  "cody.provider": "openaicompatible",
  "cody.provider.config": {
    "endpoint": "http://localhost:11434/v1",
    "apiKey": "your-holler-api-key",
    "model": "llama3.1:8b"
  }
}
```

### Known Limitations

- Cody's Ollama support is experimental — features may change between versions
- Some Cody features (context fetching, multi-repo) still require Sourcegraph cloud
- Autocomplete quality may vary compared to Cody's native models

---

## JetBrains IDEs

Works with **ALL JetBrains IDEs** via the Continue plugin.

### Install Continue Plugin

1. **Settings → Plugins → Marketplace → Search "Continue"**
2. Install and restart the IDE

### Configure

Edit `~/.continue/config.json` (same file as VS Code — shared config!):

```json
{
  "models": [
    {
      "title": "Holler — Llama 3.1 8B",
      "provider": "openai",
      "model": "llama3.1:8b",
      "apiBase": "http://localhost:11434/v1",
      "apiKey": "your-holler-api-key"
    }
  ],
  "tabAutocompleteModel": {
    "title": "Holler Autocomplete",
    "provider": "openai",
    "model": "qwen2.5-coder:7b",
    "apiBase": "http://localhost:11434/v1",
    "apiKey": "your-holler-api-key"
  }
}
```

### Supported JetBrains IDEs

| IDE | Primary Language | Works? |
|-----|------------------|--------|
| IntelliJ IDEA | Java, Kotlin | ✅ |
| PyCharm | Python | ✅ |
| WebStorm | JavaScript, TypeScript | ✅ |
| GoLand | Go | ✅ |
| Rider | C#, .NET | ✅ |
| CLion | C, C++ | ✅ |
| RubyMine | Ruby | ✅ |
| PhpStorm | PHP | ✅ |
| DataGrip | SQL | ✅ |

All share the same `~/.continue/config.json` — **configure once, works everywhere**.

---

## Neovim

Three popular plugins support custom OpenAI-compatible backends.

### Option A: avante.nvim (Recommended)

AI-powered code suggestions and chat inside Neovim.

**lazy.nvim setup:**

```lua
{
  "yetone/avante.nvim",
  event = "VeryLazy",
  opts = {
    provider = "openai",
    openai = {
      endpoint = "http://localhost:11434/v1",
      model = "llama3.1:8b",
      api_key_name = "HOLLER_API_KEY",  -- reads from env var
      timeout = 60000,
    },
  },
}
```

**Set your API key:**

```bash
export HOLLER_API_KEY="your-holler-api-key"
```

### Option B: codecompanion.nvim

More flexible, supports multiple providers and adapters.

**lazy.nvim setup:**

```lua
{
  "olimorris/codecompanion.nvim",
  opts = {
    adapters = {
      holler = function()
        return require("codecompanion.adapters").extend("openai_compatible", {
          env = {
            url = "http://localhost:11434",
            api_key = "HOLLER_API_KEY",
          },
          schema = {
            model = {
              default = "llama3.1:8b",
            },
          },
        })
      end,
    },
    strategies = {
      chat = { adapter = "holler" },
      inline = { adapter = "holler" },
    },
  },
}
```

### Option C: ollama.nvim (Direct Ollama)

If you prefer the native Ollama API (not OpenAI-compatible):

```lua
{
  "nomnivore/ollama.nvim",
  opts = {
    model = "llama3.1:8b",
    url = "http://localhost:11434",  -- Holler proxies to Ollama
  },
}
```

**Note:** This uses the Ollama API directly. Auth via `X-API-Key` header may need a custom setup.

---

## Zed

Zed has built-in support for custom OpenAI-compatible LLM providers.

### Configure

Edit Zed settings (`Cmd+,` → JSON):

```json
{
  "language_models": {
    "openai": {
      "api_url": "http://localhost:11434/v1",
      "api_key": "your-holler-api-key",
      "available_models": [
        {
          "name": "llama3.1:8b",
          "display_name": "Holler — Llama 3.1 8B",
          "max_tokens": 8192
        },
        {
          "name": "qwen2.5-coder:7b",
          "display_name": "Holler — Qwen Coder",
          "max_tokens": 8192
        }
      ]
    }
  },
  "assistant": {
    "default_model": {
      "provider": "openai",
      "model": "llama3.1:8b"
    }
  }
}
```

### Features

- **Assistant Panel (`Cmd+?`)**: Chat with your Holler models
- **Inline Assist (`Cmd+Enter`)**: AI-powered code transformations
- **Model selector**: Switch between installed Holler models in the assistant panel

---

## Aider

Aider is a powerful AI pair programming CLI tool. Works perfectly with any OpenAI-compatible endpoint.

### Quick Start

```bash
# Install aider
pip install aider-chat

# Set environment variables
export OPENAI_API_BASE=http://localhost:11434/v1
export OPENAI_API_KEY=your-holler-api-key

# Start aider with your Holler
aider --model openai/llama3.1:8b
```

### Persistent Config

Create `~/.aider.conf.yml`:

```yaml
openai-api-base: http://localhost:11434/v1
openai-api-key: your-holler-api-key
model: openai/llama3.1:8b
```

Or project-level `.aider.conf.yml` in your repo root.

### Recommended Models for Aider

| Task | Model | Why |
|------|-------|-----|
| General coding | `llama3.1:8b` | Good balance of speed and quality |
| Complex refactoring | `codestral:22b` | Best code quality (needs 16GB+ RAM) |
| Quick edits | `qwen2.5-coder:7b` | Fast, code-focused |

### Aider Features with Holler

- `/add` files to context → edit multiple files at once
- `/ask` questions about your codebase
- `/diff` to see proposed changes before applying
- `/commit` to auto-commit with AI-generated messages
- **Git-aware**: tracks changes, creates commits

---

## Windsurf

Windsurf's custom model support varies by version. Check the latest documentation.

### If OpenAI-Compatible Providers Are Supported

**Settings → AI Provider → Custom:**
- **API Base URL**: `http://localhost:11434/v1`
- **API Key**: `your-holler-api-key`
- **Model**: `llama3.1:8b`

### Current Limitations

- Windsurf's core autocomplete engine (Codeium) uses proprietary models — these cannot be replaced with a Holler
- Chat/command features may support custom providers depending on your version
- Check Windsurf docs for the latest on custom provider support

### Alternative

For full local AI coding in a VS Code-based editor, consider using **VS Code + Continue extension** instead — full Holler support guaranteed.

---

## Troubleshooting (All IDEs)

### "Connection refused"

Your Holler isn't running or isn't accessible:

```bash
curl http://localhost:11434/health
```

If this fails, start your Holler:

```bash
cd jimbomesh-holler-server && docker compose up -d
```

### "401 / Unauthorized"

API key mismatch. Check your key:

```bash
grep JIMBOMESH_HOLLER_API_KEY .env
```

Use this exact value in your IDE config. Test authentication works:

```bash
# Test with X-API-Key header
curl -H "X-API-Key: YOUR_KEY" http://localhost:11434/v1/models

# Or test with Authorization: Bearer (what most IDEs use)
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:11434/v1/models
```

Both methods should return a JSON list of available models.

### "Model not found"

The model isn't installed. List available models first:

```bash
curl -H "X-API-Key: YOUR_KEY" http://localhost:11434/v1/models
```

Then install the model you need:

```bash
curl -X POST http://localhost:11434/admin/api/models/pull \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "llama3.1:8b"}'
```

Or use the Holler admin panel → **Models** tab → **Marketplace**.

### Slow responses

- Use **smaller models** for autocomplete (`starcoder2:3b`, `codellama:7b`)
- Use **larger models** for chat/refactoring (`llama3.1:8b`, `codestral:22b`)
- On Mac: ensure you're in **Performance Mode** (Metal GPU) — see [Mac Setup](MAC_WINDOWS_SETUP.md)
- Check GPU utilization in the Holler admin dashboard

### Remote Holler (different machine)

Replace `localhost:11434` with your Holler machine's IP:

```
http://192.168.1.100:11434/v1
```

Ensure port 11434 is open in the firewall.

---

## What's Next

- Tune model choices per workflow (autocomplete vs chat vs refactor) using the guidance in this doc.
- Save reusable IDE configs in your dotfiles/team templates so onboarding is one copy-paste step.
- Track updates in [CHANGELOG.md](../CHANGELOG.md) for new endpoint support and integration improvements.

---

**Questions or issues?** See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) or file an issue on GitHub.

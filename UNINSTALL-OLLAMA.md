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

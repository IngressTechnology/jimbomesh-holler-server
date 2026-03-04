# Troubleshooting Guide

Common issues and their solutions for jimbomesh-holler-server.

## Table of Contents

- [Container Issues](#container-issues)
- [Model Issues](#model-issues)
- [Network Issues](#network-issues)
- [Qdrant Issues](#qdrant-issues)
- [Admin UI Issues](#admin-ui-issues)
- [Mesh Connectivity Issues](#mesh-connectivity-issues)
- [Installer Issues](#installer-issues)
- [macOS Performance Mode Issues](#macos-performance-mode-issues)
- [Performance Issues](#performance-issues)

---

## Container Issues

### Container in Restart Loop

**Symptom**: Container constantly restarting
```bash
docker ps -a
# Shows: Restarting (X) Y seconds ago
```

**Common Causes**:

#### 1. Entrypoint File Not Found

```
exec /usr/local/bin/docker-entrypoint.sh: no such file or directory
```

**Root Cause**: Dockerfile ENTRYPOINT uses relative path instead of absolute path.

**Solution**: In `Dockerfile`, change:
```dockerfile
# Wrong:
ENTRYPOINT ["docker-entrypoint.sh"]

# Correct:
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
```

Then rebuild:
```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

#### 2. Windows Line Endings (CRLF)

**Symptom**:
```
exec /usr/local/bin/docker-entrypoint.sh: no such file or directory
```
Even though the file exists!

**Root Cause**: Script has Windows line endings (`\r\n`) instead of Unix (`\n`). The `\r` character in the shebang line breaks script execution.

**Diagnosis**:
```bash
head -1 docker-entrypoint.sh | od -c
# Bad:  #   !   /   b   i   n   /   b   a   s   h  \r  \n
# Good: #   !   /   b   i   n   /   b   a   s   h  \n
```

**Solution**:
```bash
# Convert all shell scripts to Unix line endings
cd /path/to/jimbomesh-holler-server
sed -i 's/\r$//' docker-entrypoint.sh
cd scripts
for f in *.sh; do sed -i 's/\r$//' "$f"; done

# Or use dos2unix if available:
dos2unix docker-entrypoint.sh scripts/*.sh

# Prevent future issues with .gitattributes:
echo "*.sh text eol=lf" >> .gitattributes

# Rebuild image
docker compose build --no-cache
```

#### 3. Shell Compatibility (sh vs bash)

**Symptom**:
```
trap: SIGTERM: bad trap
```

**Root Cause**: Script uses bash-specific features (like `trap SIGTERM`) but shebang is `#!/bin/sh`.

**Solution**: Change shebang from `#!/bin/sh` to `#!/bin/bash`:
```bash
# In docker-entrypoint.sh and other scripts
sed -i 's|^#!/bin/sh|#!/bin/bash|' docker-entrypoint.sh
```

---

## Model Issues

### Model Pull Failed

#### "Pulling E:\OllamaModels..." or Path Instead of Model Name

**Symptom**:
```
[jimbomesh-still] pulling E:OllamaModels...
Error: pull model manifest: file does not exist
```

**Root Cause**: The host machine has `OLLAMA_MODELS` set as an environment variable (Ollama's native model storage directory, e.g., `E:\OllamaModels`). Docker Compose leaks host env vars into the container, and older configs used `OLLAMA_MODELS` as the model list variable.

**Solution**: This was fixed by renaming the project variable to `HOLLER_MODELS`. If you still see this:

1. Ensure your `docker-compose.yml` and `.env` use `HOLLER_MODELS` (not `OLLAMA_MODELS`) for the model list
2. Ensure `docker-entrypoint.sh` reads `HOLLER_MODELS`
3. Rebuild: `docker compose up --build -d`

#### Invalid Model Name

**Symptom**:
```
Error: pull model manifest: file does not exist
```

**Diagnosis**: Model name doesn't exist in Ollama registry.

**Examples**:
- `llama3.2:8b-instruct` ❌ (doesn't exist - Llama 3.2 only comes in 1B and 3B)
- `llama3.1:8b-instruct` ❌ (should be `llama3.1:8b`)
- `llama3.1:8b` ✅ (correct)

**Solution**:
1. Check available models: https://ollama.com/library
2. Update `.env`:
   ```bash
   HOLLER_MODELS=nomic-embed-text,llama3.1:8b
   ```
3. Restart:
   ```bash
   docker compose restart
   ```

#### Network Issues During Pull

**Symptom**: Model download stalls or fails

**Solution**:
```bash
# Check container logs
docker logs jimbomesh-still -f

# Manual pull inside container
docker exec jimbomesh-still ollama pull llama3.1:8b

# Increase timeout if needed
docker compose down
docker compose up -d
```

### Model Not Loading

**Symptom**: API returns model not found error

**Diagnosis**:
```bash
# List loaded models
docker exec jimbomesh-still ollama list

# Check if model was pulled
docker exec jimbomesh-still ls -lh /root/.ollama/models/
```

**Solution**:
```bash
# Pull model manually
docker exec jimbomesh-still ollama pull nomic-embed-text

# Or restart with model pull on startup
docker compose restart
```

---

## Network Issues

### Cannot Connect from Mac to Windows Server

**Symptom**:
```bash
curl: (7) Failed to connect to your-server-ip port 1920
```

**Diagnosis Steps**:

1. **Verify Windows IP**:
   ```bash
   # On Windows:
   ipconfig | grep "IPv4 Address"
   ```

2. **Test from Windows Locally**:
   ```bash
   # On Windows:
   curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/api/tags
   ```
   If this fails, container isn't running properly.

3. **Test from Mac**:
   ```bash
   # On Mac:
   ping your-server-ip
   curl -H "X-API-Key: YOUR_KEY" http://your-server-ip:1920/api/tags
   ```

**Solutions**:

#### Windows Firewall Blocking

```powershell
# On Windows (PowerShell as Administrator):

# Allow port 1920 (Ollama)
New-NetFirewallRule -DisplayName "Ollama Server" -Direction Inbound -Protocol TCP -LocalPort 1920 -Action Allow

# Allow port 9090 (Health)
New-NetFirewallRule -DisplayName "Ollama Health" -Direction Inbound -Protocol TCP -LocalPort 9090 -Action Allow

# Or allow Docker Desktop network entirely:
New-NetFirewallRule -DisplayName "Docker Desktop" -Direction Inbound -InterfaceAlias "vEthernet (Docker)" -Action Allow
```

#### Wrong IP Address

- Use LAN IP (192.168.x.x), not localhost or 127.0.0.1
- Check which network adapter is active (Wi-Fi vs Ethernet)
- Ensure both machines on same network

#### Container Not Binding to 0.0.0.0

**Note**: The API gateway handles external binding (0.0.0.0:1920). Ollama itself runs on 127.0.0.1:11435 (internal only). If external connections fail, check that Docker port mapping is correct in `docker-compose.yml`:
```yaml
ports:
  - "${OLLAMA_HOST_PORT:-1920}:1920"  # Maps host port to gateway
```

### Port Already in Use

**Symptom**:
```
Error starting userland proxy: listen tcp4 0.0.0.0:1920: bind: address already in use
```

**Solution**:
```bash
# Find what's using the port
netstat -ano | findstr :1920  # Windows
lsof -i :1920                  # Mac/Linux

# Stop the conflicting service or change port in .env:
echo "OLLAMA_HOST_PORT=1921" >> .env
docker compose down && docker compose up -d
```

---

## Qdrant Issues

### Init Container Failing

**Symptom**:
```bash
docker ps -a --filter name=init-qdrant
# Shows: Exited (22) X seconds ago
```

**Diagnosis**:
```bash
docker logs jimbomesh-holler-init-qdrant
```

**Common Causes**:

#### Missing API Key

```
[init-qdrant] ERROR: QDRANT_API_KEY must be set
```

**Solution**:
```bash
# Generate API key
openssl rand -hex 32

# Add to .env
echo "QDRANT_API_KEY=<generated-key>" >> .env

# Restart
docker compose --profile qdrant down
docker compose --profile qdrant up -d
```

#### Qdrant Not Ready

Init container runs before Qdrant is fully started.

**Solution**: Already handled by health check dependency in `docker-compose.yml`. If still failing, increase Qdrant startup time:
```yaml
healthcheck:
  start_period: 30s  # Increase if needed
```

### Qdrant Key Shows "No" in Admin UI

**Symptom**: `.env` has `QDRANT_API_KEY` set, but the Admin UI Configuration > Security shows "Qdrant Key Configured: No"

**Root Cause**: `QDRANT_API_KEY` is not passed into the `jimbomesh-still` container. The variable must be listed in the `environment` section of `docker-compose.yml` for the `jimbomesh-still` service.

**Solution**: Verify `docker-compose.yml` includes this line under `jimbomesh-still > environment`:
```yaml
- QDRANT_API_KEY=${QDRANT_API_KEY:-}
```

Then recreate the container:
```bash
docker compose up -d --force-recreate --no-deps jimbomesh-still
```

### Dimension Mismatch

**Symptom**:
```
ERROR: Qdrant upsert failed (HTTP 400)
```

**Detailed Error** (from Qdrant logs):
```
Vector dimension mismatch: expected 1536, got 768
```

**Root Cause**: Trying to insert 768d vectors (Ollama) into 1536d collection (OpenAI/OpenRouter).

**Solution**:

**Option A**: Create new collection with correct dimensions
```bash
curl -X PUT "http://localhost:6333/collections/knowledge_base_768" \
  -H "Content-Type: application/json" \
  -H "api-key: ${QDRANT_API_KEY}" \
  -d '{
    "vectors": {
      "size": 768,
      "distance": "Cosine"
    }
  }'
```

**Option B**: Delete and recreate collection
```bash
# WARNING: This deletes all data!
curl -X DELETE "http://localhost:6333/collections/knowledge_base" \
  -H "api-key: ${QDRANT_API_KEY}"

# Create with new dimensions
curl -X PUT "http://localhost:6333/collections/knowledge_base" \
  -H "Content-Type: application/json" \
  -H "api-key: ${QDRANT_API_KEY}" \
  -d '{
    "vectors": {
      "size": 768,
      "distance": "Cosine"
    }
  }'
```

---

## Admin UI Issues

### Admin UI Not Loading

**Symptom**: `http://localhost:1920/admin` returns 404

**Possible Causes**:

#### 1. Admin Disabled

Check if `ADMIN_ENABLED` is set to `false` in `.env`:

```bash
grep ADMIN_ENABLED .env
```

**Solution**: Remove the line or set to `true`, then restart:
```bash
docker compose restart
```

#### 2. Container Using Old Image

The admin UI was added after the initial release. Rebuild the image:

```bash
docker compose down
docker compose build --no-cache jimbomesh-still
docker compose up -d
```

### Admin UI Login Fails

**Symptom**: Entering the API key shows "Invalid API key"

**Diagnosis**:
```bash
# Verify the API key works via curl
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/admin/api/status
```

**Solution**: Ensure you're using the same `JIMBOMESH_HOLLER_API_KEY` value from your `.env` file.

### Admin UI Shows "Unhealthy"

**Symptom**: Dashboard shows red health indicator

**Cause**: The gateway cannot reach Ollama on the internal port.

**Diagnosis**:
```bash
# Check if Ollama is running
docker exec jimbomesh-still curl -s http://127.0.0.1:11435/api/tags
```

**Solution**: Check container logs for Ollama startup errors:
```bash
docker logs jimbomesh-still
```

### Forgot API Key / Can't Log In

**Symptom**: You can't remember the API key to log into the Admin UI

**Solutions** (try in order):

1. **Check your `.env` file**:
   ```bash
   grep JIMBOMESH_HOLLER_API_KEY .env
   ```

2. **Use the auto-login URL**: If you saved the setup output, look for the URL:
   ```
   http://localhost:1920/admin#key=YOUR_KEY_HERE
   ```

3. **Copy from Admin UI**: If already logged in, go to Configuration > Security and click Copy — this copies `JIMBOMESH_HOLLER_API_KEY=<key>` ready to paste into `.env`

4. **Regenerate via Admin UI**: If already logged in on another tab, go to Configuration > Security > Regenerate Key

5. **Reset via `.env`**: Edit `.env` with a new key, then restart:
   ```bash
   # Generate a new key
   openssl rand -hex 32
   # Edit .env with the new key, then:
   docker compose restart
   ```

### 401 Flood in Container Logs

**Symptom**: Docker logs show repeated `[api-gateway] 172.x.x.x - 401 Missing API key` messages

**Root Cause**: Something is polling the API gateway port (1920) without providing an API key. Common causes:
- An older installer version polling `http://localhost:1920/api/tags` during its wait loop
- External monitoring hitting the gateway without auth

**Solution**: Update your installer scripts. The current versions poll the unauthenticated health endpoint `http://localhost:9090/healthz` instead.

---

## Mesh Connectivity Issues

### Mesh Stays Disconnected After Restart

**Symptom**: Mesh card remains in `disconnected` state after container restart.

**Checks**:

```bash
# Verify Mesh API key is set
grep JIMBOMESH_API_KEY .env

# Verify Mesh status from admin API
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/admin/api/mesh/status
```

**Solution**:

1. Set a valid `JIMBOMESH_API_KEY` in `.env`
2. Ensure auto-connect is enabled (`JIMBOMESH_AUTO_CONNECT=true`) or connect manually in the Admin UI Mesh tab
3. Restart:
   ```bash
   docker compose restart jimbomesh-still
   ```

### Mesh Connect Fails with Coordinator Errors

**Symptom**: Mesh status shows `error` or repeated reconnect attempts.

**Checks**:

```bash
# Confirm effective coordinator URL in status output
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/admin/api/mesh/status
```

**Notes**:

- `JIMBOMESH_COORDINATOR_URL` takes precedence over `JIMBOMESH_MESH_URL`
- If both are unset, default is `https://api.jimbomesh.ai`

**Solution**:

1. Set the correct coordinator URL in `.env`
2. Save/retry from Mesh tab or restart container
3. Check gateway logs for outbound connection/auth errors:
   ```bash
   docker logs jimbomesh-still
   ```

### WebRTC Peers Never Appear

**Symptom**: Mesh is connected, but `GET /admin/api/mesh/peers` always returns zero active peers.

**Checks**:

```bash
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/admin/api/mesh/peers
```

**Possible Causes**:

- No active Mesh jobs assigned yet
- Jobs are using HTTP polling fallback (no signaling metadata)
- `MAX_PEER_CONNECTIONS=0` disables WebRTC

**Solution**:

1. Verify `.env` does not set `MAX_PEER_CONNECTIONS=0`
2. Keep Mesh connected and test again during active workload
3. Confirm Mesh status log in Admin UI for WebRTC initialization messages

---

## Installer Issues

### zsh: permission denied: ./setup.sh

**Symptom**:
```bash
zsh: permission denied: ./setup.sh
```

**Root Cause**: `setup.sh` does not have the executable bit set.

**Solution**:
```bash
chmod +x setup.sh
./setup.sh
```

Alternative (without changing permissions):
```bash
bash setup.sh
```

### PowerShell Syntax Error on setup.ps1

**Symptom**:
```
ParserError: An expression was expected after '('
```

**Root Cause**: Old version of `setup.ps1` contained bash syntax (`fprint_banner() {`).

**Solution**: Pull the latest version. The script now uses proper PowerShell `Write-Banner` function syntax.

### Installer Wants to Re-Download Models

**Symptom**: Running the setup script again starts pulling models

**Solution**: The installer now detects existing installations and shows an 8-option menu:

```text
1) Update      2) Restart      3) Reconfigure      4) Stop
5) Quick Start 6) Uninstall    7) Nuclear          8) Cancel
```

For normal upgrades, choose **1) Update** to rebuild/restart without touching model volumes.
Choose **3) Reconfigure** only if you want to re-run prompts (GPU/Qdrant/mesh) while preserving existing `.env` values.
Avoid **6) Uninstall** and **7) Nuclear** unless you intentionally want destructive cleanup.

If you ran the installer before it had the detection feature, models still persist on the volume — `docker compose up --build -d` rebuilds only the image.

### GPU Not Detected on Windows

**Symptom**: Installer defaults to CPU even though you have an NVIDIA GPU

**Diagnosis**:
```powershell
nvidia-smi
```

If this command fails, the NVIDIA driver or Container Toolkit isn't installed.

**Solution**: Install [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), restart Docker, and run the setup script again. Or use `-WithGpu` to force GPU mode.

---

## macOS Performance Mode Issues

### Installer Offers P/S Mode — What Is This?

**Explanation**: Docker Desktop on macOS runs in a Linux VM with no Metal GPU passthrough — Ollama inside Docker is always CPU-only. **Performance Mode** solves this by running Ollama natively on your Mac via Homebrew, while Docker handles only the API gateway and authentication. This gives full Apple Metal GPU access.

- **[P] Performance Mode** — Native Ollama + Metal GPU. Recommended for Apple Silicon Macs.
- **[S] Secure Mode** — Fully Docker-based, CPU-only. Recommended for shared or managed machines.

See [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md) for the full guide.

---

### Native Ollama Not Responding After Setup

**Symptom**: After selecting Performance Mode, the Admin UI shows "Unhealthy" or the gateway cannot reach Ollama.

**Diagnosis**:
```bash
# Check if Ollama launchd service is running
brew services list | grep ollama

# Try Ollama directly
ollama list

# Check if it's listening on localhost only
lsof -iTCP:11434 -sTCP:LISTEN
```

**Solutions**:

#### Service Not Running
```bash
brew services start ollama
# Wait a few seconds, then verify:
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/api/tags
```

#### Service Started but Not Listening
```bash
# Check Ollama logs
cat ~/Library/Logs/Homebrew/ollama/stderr
```

#### Restart the Gateway After Fixing Ollama
```bash
docker compose restart jimbomesh-still
```

---

### `host.docker.internal` Not Resolving

**Symptom**: Container logs show connection refused errors to `host.docker.internal:11434`

```
[api-gateway] Ollama health check failed: connect ECONNREFUSED host.docker.internal:11434
```

**Diagnosis**:
```bash
# Test resolution from inside the container
docker exec jimbomesh-still curl http://host.docker.internal:11434/api/tags
```

**Solutions**:

#### Docker Desktop Not Running
`host.docker.internal` is provided by Docker Desktop. Ensure it's running:
```bash
open -a "Docker Desktop"
```

#### `docker-compose.mac.yml` Not Loaded
Verify the overlay is active:
```bash
grep COMPOSE_FILE .env
# Should show: COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml
```

If missing, regenerate it:
```bash
./setup.sh
# Select [P] Performance Mode again (it detects existing install and won't reset your .env)
```

#### Ollama Listening on Wrong Address
Ollama must be bound to `localhost`, not `0.0.0.0`. Binding to `0.0.0.0` can cause routing issues.
```bash
lsof -iTCP:11434 -sTCP:LISTEN
# Should show: ollama  ... TCP localhost:11434 (LISTEN)
```

---

### Metal GPU Not Being Used

**Symptom**: Embeddings are fast but not as fast as expected; `ollama ps` shows model loaded on CPU.

**Diagnosis**:
```bash
# Check if Ollama sees the GPU
ollama list  # Models should show
# Run a quick embedding and watch Activity Monitor GPU usage
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/api/embed \
  -d '{"model":"nomic-embed-text","input":"test"}'
```

**Solutions**:

#### Running Inside Docker (Not Performance Mode)
The most common cause — Ollama is running inside the Docker container (CPU-only), not natively.

```bash
# Confirm Ollama is running natively, not inside the container
ps aux | grep ollama
# Should show: /opt/homebrew/bin/ollama serve
# NOT: /usr/bin/ollama serve (inside container path)
```

If it's running inside Docker, switch to Performance Mode:
```bash
./setup.sh  # Select [P] Performance Mode
```

#### Ollama Version Is Old
```bash
brew upgrade ollama
brew services restart ollama
```

---

### Model Management Differences

In Performance Mode, models are stored on the host (`~/.ollama/models/`), not in a Docker volume.

| Action | Secure Mode (Docker) | Performance Mode (Host) |
|--------|---------------------|------------------------|
| List models | `docker exec jimbomesh-still ollama list` | `ollama list` |
| Pull model | `docker exec jimbomesh-still ollama pull <model>` | `ollama pull <model>` |
| Remove model | `docker exec jimbomesh-still ollama rm <model>` | `ollama rm <model>` |
| Model storage | Docker volume `ollama_models` | `~/.ollama/models/` |
| Backup | `docker run ... tar czf ...` | `tar czf ~/.ollama/models/` |

The Admin UI Models tab works the same in both modes.

---

### Switching from Secure Mode to Performance Mode

```bash
./setup.sh
# Select [P] Performance Mode
# The setup script detects your existing .env and updates COMPOSE_FILE
```

Models will be re-downloaded from Ollama's registry (Docker volume models cannot be transferred to native format). If you have large models, the first setup may take several minutes.

### Switching from Performance Mode to Secure Mode

```bash
# Remove the compose overlay activation from .env
sed -i '' 's|COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml|#COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml|' .env

# Restart — container will now start its own Ollama
docker compose up -d --force-recreate
```

Models will be re-downloaded into the Docker volume on first start.

### Uninstalling Native Ollama

If you switch to Secure Mode and no longer need native Ollama:

```bash
brew services stop ollama
brew uninstall ollama
rm -rf ~/.ollama  # Removes all models — irreversible!
```

See [UNINSTALL-OLLAMA.md](../UNINSTALL-OLLAMA.md) for the complete uninstall checklist.

---

### Marketplace Tab Shows "CPU Only" Instead of Metal

**Symptom**: Admin UI Marketplace tab VRAM bar shows "CPU Only" even though you are in Performance Mode.

**Diagnosis**:
```bash
# Confirm the mac overlay is active
grep COMPOSE_FILE .env
# Expected: COMPOSE_FILE=docker-compose.yml:docker-compose.mac.yml

# Confirm OLLAMA_EXTERNAL_URL is set inside the container
docker exec jimbomesh-still env | grep OLLAMA_EXTERNAL_URL
# Expected: OLLAMA_EXTERNAL_URL=http://host.docker.internal:11434
```

**Cause**: GPU detection reads `OLLAMA_EXTERNAL_URL` to determine mode. If the variable is absent, the gateway falls back to CPU mode display.

**Solution**: Ensure `docker-compose.mac.yml` is applied. If `COMPOSE_FILE` is missing from `.env`, re-run setup:
```bash
./setup.sh  # Select [P] Performance Mode
docker compose up -d --force-recreate
```

---

### Marketplace Tab Shows "No data" or VRAM Bar Is Missing

**Symptom**: VRAM bar area is empty or shows an error message.

**Cause**: The `/admin/api/gpu-info` call failed (Ollama unreachable, or a transient startup error).

**Diagnosis**:
```bash
# Test the endpoint directly
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/admin/api/gpu-info
```

**Solution**: If Ollama is still starting up, wait a few seconds and reload the Marketplace tab. If Ollama is unreachable, check `docker logs jimbomesh-still` for gateway errors.

---

## Performance Issues

### Slow Embeddings

**Symptom**: Embedding requests take 3-5+ seconds

**Diagnosis**:
```bash
# Time a request
time curl -H "X-API-Key: YOUR_KEY" \
  -X POST http://localhost:1920/api/embed \
  -H "Content-Type: application/json" \
  -d '{"model":"nomic-embed-text","input":"test"}'

# Check if model is loaded
docker exec jimbomesh-still ps aux | grep ollama
```

**Solutions**:

#### First Request After Start (Model Loading)
- **Cause**: Model not in memory yet
- **Solution**: Wait for first request to complete (~30s), subsequent requests will be fast

#### CPU-Only Mode
- **Cause**: No GPU acceleration
- **Solution**: Enable GPU mode by adding to `.env`:
  ```
  COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
  ```
  Then `docker compose up -d`. Requires NVIDIA GPU + nvidia-container-toolkit.

#### Network Latency
- **Cause**: Cross-machine requests (Mac → Windows)
- **Typical**: 50-200ms additional latency
- **Solution**: Consider local Ollama instance on Mac for production use

#### Model Keep-Alive Too Short
- **Cause**: Model unloads between requests
- **Solution**: Increase keep-alive:
  ```bash
  echo "OLLAMA_KEEP_ALIVE=30m" >> .env
  docker compose restart
  ```

### High Memory Usage

**Symptom**: System running out of RAM

**Diagnosis**:
```bash
docker stats jimbomesh-still
```

**Solutions**:

1. **Limit concurrent models**:
   ```bash
   OLLAMA_MAX_LOADED_MODELS=1  # Default: 2
   ```

2. **Reduce parallelism**:
   ```bash
   OLLAMA_NUM_PARALLEL=2  # Default: 4
   ```

3. **Use smaller model**:
   ```bash
   # Instead of llama3.1:8b (4.9GB)
   HOLLER_MODELS=nomic-embed-text,llama3.2:3b  # 2.0GB
   ```

---

## Debugging Commands

### Check Container Health

```bash
# Container status
docker ps --filter name=jimbomesh-still

# Full logs
docker logs jimbomesh-still

# Follow logs
docker logs -f jimbomesh-still

# Last 50 lines
docker logs jimbomesh-still --tail 50

# Health check
curl http://localhost:9090/healthz
curl http://localhost:9090/readyz
curl http://localhost:9090/status
```

### Check Models

```bash
# List models
docker exec jimbomesh-still ollama list

# Model details
docker exec jimbomesh-still ollama show nomic-embed-text

# Test embedding
docker exec jimbomesh-still ollama run nomic-embed-text "test"
```

### Check Qdrant

```bash
# List collections
curl -H "api-key: ${QDRANT_API_KEY}" http://localhost:6333/collections

# Collection info
curl -H "api-key: ${QDRANT_API_KEY}" \
  http://localhost:6333/collections/knowledge_base

# Search test
curl -X POST -H "api-key: ${QDRANT_API_KEY}" \
  -H "Content-Type: application/json" \
  http://localhost:6333/collections/knowledge_base/points/search \
  -d '{
    "vector": [0.1, 0.2, ...],  # 768 dimensions
    "limit": 5
  }'
```

### Reset Everything

```bash
# WARNING: Deletes all data!

# Stop all containers
docker compose --profile qdrant down

# Remove volumes
docker volume rm jimbomesh-holler_ollama_models
docker volume rm jimbomesh-holler_qdrant_storage

# Rebuild and restart
docker compose build --no-cache
docker compose --profile qdrant up -d
```

---

## Getting Help

If you encounter issues not covered here:

1. **Check logs**: `docker logs jimbomesh-still`
2. **Verify configuration**: Review `.env` and `docker-compose.yml`
3. **Test components individually**: Ollama API, Qdrant API, network connectivity
4. **Search issues**: [GitHub Issues](https://github.com/IngressTechnology/jimbomesh-holler-server/issues)
5. **File a bug**: Include logs, configuration, and reproduction steps

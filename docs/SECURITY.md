# Security Guide

Security model, trust boundaries, and hardening recommendations for JimboMesh Holler Server.

## Deployment Mode Security Comparison

The Holler Server supports two distinct security profiles on macOS. On Linux and Windows, only the equivalent of Secure Mode applies.

| Property | Secure Mode (Docker CPU) | Performance Mode (Native Ollama) |
|----------|--------------------------|----------------------------------|
| **Ollama isolation** | Full container isolation (Linux namespace, cgroups) | Host process; limited by OS user permissions |
| **Model file access** | Docker volume (`ollama_models`) — not accessible from host filesystem directly | `~/.ollama/models/` — readable by any process running as your user |
| **API exposure** | Internal port only (Docker bridge) — not reachable from host except via gateway | `localhost:11434` on host — any host process can reach it |
| **Gateway protection** | All Ollama traffic flows through authenticated gateway | Host processes can bypass the gateway by calling `localhost:11434` directly |
| **Attack surface** | Smaller — container boundary limits blast radius | Larger — Ollama responds to unauthenticated requests from any local process |
| **Multi-user machines** | Recommended — models not accessible to other user accounts | Not recommended — other users could call Ollama via shared `localhost` |
| **Personal dev machines** | Works well, but no Metal GPU | Recommended — full Metal GPU + acceptable risk profile on single-user Mac |

### Recommendation by Use Case

| Use Case | Recommendation |
|----------|----------------|
| Personal Apple Silicon Mac (solo developer) | Performance Mode |
| Shared macOS machine (multi-user, office) | Secure Mode |
| Linux server (development or production) | Secure Mode (default) |
| Linux server with NVIDIA GPU | NVIDIA GPU Mode (Secure Mode + GPU overlay) |
| CI/CD pipeline | Secure Mode |
| Windows workstation | Secure Mode (default) |

---

## Authentication

### Tiered Authentication Model

The gateway supports three authentication tiers:

| Tier | Credential | Where It Applies | Notes |
|------|------------|------------------|-------|
| Tier 1 | `X-API-Key: <key>` | All standard local API clients and admin auth | Always available; backed by `JIMBOMESH_HOLLER_API_KEY` |
| Tier 2 | `Authorization: Bearer jmh_...` | Inference and OpenAI-compatible routes | Requires Enhanced Security to be enabled |
| Tier 3 | `Authorization: Bearer <jwt>` | Inference routes in mesh-connected environments | Requires `JIMBOMESH_API_KEY` plus `data/auth0-config.json` |

Examples:

```bash
# Tier 1: API key
curl -H "X-API-Key: YOUR_KEY" http://localhost:1920/api/tags

# Tier 2: bearer token
curl -H "Authorization: Bearer jmh_..." http://localhost:1920/v1/models
```

Without a valid credential, the gateway returns `401 Unauthorized` for missing/invalid auth and `403 Forbidden` for disabled features or insufficient permissions.

### Tier 1: API Key Authentication

Tier 1 is the default and simplest auth path. The gateway refuses to start if `JIMBOMESH_HOLLER_API_KEY` is missing.

The Holler accepts your API key via two methods:

1. **`X-API-Key` header** (traditional): `X-API-Key: your-key`
2. **`Authorization: Bearer` header** (OpenAI-compatible): `Authorization: Bearer your-key`

Both methods are equivalent and use the same rate limiting. The Bearer method
is recommended for compatibility with OpenAI-compatible clients like Cursor,
Continue, LiteLLM, and OpenClaw.

**Key generation:**

```bash
openssl rand -hex 32
```

**Key rotation** (without restarting the container):

1. Admin UI → Configuration → Security → Regenerate Key
2. Type `hellyeah` to confirm
3. New key takes effect immediately (saved to SQLite `api_key_override`)
4. Update `.env` to persist across container recreations

### Tier 1 Admin Key Separation

Set `ADMIN_API_KEY` in `.env` to use a separate credential for admin routes (`/admin/api/*`):

```bash
# .env
JIMBOMESH_HOLLER_API_KEY=<inference-key>    # Used by clients for embeddings/chat
ADMIN_API_KEY=<admin-key>                   # Used for Admin UI and admin APIs
```

Without `ADMIN_API_KEY`, both admin and inference routes use `JIMBOMESH_HOLLER_API_KEY`.

### Tier 2: Bearer Tokens

Tier 2 adds named bearer tokens with:

- Scoped permissions
- Per-token rate limits
- Optional expiry
- Usage tracking
- SHA-256 hashed storage in `/data/keys.json`

Enable Tier 2 with `ENHANCED_SECURITY_ENABLED=true` or the Admin UI toggle. Token management endpoints live under the admin API:

- `GET /admin/api/auth/status`
- `GET /admin/api/tokens`
- `POST /admin/api/tokens`
- `PATCH /admin/api/tokens/:id`
- `DELETE /admin/api/tokens/:id`
- `GET /admin/api/tokens/:id/usage`

Tier 2 does not replace admin API key auth. The Admin UI still authenticates with the admin key flow.

### Tier 3: JWT / Auth0 Validation

Tier 3 is intended for mesh-connected deployments that need buyer-scoped JWT validation.

Requirements:

1. Set `JIMBOMESH_API_KEY`
2. Provide `data/auth0-config.json` with at least `domain` and `audience`
3. Ensure outbound access to the Auth0 JWKS endpoint

When active, the gateway validates RS256 JWTs against JWKS, extracts buyer permissions and rate limits, and enforces per-buyer request quotas.

### No Authentication for Health Endpoints

The following endpoints on port `9090` do **not** require authentication:

- `GET /healthz` — Ollama liveness
- `GET /readyz` — Gateway readiness (503 during shutdown)
- `GET /status` — Detailed status with model list

These are intended for infrastructure monitoring (load balancers, Kubernetes probes) and do not expose sensitive data.

---

## Network Security

### Port Exposure

| Port | Service | Auth Required | Exposed To |
|------|---------|---------------|------------|
| `1920` | API gateway | Yes (Tier 1 / Tier 2 / Tier 3 depending on route) | Configured hosts (LAN or localhost) |
| `9090` | Health server | No | Same as above |
| `6333` | Qdrant REST | Yes (`api-key`) | Same as above |
| `11435` (internal) | Ollama (Secure Mode) | No | Localhost inside container only — not mapped to host |

In Secure Mode, Ollama's port `11435` is never exposed to the host. It is accessible only from within the container, exclusively to the API gateway process.

In Performance Mode, native Ollama listens on `localhost:11434` on the host. The Docker gateway container maps its port (`1920`) separately. Only the gateway's port is accessible from external hosts via Docker port mapping.

### Firewall Configuration

For local-only use, do not expose port `1920` on the network interface. Use `localhost` binding or Docker's loopback mapping:

```bash
# .env — bind gateway to loopback only
# (requires Docker Compose port mapping change)
```

For cross-machine use (e.g., Mac → Windows setup), restrict inbound access via firewall rules to specific source IPs only. See [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md) for the cross-machine setup guide.

---

## Mesh Connectivity Security

Mesh mode is optional. When enabled, the connector makes outbound HTTPS calls to a coordinator and can process jobs via HTTP polling or WebRTC peer sessions.

### Trust and Exposure

- Mesh traffic is outbound from this Holler to the coordinator (no inbound coordinator connection required)
- Coordinator URL should be trusted and explicitly set in regulated environments (`JIMBOMESH_COORDINATOR_URL`)
- WebRTC peers are limited by `MAX_PEER_CONNECTIONS` (set `0` to disable WebRTC)
- Standalone/off-grid operation is preserved by leaving Mesh credentials unset

### Recommended Controls

1. Keep `JIMBOMESH_API_KEY` secret and rotate if leaked
2. Prefer explicit `JIMBOMESH_COORDINATOR_URL` over implicit defaults
3. Set conservative `MAX_PEER_CONNECTIONS` based on host capacity
4. Use egress firewall policies to allow only approved coordinator domains

---

## macOS Performance Mode Hardening

`setup.sh` applies these hardening steps automatically when Performance Mode is selected:

1. **Localhost-only binding** — Verifies Ollama binds to `localhost`, not `0.0.0.0`. If `0.0.0.0` binding is detected, the installer warns and exits.
2. **Restricted model directory** — Sets `chmod 700 ~/.ollama` so only your user account can read model weights.
3. **Security warning** — Displays a mandatory explanation of the security tradeoffs before proceeding.

**Verify the hardening after setup:**

```bash
# Confirm localhost-only binding
lsof -iTCP:11434 -sTCP:LISTEN
# Should show: TCP localhost:11434 (LISTEN)
# Should NOT show: TCP *:11434 (LISTEN)

# Confirm model directory permissions
ls -la ~ | grep .ollama
# Should show: drwx------  (700 permissions, your user only)
```

---

## Rate Limiting

The gateway enforces per-IP rate limits to prevent abuse:

| Setting | Default | Description |
|---------|---------|-------------|
| `RATE_LIMIT_PER_MIN` | `60` | Max requests per minute per IP |
| `RATE_LIMIT_BURST` | `10` | Allow short bursts above the per-minute limit |

Rate limits are backed by SQLite and survive container restarts. The gateway returns `429 Too Many Requests` with a `Retry-After` header when limits are exceeded.

---

## TLS / HTTPS

Optional HTTPS support via `TLS_CERT_PATH` and `TLS_KEY_PATH` environment variables:

```bash
# .env
TLS_CERT_PATH=/path/to/fullchain.pem
TLS_KEY_PATH=/path/to/privkey.pem
# TLS_PASSPHRASE=optional-passphrase-for-encrypted-key
```

Both variables must be set together. If only one is provided, the server refuses to start. If neither is set, HTTP is used (default).

For production deployments, consider terminating TLS at a reverse proxy (nginx, Caddy, Traefik) in front of the gateway rather than configuring TLS directly.

---

## RAG Trust Boundaries

The document Q&A pipeline wraps retrieved context in XML tags before passing it to the LLM:

```xml
<retrieved_context>
  chunk content here...
</retrieved_context>
```

This pattern (XML tagging of external content) is a recognized mitigation against prompt injection via document content. The LLM receives clear structural boundaries between system instructions and retrieved data.

**Recommendation:** Never include raw retrieved text in system prompts without delimiters. Always treat document content as untrusted input.

---

## Secrets Management

### What to Keep Secret

- `JIMBOMESH_HOLLER_API_KEY` — Grants full API access (inference + admin if no separate `ADMIN_API_KEY`)
- `ADMIN_API_KEY` — Grants admin access if configured
- Bearer tokens (`jmh_*`) — Grant scoped inference access when Enhanced Security is enabled
- `JIMBOMESH_API_KEY` — Grants mesh coordinator access
- `QDRANT_API_KEY` — Grants access to all Qdrant collections and vector data
- `GITHUB_TOKEN` — Can create issues on the configured repository
- `data/auth0-config.json` — Contains Auth0 issuer/audience settings for JWT validation

### What Is Safe to Share

- API gateway port and URL (authentication is enforced)
- Health endpoint port and URL (no sensitive data exposed)
- Admin UI URL (requires valid API key to use)

### `.env` File Permissions

```bash
# Restrict .env to your user only
chmod 600 .env
```

The `.env` file is listed in `.gitignore`. Never commit it to version control.

---

## Vulnerability Reporting

Found a security issue? Please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities
2. Email **security@jimbomesh.ai**, or
3. Use [GitHub Security Advisories](https://github.com/IngressTechnology/jimbomesh-holler-server/security/advisories) to report privately

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested mitigation (optional)

---

## Related Documentation

- [MAC_WINDOWS_SETUP.md](MAC_WINDOWS_SETUP.md) — Performance Mode vs Secure Mode detailed comparison
- [CONFIGURATION.md](CONFIGURATION.md) — All security-related environment variables
- [UNINSTALL-OLLAMA.md](../UNINSTALL-OLLAMA.md) — Removing native Ollama
- [ARCHITECTURE.md](ARCHITECTURE.md) — Trust boundaries and data flow

# Naming Convention

This document explains the project's naming hierarchy.

## Hierarchy

```
jimbomesh-holler-server/              ← Repository/Project name
├── docker-compose.yml                ← Base compose (always loaded)
├── docker-compose.gpu.yml            ← GPU overlay (loaded via COMPOSE_FILE in .env)
│   ├── name: jimbomesh-holler        ← Docker Compose project name
│   └── services:
│       ├── jimbomesh-still           ← Main Ollama service
│       ├── jimbomesh-qdrant          ← Qdrant service (profile: qdrant)
│       └── init-qdrant               ← Qdrant initializer
├── Images:
│   └── jimbomesh-still:latest        ← Docker image for main service
└── Containers:
    ├── jimbomesh-still               ← Main container name
    ├── jimbomesh-holler-qdrant       ← Qdrant container (uses compose project prefix)
    └── jimbomesh-holler-init-qdrant  ← Init container (uses compose project prefix)
```

## Rationale

- **Repository**: `jimbomesh-holler-server` — The overall project that can contain multiple services
- **Compose Project**: `jimbomesh-holler` — Groups all related services together
- **Main Service**: `jimbomesh-still` — One instance of an Ollama server (GPU via compose override)
- **Supporting Services**: Use compose project prefix for clarity (`jimbomesh-holler-qdrant`)

This allows for future expansion where `jimbomesh-holler-server` could run multiple different Ollama instances (e.g., `jimbomesh-still`, `jimbomesh-water`, `jimbomesh-shine`) all under the same project.

## Usage Examples

```bash
# Start (CPU, default)
docker compose up -d

# Start with GPU (after setting COMPOSE_FILE in .env)
docker compose up -d

# Start with Qdrant
docker compose --profile qdrant up -d

# Stop (always works — no profile flags needed for GPU)
docker compose down
```

## Network

All services join the `jimbomesh-holler_default` network (automatically created by Docker Compose using the project name).

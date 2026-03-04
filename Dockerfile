# JimboMesh Holler Server — On-Prem Embeddings & LLM Service
# Provides local embedding generation and optional LLM inference.
#
# Build:
#   docker build -t jimbomesh-still:latest .
#   docker compose build jimbomesh-still
#
# The image pulls and warms specified models on first startup via the entrypoint.

FROM ollama/ollama:0.17.4

# Install curl, jq, bash, socat for healthcheck and init scripts
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    bash \
    socat \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x (LTS) from NodeSource for API gateway and better-sqlite3
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy entrypoint (production lifecycle: start → wait → pull models → serve)
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Install Node.js dependencies (better-sqlite3)
COPY package.json package-lock.json /opt/jimbomesh-still/
# wrtc postinstall calls `node-pre-gyp` directly; install it globally so npm v10+ can resolve it.
RUN npm install -g node-pre-gyp \
    && cd /opt/jimbomesh-still \
    && npm ci --production

# Copy API gateway, SQLite layer, and admin UI
COPY api-gateway.js /opt/jimbomesh-still/api-gateway.js
COPY db.js /opt/jimbomesh-still/db.js
COPY stats-collector.js /opt/jimbomesh-still/stats-collector.js
COPY mesh-connector.js /opt/jimbomesh-still/mesh-connector.js
COPY mesh-webrtc.js /opt/jimbomesh-still/mesh-webrtc.js
COPY admin-routes.js /opt/jimbomesh-still/admin-routes.js
COPY qdrant-client.js /opt/jimbomesh-still/qdrant-client.js
COPY document-pipeline.js /opt/jimbomesh-still/document-pipeline.js
COPY token-manager.js /opt/jimbomesh-still/token-manager.js
COPY jwt-validator.js /opt/jimbomesh-still/jwt-validator.js
COPY swagger-brand.css /opt/jimbomesh-still/swagger-brand.css
COPY swagger-brand.js /opt/jimbomesh-still/swagger-brand.js
COPY openapi.yaml /opt/jimbomesh-still/openapi.yaml
COPY db.js /opt/jimbomesh-still/db.js
COPY admin/ /opt/jimbomesh-still/admin/

# Create non-root user for the Node.js gateway and health server
# Ollama itself still runs as root (upstream requirement), but the gateway
# and health server drop privileges to this user via the entrypoint.
RUN addgroup --system jimbomesh && adduser --system --ingroup jimbomesh jimbomesh

# Create data directory for SQLite database (owned by jimbomesh)
RUN mkdir -p /opt/jimbomesh-still/data && chown -R jimbomesh:jimbomesh /opt/jimbomesh-still/data

# Copy utility scripts
COPY scripts/healthcheck.sh /opt/jimbomesh-still/healthcheck.sh
COPY scripts/embed.sh /opt/jimbomesh-still/embed.sh
COPY scripts/init-qdrant.sh /opt/jimbomesh-still/init-qdrant.sh
COPY scripts/health-server.sh /opt/jimbomesh-still/health-server.sh
COPY scripts/health-server.js /opt/jimbomesh-still/health-server.js

RUN chmod +x /usr/local/bin/docker-entrypoint.sh /opt/jimbomesh-still/*.sh /opt/jimbomesh-still/api-gateway.js

# Ollama stores models in /root/.ollama by default
# This is mapped to a named volume for persistence
VOLUME ["/root/.ollama"]

EXPOSE 1920
EXPOSE 9090

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

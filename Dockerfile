# IICP TypeScript node — runs an @iicp/client provider node out of the box.
#
#   docker build -t iicp-node-ts .
#   docker run --restart on-failure -p 8020:8020 \
#     -e IICP_BACKEND_URL=http://host.docker.internal:11434 \
#     -e IICP_BACKEND_MODEL=qwen2.5:0.5b \
#     -e IICP_PUBLIC_ENDPOINT=http://<your-public-ip>:8020 \
#     iicp-node-ts
#
# Required env vars:
#   IICP_BACKEND_URL    — OpenAI-compatible backend (Ollama / vLLM / LM Studio)
#   IICP_BACKEND_MODEL  — model name (e.g. qwen2.5:0.5b)
#
# Optional:
#   IICP_PUBLIC_ENDPOINT — externally reachable URL of this node. If omitted,
#                          the node tries automatic reachability (Quick Tunnel
#                          first, relay last-resort) before staying local.
#   IICP_TUNNEL_DEAD_POLICY — auto|retry|exit|log-only; default auto exits when
#                          supervised so Docker can restart, manual runs retry.
#   IICP_SUPERVISED   — default 1 in this image; keep with --restart on-failure.
#
# See https://iicp.network/docs/sdk-quickstart-docker for the full setup guide.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# Install optional peer deps used at runtime (cbor-x for IICP TCP, prom-client
# for /metrics). nat-upnp is omitted — node-gyp + lxml-style build fails on
# slim images and isn't needed for HTTP-only nodes.
RUN npm install && npm install --no-save cbor-x prom-client
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
      amd64) cf_arch=amd64 ;; \
      arm64) cf_arch=arm64 ;; \
      *) echo "unsupported architecture for cloudflared: $arch" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}" -o /usr/local/bin/cloudflared \
  && chmod +x /usr/local/bin/cloudflared \
  && cloudflared --version >/dev/null \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
RUN chmod +x /app/dist/cli.js && ln -sf /app/dist/cli.js /usr/local/bin/iicp-node
ENV IICP_SUPERVISED=1 \
    IICP_TUNNEL_DEAD_POLICY=auto
EXPOSE 8020
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "require('http').get('http://localhost:8020/iicp/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/cli.js", "serve"]

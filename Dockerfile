# IICP TypeScript node — runs an @iicp/client provider node out of the box.
#
#   docker build -t iicp-node-ts .
#   docker run -p 8020:8020 \
#     -e IICP_BACKEND_URL=http://host.docker.internal:11434 \
#     -e IICP_BACKEND_MODEL=qwen2.5:0.5b \
#     -e IICP_PUBLIC_ENDPOINT=http://<your-public-ip>:8020 \
#     iicp-node-ts
#
# Required env vars:
#   IICP_BACKEND_URL    — OpenAI-compatible backend (Ollama / vLLM / LM Studio)
#   IICP_BACKEND_MODEL  — model name (e.g. qwen2.5:0.5b)
#   IICP_PUBLIC_ENDPOINT — externally reachable URL of this node
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
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 8020
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "require('http').get('http://localhost:8020/iicp/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/cli.js", "serve"]

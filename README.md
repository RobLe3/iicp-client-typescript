# iicp-client · TypeScript / JavaScript SDK

[![CI](https://github.com/RobLe3/iicp-client-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/RobLe3/iicp-client-typescript/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Protocol](https://img.shields.io/badge/IICP-v1.7-indigo.svg)](https://iicp.network/spec)
[![npm](https://img.shields.io/badge/npm-%40iicp%2Fclient-red?logo=npm)](https://www.npmjs.com/package/@iicp/client)

Official TypeScript client library for the [IICP protocol](https://iicp.network) — route AI agent tasks by intent across a self-organising mesh of provider nodes. No central broker. No hardcoded endpoints.

Works in **Node.js ≥ 18**, Deno, Bun, and modern browsers with the native Fetch API.

```
urn:iicp:intent:llm:chat:v1  →  discover  →  select  →  submit
```

---

## Install

```bash
npm install @iicp/client
# yarn add @iicp/client
# pnpm add @iicp/client
```

> **Upgrade note (0.5.3)** — if you operate a node and use the native IICP
> TCP transport on port 9484, upgrade to `^0.5.3`. Releases 0.5.0–0.5.2
> emitted a non-standard CBOR dialect that does not interoperate with the
> Python or Rust SDK on the binary transport. The HTTP `/v1/task` path is
> unaffected. See [`CHANGELOG.md`](./CHANGELOG.md) for details.

---

## Architecture — consumer or provider?

This SDK covers **both** sides of the IICP protocol:

| Role | What you do | Class |
|------|-------------|-------|
| **Consumer** | Send AI tasks to the mesh; discover and submit | `IicpClient` |
| **Provider** | Run a node, register with the directory, serve tasks | `IicpNode` |

Consumer and provider can run in the same process. For production provider nodes backed by Ollama/vLLM, see [iicp.network/docs/node-setup](https://iicp.network/docs/node-setup).

---

## Quickstart

```typescript
import { IicpClient } from "@iicp/client";

// directory_url defaults to https://iicp.network/api
const client = new IicpClient();

// chat() discovers, selects the best node, and submits in one call
const response = await client.chat(
  [{ role: "user", content: "Hello from IICP!" }],
);
console.log(response.choices[0].message.content);
```

For more control over node selection:

```typescript
const nodes = await client.discover("urn:iicp:intent:llm:chat:v1");
if (!nodes.length) throw new Error("No nodes available");

const result = await client.submit({
  intent: "urn:iicp:intent:llm:chat:v1",
  payload: { messages: [{ role: "user", content: "Hello!" }] },
});
```

---

## Configuration

```typescript
import { IicpClient } from "@iicp/client";

const client = new IicpClient({
  directory_url : "https://iicp.network/api",  // IICP directory
  timeout_ms    : 30_000,                      // max 120 000 (SDK-04)
  region        : "eu-central",                // prefer nodes in region
  api_token     : "your-token",                // optional auth token
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `directory_url` | `"https://iicp.network/api"` | IICP directory endpoint |
| `timeout_ms` | `30000` | Request timeout — max 120 000 ms |
| `region` | `undefined` | Preferred node region |
| `api_token` | `undefined` | Bearer token for authenticated nodes |

---

## Discover options

```typescript
const nodes = await client.discover("urn:iicp:intent:llm:chat:v1", {
  region        : "eu-central",  // prefer nodes in this region
  qos           : "interactive", // quality-of-service hint
  min_reputation: 0.7,           // floor on directory reputation
  limit         : 5,             // capped at 50
});
```

---

## Error handling

```typescript
import { IicpClient, IicpError } from "@iicp/client";

const client = new IicpClient();
try {
  const response = await client.chat([{ role: "user", content: "hi" }]);
} catch (e) {
  if (e instanceof IicpError) {
    console.error(`[${e.code}] ${e.message}  (HTTP ${e.status_code})`);
  }
}
```

Error codes match the [IICP error reference](https://iicp.network/docs/error-reference) — e.g. `task_timeout`, `capacity_exceeded`, `no_nodes_available`.

---

## Serving as a provider node

```typescript
import { IicpNode } from "@iicp/client";

const node = new IicpNode({
  nodeId  : "my-node-001",
  endpoint: "http://my.public.host:8020",
  intent  : "urn:iicp:intent:llm:chat:v1",
  model   : "llama3:8b",
});

const token = await node.register();
const stop = node.serve(async (task) => {
  // Return the inner result value — serve() wraps it in {result: ...}
  return { choices: [{ message: { role: "assistant", content: "Hello!" } }] };
}, { port: 8020, nodeToken: token });

process.on("SIGINT", () => { stop(); });
```

### Run a node from the CLI

Installing the package puts an `iicp-node` binary on your `PATH`. The CLI wires
up NAT detection, registration, heartbeats and a backend handler for you:

```bash
# Ollama on the default port — only --model is required
iicp-node serve --model qwen2.5:0.5b

# An OpenAI-compatible backend (LM Studio, vLLM, hosted gateway)
iicp-node serve \
  --model phi3:mini \
  --backend-url http://localhost:1234 \
  --backend-api-key "$BACKEND_API_KEY"
```

Every flag has an environment-variable equivalent (shown by `iicp-node --help`):
`--model` / `IICP_BACKEND_MODEL`, `--backend-url` / `IICP_BACKEND_URL`,
`--backend-type` / `IICP_BACKEND_TYPE`, `--backend-api-key` / `IICP_BACKEND_API_KEY`,
`--directory-url` / `IICP_DIRECTORY_URL` (default `https://iicp.network/api`),
`--port` / `IICP_PORT` (default 9484).

### Backend types

`--backend-type` (or the `getBackendHandler(type, opts)` factory) selects how the
node talks to your model server. All backends present an identical `llm:chat:v1`
surface to IICP clients:

| `--backend-type` | Handler export | Speaks | Default base URL |
|------------------|----------------|--------|------------------|
| `openai_compat` *(default)* | `openaiCompatHandler` | OpenAI `/v1/*` dialect (Ollama, LM Studio, OpenAI) | `http://localhost:11434/v1` |
| `vllm` | `vllmHandler` | OpenAI dialect, tuned for vLLM | `http://localhost:8000/v1` |
| `llamacpp` | `llamacppHandler` | OpenAI dialect, tuned for llama.cpp server | `http://localhost:8080/v1` |
| `anthropic` | `anthropicHandler` | Anthropic Messages API (`POST /v1/messages`) — first-class Claude | `https://api.anthropic.com/v1` |

#### Native Anthropic backend (v0.7.35+)

The `anthropic` backend speaks the Anthropic **Messages API** directly rather than
going through the OpenAI-compat shim. It translates an IICP `llm:chat:v1` task into a
Messages request — hoisting `system` messages to the top-level `system` field, setting
the required `max_tokens` (default 4096), mapping `image_url` content parts to
Anthropic image blocks — and maps the response back to the OpenAI chat-completion
shape, so a Claude-backed node is indistinguishable from an Ollama/vLLM node to any
client. The API key is sent as the `x-api-key` header (not a Bearer token).

```bash
# Serve Claude to the mesh. --backend-type anthropic defaults --backend-url to
# https://api.anthropic.com, so you only supply the key and model.
iicp-node serve \
  --backend-type anthropic \
  --backend-api-key "$ANTHROPIC_API_KEY" \
  --model claude-opus-4-8
```

In code:

```typescript
import { IicpNode, anthropicHandler } from "@iicp/client";

const node = new IicpNode({
  nodeId  : "claude-node-001",
  endpoint: "http://my.public.host:8020",
  intent  : "urn:iicp:intent:llm:chat:v1",
  model   : "claude-opus-4-8",
});
const handler = anthropicHandler({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model : "claude-opus-4-8",
  // baseUrl defaults to https://api.anthropic.com/v1
});
const token = await node.register();
node.serve(handler, { port: 8020, nodeToken: token });
```

### Multimodal capabilities — vision and audio

When a node registers, the SDK derives the `input_modalities` it advertises from the
model name (`buildCapabilities` / `modalitiesForModel`). Every model serves `text`;
in addition:

- **image** (vision) — model name contains `vl`, `vision`, `llava`, or `omni`
- **audio** — model name contains `audio`, `voxtral`, or `omni`

A node serving several models advertises one capability entry per
`(intent, input_modalities)` group, so consumers can pick the right model for a
multimodal task via discover.

### Listen port — default 9484, auto-increment (v0.7.5+)

The official IICP port **9484** is the default listen port (`IICP_PORT`, `--port`).
The `iicp-node` CLI auto-increments to the next free port when 9484 is already in
use, so several nodes on one host don't need hand-picked ports — first binds 9484,
second 9485, third 9486, etc. Each node gets its own port (hence its own NAT
pinhole); multiple models on one node share that single port. Auto-increment is
skipped when you pass an explicit `--public-endpoint`. `node.serve(handler, { port })`
uses the port you give it as-is (no auto-increment at the library level).

---

## NAT traversal — automatic (v0.7.3+)

Since v0.7.3, NAT detection runs automatically on every node startup — no flags needed.
The SDK tries each path in order and picks the best one for your network:

| Tier | When | What happens |
|------|------|-------------|
| **0** | VPS/cloud (public IP on NIC) or `IICP_PUBLIC_ENDPOINT` set | Registers directly |
| **1a** | Home router with UPnP, no CGNAT | Port-forward via UPnP → register WAN IP |
| **1b** | CGNAT + IPv6 + AddPinhole works | Registers IPv6 with firewall rule |
| **1c** | CGNAT + IPv6 + AddPinhole fails (e.g. FRITZ!Box error 606) | Registers IPv6 + logs guidance |
| **3** | CGNAT + no usable IPv6 | Auto-elects relay from directory |
| **4** | Nothing worked | Serves locally with operator guidance |

### Environment-specific behaviour

**Docker bridge (`-p 8020:8020`)** — UPnP is skipped (it would reach Docker NAT, not your
home router). Set `IICP_PUBLIC_ENDPOINT` in `docker-compose.yml`:

```yaml
environment:
  IICP_PUBLIC_ENDPOINT: "http://your-host-ip:8020"
  IICP_BACKEND_URL: "http://host.docker.internal:11434"
```

Or run with `--network host` to let UPnP work as on bare metal.

**Kubernetes** — set `IICP_PUBLIC_ENDPOINT` to the LoadBalancer / NodePort IP.

**CGNAT + no IPv6 → automatic relay:**

```
[iicp-node] NAT tier=3: auto-electing relay from directory...
[iicp-node] auto-elected relay: relay.example.com:9485
```

The node connects outbound to the elected relay and re-registers automatically.
To use a specific relay: `IICP_RELAY_WORKER_ENDPOINT=relay.example.com:9485`.

### Running a relay-capable node (relay operator)

```typescript
const node = new IicpNode({
  endpoint       : "http://relay.example.com:8020",
  intent         : "urn:iicp:intent:llm:chat:v1",
  relayCapable   : true,   // accept RELAY_BIND on TCP port 9485
  relayAcceptPort: 9485,
  enableMesh     : true,   // gossip relayCapable=true to peers
});
```

### Opt-out / override

```bash
IICP_AUTO_DETECT_NAT=false              # disable detection entirely
IICP_PUBLIC_ENDPOINT=http://x.x.x.x:8020  # trust this endpoint
IICP_RELAY_WORKER_ENDPOINT=host:9485    # specific relay instead of auto-elect
```

---

## Operator identity

Your **operator identity** is an ed25519 keypair — its public key *is* your `operator_id` (the
directory stores it as `operator_pubkey`). One identity spans every node you run: it binds them to
you (nodes show **`Operated by <your name>` ✓**), earns a
[founder ordinal](https://iicp.network/founders), and rolls each node's credits into one operator
wallet. Your `display_name` is the public, mutable handle; your contact stays local.

```bash
iicp-node init                       # create your key-backed identity (~/.iicp/operator.json)
iicp-node serve --node mynode        # signs an operator→node delegation; binds the node to you
iicp-node operator rename "NewName"  # change your public display_name (signed)
iicp-node operator encrypt           # password-encrypt the secret at rest ($IICP_OPERATOR_PASSPHRASE)
iicp-node operator decrypt           # remove at-rest encryption
```

**The key is the identity** — whoever holds `~/.iicp/operator.json` controls it (its nodes, ordinal,
and wallet); there is no central recovery. Back it up (encrypted), never commit or share it; lose it
and the identity, with its founder ordinal, is gone.

Full guide: **[iicp.network/docs/operator-identity](https://iicp.network/docs/operator-identity)**

---

## SDK conformance

| Rule | Description | Status |
|------|-------------|--------|
| SDK-01 | discover → select → submit pipeline with node retry | ✓ |
| SDK-02 | `task_id` auto-generated (UUID v4) | ✓ |
| SDK-03 | Intent URN pattern validation | ✓ |
| SDK-04 | `timeout_ms` capped at 120 000 ms | ✓ |
| SDK-05 | Retry on 429 / 503 with exponential back-off | ✓ |
| SDK-06 | W3C `traceparent` propagation | ✓ |

Conformance tier: `iicp:sdk:v1` (spec S.14) · [Request a badge](https://iicp.network/conformance)

---

## Development

```bash
npm install        # install deps
npm run typecheck  # tsc strict
npm test           # 224 unit tests
npm run build      # emit to dist/
```

---

## Links

- [Protocol spec](https://iicp.network/spec) — full IICP specification
- [Node setup guide](https://iicp.network/docs/node-setup) — run your own node
- [Error reference](https://iicp.network/docs/error-reference) — all error codes
- [iicp-client-python](https://github.com/RobLe3/iicp-client-python) — Python SDK
- [iicp-client-rust](https://github.com/RobLe3/iicp-client-rust) — Rust SDK

---

Apache 2.0 · [iicp.network](https://iicp.network)

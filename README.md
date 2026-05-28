# iicp-client · TypeScript / JavaScript SDK

[![CI](https://github.com/RobLe3/iicp-client-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/RobLe3/iicp-client-typescript/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Protocol](https://img.shields.io/badge/IICP-v1.7-indigo.svg)](https://iicp.network/spec)
[![npm](https://img.shields.io/badge/npm-iicp--client-red?logo=npm)](https://www.npmjs.com/package/iicp-client)

Official TypeScript client library for the [IICP protocol](https://iicp.network) — route AI agent tasks by intent across a self-organising mesh of provider nodes. No central broker. No hardcoded endpoints.

Works in **Node.js ≥ 18**, Deno, Bun, and modern browsers with the native Fetch API.

```
urn:iicp:intent:llm:chat:v1  →  discover  →  select  →  submit
```

---

## Install

```bash
npm install iicp-client
# yarn add iicp-client
# pnpm add iicp-client
```

> **Upgrade note (0.5.3)** — if you operate a node and use the native IICP
> TCP transport on port 9484, upgrade to `^0.5.3`. Releases 0.5.0–0.5.2
> emitted a non-standard CBOR dialect that does not interoperate with the
> Python or Rust SDK on the binary transport. The HTTP `/v1/task` path is
> unaffected. See [`CHANGELOG.md`](./CHANGELOG.md) for details.

---

## Quickstart

```typescript
import { IicpClient } from "iicp-client";

const client = new IicpClient({ directory_url: "https://iicp.network" });

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
import { IicpClient } from "iicp-client";

const client = new IicpClient({
  directory_url : "https://iicp.network",  // IICP directory
  timeout_ms    : 30_000,                  // max 120 000 (SDK-04)
  region        : "eu-central",            // prefer nodes in region
  api_token     : "your-token",            // optional auth token
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `directory_url` | `"https://iicp.network"` | IICP directory endpoint |
| `timeout_ms` | `30000` | Request timeout — max 120 000 ms |
| `region` | `undefined` | Preferred node region |
| `api_token` | `undefined` | Bearer token for authenticated nodes |

---

## Discover options

```typescript
const nodes = await client.discover("urn:iicp:intent:llm:chat:v1", {
  region        : "eu-central",
  model         : "phi3:mini",
  min_reputation: 0.7,
  limit         : 5,
});
```

---

## Error handling

```typescript
import { IicpClient, IicpError } from "iicp-client";

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
import { IicpNode } from "iicp-client";

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
npm test           # 184 unit tests
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

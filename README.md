# @iicp/client · TypeScript / JavaScript SDK

[![CI](https://github.com/RobLe3/iicp-client-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/RobLe3/iicp-client-typescript/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Protocol](https://img.shields.io/badge/IICP-v1.5-indigo.svg)](https://iicp.network/spec)
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

---

## Quickstart

```typescript
import { IicpClient } from "@iicp/client";

const client = new IicpClient({ directory_url: "https://iicp.network/api" });

const { nodes } = await client.discover("urn:iicp:intent:llm:chat:v1");
if (!nodes.length) throw new Error("No nodes available");

const response = await client.chat(nodes[0], {
  messages: [{ role: "user", content: "Hello from IICP!" }],
});
console.log(response.choices[0].message.content);
```

---

## Configuration

```typescript
import { IicpClient, ClientConfig } from "@iicp/client";

const client = new IicpClient({
  directory_url : "https://iicp.network/api",   // IICP directory
  timeout_ms    : 30_000,                        // max 120 000 (SDK-04)
  region        : "eu-central",                  // prefer nodes in region
  node_token    : "your-token",                  // optional auth token
} satisfies ClientConfig);
```

| Option | Default | Description |
|--------|---------|-------------|
| `directory_url` | `"https://iicp.network/api"` | IICP directory endpoint |
| `timeout_ms` | `30000` | Request timeout — max 120 000 ms |
| `region` | `undefined` | Preferred node region |
| `node_token` | `undefined` | Bearer token for authenticated nodes |

---

## Discover options

```typescript
const { nodes } = await client.discover("urn:iicp:intent:llm:chat:v1", {
  region        : "eu-central",
  model         : "phi3:mini",
  min_reputation: 0.7,
  limit         : 5,
});
```

---

## Error handling

```typescript
import { IicpClient, IicpError } from "@iicp/client";

try {
  const response = await client.submit(node, request);
} catch (e) {
  if (e instanceof IicpError) {
    console.error(`[${e.code}] ${e.message}  (HTTP ${e.status})`);
  }
}
```

Error codes match the [IICP error reference](https://iicp.network/docs/error-reference) — e.g. `task_timeout`, `capacity_exceeded`, `no_nodes_available`.

---

## SDK conformance

| Rule | Description | Status |
|------|-------------|--------|
| SDK-01 | discover → select → submit pipeline with node retry | ✓ |
| SDK-02 | `task_id` auto-generated (UUID v4) | ✓ |
| SDK-03 | Intent URN pattern validation | ✓ |
| SDK-04 | `timeout_ms` capped at 120 000 ms | ✓ |
| SDK-05 | Retry on 429 / 503 with exponential back-off | ✓ |
| SDK-06 | W3C `traceparent` propagation | planned |

Conformance tier: `iicp:sdk:v1` (spec S.14) · [Request a badge](https://iicp.network/conformance)

---

## Development

```bash
npm install        # install deps
npm run typecheck  # tsc strict
npm test           # 16 unit tests
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

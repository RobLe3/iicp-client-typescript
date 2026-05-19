# @iicp/client — TypeScript / JavaScript SDK

Official TypeScript client library for the [IICP protocol](https://iicp.network) (Intent-based Inter-agent Communication Protocol).

Implements **ADR-016 §1** — SDK conformance rules SDK-01 through SDK-06.
Works in Node.js ≥ 18, Deno, Bun, and modern browsers with the native Fetch API.

---

## Install

```bash
npm install @iicp/client
# or
yarn add @iicp/client
# or
pnpm add @iicp/client
```

---

## Quickstart

```typescript
import { IicpClient } from "@iicp/client";

const client = new IicpClient({
  directory_url: "https://iicp.network/api",
  timeout_ms: 30_000,
});

// Discover nodes capable of LLM chat
const { nodes } = await client.discover("urn:iicp:intent:llm:chat:v1");
if (!nodes.length) throw new Error("No nodes available");

// Submit a chat task to the best node
const response = await client.chat(nodes[0], {
  messages: [{ role: "user", content: "Hello from IICP!" }],
});
console.log(response.choices[0].message.content);
```

### CommonJS (Node.js require)

```javascript
const { IicpClient } = require("@iicp/client");
const client = new IicpClient({ directory_url: "https://iicp.network/api" });
```

---

## Configuration

```typescript
import { IicpClient, ClientConfig } from "@iicp/client";

const client = new IicpClient({
  directory_url: "https://iicp.network/api", // IICP directory endpoint
  timeout_ms: 30_000,                        // max 120_000 (SDK-04)
  region: "eu-central",                      // prefer nodes in this region
  node_token: "your-token",                  // optional auth token
} satisfies ClientConfig);
```

| Option | Default | Description |
|--------|---------|-------------|
| `directory_url` | `"https://iicp.network/api"` | IICP directory endpoint |
| `timeout_ms` | `30000` | Request timeout (max 120 000 ms) |
| `region` | `undefined` | Preferred node region |
| `node_token` | `undefined` | Bearer token for authenticated nodes |

---

## Discover options

```typescript
import { DiscoverOptions } from "@iicp/client";

const { nodes } = await client.discover(
  "urn:iicp:intent:llm:chat:v1",
  {
    region: "eu-central",
    model: "phi3:mini",       // request a specific model
    min_reputation: 0.7,      // only well-regarded nodes
    limit: 5,
  } satisfies DiscoverOptions
);
```

---

## Error handling

```typescript
import { IicpClient, IicpError } from "@iicp/client";

try {
  const resp = await client.submit(request);
} catch (e) {
  if (e instanceof IicpError) {
    console.error(`[${e.code}] ${e.message}  (HTTP ${e.status})`);
  }
}
```

Error codes match the [IICP error reference](https://iicp.network/docs/error-reference).

---

## Conformance

This SDK targets the **IICP SDK conformance tier** (`iicp:sdk:v1`, spec S.14).
See [Conformance badges](https://iicp.network/conformance) for how to obtain a signed badge.

| ADR | Rule | Status |
|-----|------|--------|
| ADR-016 | SDK-01 discover → select → submit pipeline | ✓ |
| ADR-016 | SDK-02 task_id auto-generated (UUID v4) | ✓ |
| ADR-016 | SDK-03 intent validation (URN pattern) | ✓ |
| ADR-016 | SDK-04 timeout_ms ≤ 120 000 enforced | ✓ |
| ADR-016 | SDK-05 retry on 429/503 with back-off | ✓ |
| ADR-016 | SDK-06 W3C traceparent propagation | ✓ |

---

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run typecheck

# Build
npm run build

# Run tests
npm test
```

---

## Links

- Protocol spec: [iicp.network/spec](https://iicp.network/spec)
- Node setup: [iicp.network/docs/node-setup](https://iicp.network/docs/node-setup)
- Error reference: [iicp.network/docs/error-reference](https://iicp.network/docs/error-reference)
- Conformance: [iicp.network/conformance](https://iicp.network/conformance)
- GitHub issues: [github.com/RobLe3/iicp-client-typescript](https://github.com/RobLe3/iicp-client-typescript/issues)

---

**License**: Apache 2.0 · © IICP Working Group

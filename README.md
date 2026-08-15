# iicp-client · TypeScript / JavaScript SDK

[![CI](https://github.com/RobLe3/iicp-client-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/RobLe3/iicp-client-typescript/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Protocol](https://img.shields.io/badge/IICP-v1.9-indigo.svg)](https://github.com/RobLe3/IICP)
[![npm](https://img.shields.io/badge/npm-%40iicp%2Fclient-red?logo=npm)](https://www.npmjs.com/package/@iicp/client)

Use the open AI mesh from your TypeScript or JavaScript app. Install the
client, send an intent, and get a routed response from an IICP node.

You do **not** need to run a node to try the client path. Consume first,
provide later.

Works in **Node.js ≥ 18**, Deno, Bun, and modern browsers with the native Fetch API.

```
urn:iicp:intent:llm:chat:v1  →  discover  →  select  →  submit
```

IICP supplies intent resolution and provider eligibility/selection. MCP, A2A,
HTTP or another negotiated binding may then execute the selected task. See the
public [protocol positioning](https://github.com/RobLe3/IICP/blob/main/standards/IICP_PROTOCOL_POSITIONING.md)
and [adjacent-protocol comparison](https://github.com/RobLe3/IICP/blob/main/standards/PROTOCOL_COMPARISON_2026-08-15.md).

---

## Install

```bash
npm install @iicp/client@latest
# yarn add @iicp/client@latest
# pnpm add @iicp/client@latest
```

## One-line test

```bash
npm install -g @iicp/client@latest
iicp-node query "Hello, mesh."
```

What good looks like:

```bash
iicp-node --help       # shows query, serve, proxy, mcp-gateway, credits, ...
which iicp-node        # points to your Node/npm environment
iicp-node --version    # prints iicp-node 0.7.104 or newer
```

The query command contacts the public directory, discovers a matching live node,
routes your prompt, and prints the response. No account, API key, or local node
is required for this consumer path.

Privacy note: the selected remote node can read the prompt it executes. IICP-CX
keeps key-ready transport/relay paths confidential, but it is not
executor-blind inference. For sensitive data, use local/browser inference or a
fail-closed routing profile.

## MCP gateway safety

`iicp-node mcp-gateway --tools format_json,summarize_text` advertises only the
tools you name. Shell, file, network, browser, credential, system-control and
regulated-decision tools are denied by default. Enabling one requires all four
controls: `--allow-dangerous-tools`, `--authz-policy ID`, `--sandbox container`
and `--audit-redaction` (equivalent `IICP_MCP_*` environment variables exist).
Policy receipts include risk/decision metadata and argument counts, never tool
arguments, prompts, credentials or response content.

## Use from TypeScript

```typescript
import { IicpClient } from "@iicp/client";

const reply = await new IicpClient().chat([
  { role: "user", content: "Hello, mesh." },
]);

console.log(reply.choices[0].message.content);
```

## Do I need to run a node?

No. Running a node is only needed when you want to provide compute or tools to
the mesh. Start as a client; run a node later when you want to contribute.

## Routing policy profiles

The client applies routing policy **after prompt-free discovery and before the
prompt is sent**. Defaults stay adoption-friendly but keyless plaintext is still
refused.

```bash
iicp-node query "Hello" --routing-profile standard        # default encrypted mesh
iicp-node query "Secret" --routing-profile sensitive      # fail closed: no remote executor
iicp-node query "Hello" --routing-profile eu-restricted   # EU/EEA regions only
iicp-node query "Hello" --routing-profile strict-policy   # requires no-retention manifest
```

```typescript
const reply = await new IicpClient().chat(
  [{ role: "user", content: "Hello" }],
  { routing_policy: { profile: "eu_restricted" } },
);
```

For stricter deployments, require a minimum policy-manifest identity level
before any prompt leaves the client. This keeps the default open mesh behavior
unchanged, but lets controllers fail closed on self-attested or rotated/revoked
providers.

```typescript
const reply = await new IicpClient().chat(
  [{ role: "user", content: "Hello" }],
  { routing_policy: { required_manifest_identity_level: "operator_bound" } },
);
```

### Route constraints and consumer authentication

`chat(..., { model })` now constrains both provider discovery and provider
execution. Region, QoS, reputation, browser access, and profile requirements
are projected through one route-constraint path for ticketed discovery, legacy
discovery, and fallback. Route-only fields are not sent to the provider inside
the task envelope.

Set `consumer_auth_mode: "required"` in `ClientConfig` when a workload must
not silently fall back to anonymous dispatch if consumer-token acquisition
fails. The default remains `"optional"`; `"disabled"` skips token
acquisition.

### Experimental local candidate rankers

Library users may attach a `CandidateRanker` to test a learned or
application-specific ordering policy. The client invokes it only after normal
endpoint, availability, confidentiality and routing-policy checks. It receives
a redacted `CandidateEvidenceV0` array and may select one listed reference or
decline. Decline preserves the configured built-in strategy; a rejection or
unknown reference fails before provider dispatch.

```ts
const client = new IicpClient(config).withCandidateRanker(myRanker);
```

TypeScript, Python and Rust test the same experimental behavior fixture. This
is not a wire profile or default. The SDK never sends request content to an
external evaluator automatically.

## Migrate from existing AI tools

Direct call:

```typescript
// Before: call one vendor endpoint directly.
// After: ask IICP to discover and route by capability.
const reply = await new IicpClient().chat([
  { role: "user", content: "Summarize this document." },
]);
```

Existing OpenAI-compatible tools:

```bash
npm install -g @iicp/client@latest
iicp-node proxy
export OPENAI_BASE_URL=http://127.0.0.1:9483/v1
```

Then point LangChain, Cursor, liteLLM or another OpenAI-compatible tool at that
base URL. Full guide: <https://iicp.network/docs/proxy>

## Keep provider nodes current

The current public release line is **0.7.104**. Upgrade through your package
manager before troubleshooting an older installation. Routing profiles can
refuse remote dispatch before a prompt leaves the client; use `sensitive` for
local-only work, `eu-restricted` for EU/EEA routing, or `strict-policy` when a
no-retention policy manifest is required.

Provider nodes run an hourly official-registry check by default
(`IICP_AUTO_UPDATE=1`, `IICP_AUTO_UPDATE_INTERVAL_S=3600`; minimum 300s).
When npm publishes a newer stable release, `serve` runs
`npm install -g @iicp/client@latest` and re-execs the node so identity and cached
node tokens are preserved.

If an older supervised node does not update itself, perform one manual upgrade
and restart through its normal supervisor. For Docker, use a Compose
`restart: unless-stopped` policy (or `docker run --restart unless-stopped`) so
verified recovery can restart cleanly.

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

## Library quickstart

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

## Use as a local API proxy (OpenAI / Ollama / Anthropic compat)

Run a local gateway that speaks the OpenAI, Ollama, and Anthropic HTTP APIs and routes
every request across the IICP mesh — point any tool you already use at it, no code changes.

```bash
npm i -g @iicp/client
iicp-node proxy                       # → http://127.0.0.1:9483

export OPENAI_BASE_URL=http://127.0.0.1:9483/v1   # OpenAI SDK / LangChain / Cursor / liteLLM
export OLLAMA_HOST=http://127.0.0.1:9483          # Open WebUI / Continue.dev / aider / Jan
```

Loopback-only consumer (never registers with the directory), built on Node's `http` (no
extra runtime dependency). Override the port with `--port` / `IICP_PROXY_PORT`; co-host
next to a node with `iicp-node serve --with-proxy`. Every response carries
`Server: iicp-proxy`. Full guide: <https://iicp.network/docs/proxy>

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
| `routing_epsilon` | `0.05` | ε-greedy exploration probability — with this probability a random node is selected instead of the top-ranked one, promoting discovery of new providers; `0` disables; override with `IICP_ROUTING_EPSILON` |
| `routing_policy` | `{ profile: "standard" }` | Pre-dispatch remote-routing gate; use `sensitive`, `eu_restricted`, `strict_policy`, or an explicit debug override for special cases |

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
| `meshllm` | `meshllmHandler` | Stable chat over a local MeshLLM OpenAI `/v1` gateway | `http://localhost:9337/v1` |
| `vllm` | `vllmHandler` | OpenAI dialect, tuned for vLLM | `http://localhost:8000/v1` |
| `llamacpp` | `llamacppHandler` | OpenAI dialect, tuned for llama.cpp server | `http://localhost:8080/v1` |
| `anthropic` | `anthropicHandler` | Anthropic Messages API (`POST /v1/messages`) — first-class Claude | `https://api.anthropic.com/v1` |

### MeshLLM

MeshLLM is a local OpenAI-compatible backend. Start its local gateway, then choose
one advertised model explicitly (the stable IICP profile serves chat only):

```bash
iicp-node serve --backend-type meshllm --model <meshllm-model-id>
```

The upstream experimental `mesh` ensemble is never selected automatically. Use it
only with an explicit `--model mesh --experimental` opt-in.

### Experimental durable dispatch admission

`SqliteDispatchAdmissionStore` provides provider-local, single-use admission
for the pre-normative `dispatch-admission:v2` profile. It is never enabled by
`IicpNode` automatically: verify the dispatch ticket first and invoke
`evaluateDispatchAdmission` explicitly. The adapter stores only JTI and
content-free binding digests.

The SQLite adapter uses Node's built-in `node:sqlite` and therefore requires
Node 22.5 or newer when instantiated. Importing the SDK and all established
features remain supported on Node 18+. Storage failure rejects admission
instead of falling back to an in-memory replay cache.

MeshLLM remains the local inference runtime. IICP uses its local OpenAI-compatible
gateway for task execution and does not publish MeshLLM peer or topology details
through IICP discovery.

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
| **3** | CGNAT + no usable IPv6 | Opens a Quick Tunnel if available → otherwise auto-elects relay |
| **4** | Nothing worked | Serves locally with operator guidance |

### Environment-specific behaviour

**Docker bridge (`-p 8020:8020`)** — UPnP is skipped (it would reach Docker NAT, not your
home router). The official image includes `cloudflared`, so without a public endpoint it
tries a zero-account Quick Tunnel, then relay. The image also sets `IICP_SUPERVISED=1`,
so with Docker restart policy enabled a confirmed tunnel-dead state exits visibly and
lets Docker restart the node. For stable direct hosting, set `IICP_PUBLIC_ENDPOINT` in
`docker-compose.yml`:

```yaml
restart: unless-stopped
environment:
  IICP_PUBLIC_ENDPOINT: "http://your-host-ip:8020"
  IICP_BACKEND_URL: "http://host.docker.internal:11434"
```

Or run with `--network host` to let UPnP work as on bare metal.

**Kubernetes** — set `IICP_PUBLIC_ENDPOINT` to the LoadBalancer / NodePort IP.

**CGNAT + no IPv6 → Quick Tunnel, then relay:**

```
[iicp-node] NAT tier=3: opening Quick Tunnel...
[iicp-node] no tunnel available — auto-electing relay from directory...
[iicp-node] auto-elected relay: relay.example.com:9485
```

With `cloudflared` available, the node registers its own temporary HTTPS tunnel URL.
If that is unavailable, the node connects outbound to the elected relay and re-registers
automatically.
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

Relay workers request short-lived directory-signed bind tickets when they have a saved node
token. Relay operators can enforce them with `IICP_RELAY_REQUIRE_BIND_TICKET=1` and the
directory's Ed25519 verification key in `IICP_RELAY_BIND_TICKET_PUBLIC_KEY`. Keep strict mode
enabled on public relays; unsigned compatibility mode is intended only for staged migration.

### Opt-out / override

```bash
IICP_AUTO_DETECT_NAT=false              # disable detection entirely
IICP_PUBLIC_ENDPOINT=http://x.x.x.x:8020  # trust this endpoint
IICP_TUNNEL=0                           # opt out of Quick Tunnel fallback
IICP_TUNNEL_CREATE_MIN_INTERVAL_S=120   # host-wide Quick Tunnel create pacing
IICP_TUNNEL_CREATE_JITTER_MAX_S=15       # randomized suffix after shared deadlines
IICP_TUNNEL_WAIT_FOR_CAPACITY=1          # default: wait through local/provider cooldowns
IICP_TUNNEL_DEAD_POLICY=auto             # auto|retry|exit|log-only (unrecoverable dead-state policy)
IICP_SUPERVISED=1                        # set by generated services/Docker so supervisors can restart
IICP_AUTO_UPDATE=1                       # hourly provider self-update; set 0 to disable
IICP_AUTO_UPDATE_INTERVAL_S=3600         # update cadence in seconds; minimum 300
IICP_RELAY_WORKER_ENDPOINT=host:9485    # specific relay instead of auto-elect
```

When several nodes on one host wake or recover together, they share a local creation
lease and cooldown state. A node waits until the authoritative deadline, then adds a
small randomized delay before attempting its own Quick Tunnel. This prevents a restart
storm without advertising an unverified direct route. Set
`IICP_TUNNEL_WAIT_FOR_CAPACITY=0` only for diagnostics that need the raw cooldown error.

### Publish a signed node policy

Operators can describe public handling rules in a local JSON file and have the client sign it
with their existing operator identity before registration:

```bash
iicp-node serve --node my-node --policy-manifest ~/.iicp/node-policy.json
# or: IICP_POLICY_MANIFEST_FILE=~/.iicp/node-policy.json
```

The source file stays local. The registration contains the public policy document, its public
operator key, timestamps, and detached Ed25519 signature—never the operator secret. The same
signed document is reused during recovery re-registration, so policy does not disappear when
a tunnel rotates. A signed declaration is tamper-evident operator evidence, not a legal or
privacy certification.

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

### Operator data rights

You can request a portable, redacted record of the operator metadata held by a compatible directory without uploading your private identity key:

```bash
iicp-node operator dsr export --output ~/iicp-operator-export.json
```

The client obtains a short-lived challenge and signs it locally. The receipt excludes the private key, node tokens, prompt content, and contact details; it is saved owner-only on Unix. `restrict` and `anonymize` are explicit, confirmed requests and do not erase retention records that a directory must keep for security, fraud prevention, or legal obligations. See the [operator rights guide](https://iicp.network/operator/rights).

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

## Opt-in protocol research APIs

`verifyDispatchTicketV2` verifies pre-normative v2 tickets against a
caller-supplied trust bundle. `LifecycleStore` is a transport-neutral bounded
reference store with replay and restart snapshots. Neither is used by normal
discovery, submission or node serving. These are unstable research surfaces,
not deployed protocol guarantees.

---

## Development

```bash
npm install        # install deps
npm run typecheck  # tsc strict
npm test           # run the unit suite
npm run build      # emit to dist/
```

---

## Links

- [Protocol specification](https://github.com/RobLe3/IICP) — normative IICP documents
- [Agent bootstrap guide](https://github.com/RobLe3/IICP/blob/main/docs/agent-bootstrap.md) — connect a consumer or provider agent
- [Implementation registry](https://github.com/RobLe3/IICP/blob/main/IMPLEMENTATIONS.md) — supported and preview components
- [Node setup guide](https://iicp.network/docs/node-setup) — run your own node
- [Error reference](https://iicp.network/docs/error-reference) — all error codes
- [iicp-client-python](https://github.com/RobLe3/iicp-client-python) — Python SDK
- [iicp-client-rust](https://github.com/RobLe3/iicp-client-rust) — Rust SDK

---

Apache 2.0 · [iicp.network](https://iicp.network)

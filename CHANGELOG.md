# Changelog

All notable changes to the IICP TypeScript SDK (`@iicp/client`).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
within the scope of the IICP Software axis (see [`VERSIONING.md`](https://github.com/RobLe3/iicp.network/blob/main/project/VERSIONING.md)
in the main repo).

## [0.7.40] — 2026-06-07

### Fixed — CLI usability hardening (no friction for new operators)

- **`proxy` now listed in `iicp-node --help`** + previously-undocumented serve flags
  (`--with-proxy`, `--relay-worker-endpoint`, `--force`, `--log-dir`, `--no-auto-detect-nat`).
- **Every subcommand `--help`/`-h` prints usage** instead of crashing — `proxy --help`,
  `credits --help`, `query --help`, `operator rename --help` no longer dump stack traces.
- **Friendly parse errors** — unknown flags and bad `--port` values now print
  `ERROR: …` (exit 2) instead of raw Node stack traces.
- **`iicp-node serve --model X` works without `--backend-url`** — the `localhost:11434`
  (or `https://api.anthropic.com` for `--backend-type anthropic`) default is applied
  unconditionally, matching the Python/Rust clients.
- **`--no-auto-detect-nat`** off-switch added; `iicp-node help` prints usage;
  `iicp-node operator` (no subcommand) prints usage; `credits` with no `--node` auto-resolves
  a single/`default` node and otherwise lists the saved node names. Cross-flavour CLI parity (3-C).

## [0.7.39] — 2026-06-07

### Added — unified client: local OpenAI/Ollama/Anthropic-compat proxy (ADR-050, #476)

- **`iicp-node proxy`** — a local compat gateway on `127.0.0.1:9483` (built on `node:http`,
  no new runtime dependency). Speaks OpenAI (`/v1/chat/completions`, `/v1/models`), Ollama
  (`/api/chat`, `/api/generate`, `/api/tags`, `/api/version`), and Anthropic (`/v1/messages`)
  and routes each request across the IICP mesh. Every response carries `Server: iicp-proxy`.
  Point any existing tool's base URL at it — no code changes. See `/docs/proxy`.
- **`iicp-node serve --with-proxy`** — co-host the proxy (loopback) next to a provider node
  in one process, supervised + crash-isolated.
- **CIP consumer gating** in the proxy path — `IICP-E036` → 402 (insufficient credits),
  `IICP-E022` → 503 (no eligible workers); full parity with the Python reference (18/18
  conformance fixtures) + a real-process E2E test.
- One client now does **node + query + proxy**; the standalone `iicp-proxy` package is retired.

## [0.7.36–0.7.38] — 2026-06-03..06

- Maintenance + lockstep version alignment across the Python/TS/Rust SDKs (3-C); query
  `status='success'` acceptance fix; operator-identity README/help. No TS API changes.

## [0.7.35] — 2026-06-03

### Added — native Anthropic backend + audio chat modality (#414, capability roadmap)

- **`anthropicHandler` / `AnthropicOptions`** — a fourth `--backend-type`, `anthropic`,
  speaks the Anthropic **Messages API** (`POST /v1/messages`) directly instead of the
  OpenAI-compat shim. It hoists `system` messages to the top-level `system` field, sets
  the required `max_tokens` (default 4096), maps `image_url` content parts to Anthropic
  image blocks, sends the key as `x-api-key`, and maps the response back to the OpenAI
  chat-completion shape — so a Claude node is indistinguishable from an Ollama/vLLM node
  to any client. `--backend-type anthropic` defaults `--backend-url` to
  `https://api.anthropic.com`. No new dependency (built-in `fetch`).
- **`modalitiesForModel`** now detects **audio** chat models (name contains `audio`,
  `voxtral`, or `omni`) and advertises `input_modalities: ["audio"]` (or
  `["image","audio"]` for omni), alongside the existing vision detection. Parity with the
  Python SDK.

### Added — heartbeat liveness challenge (ADR-047 Part A, #411)

- The heartbeat loop answers the directory's liveness challenge so the directory can
  distinguish a live node from a stale registration.

## [0.7.34] — 2026-06-03

### Added — operator delegation at registration (ADR-045 Phase A, #407)

- The node signs an **ed25519 operator delegation** and attaches it on `register`, so the
  directory can verify the node is operated under a known operator key.

## [0.7.33] — 2026-06-03

### Added — multimodal capability advertising (ADR-046, #408)

- **`buildCapabilities` / `modalitiesForModel`** — a node now advertises
  `input_modalities` derived from the model name: every model serves `text`, and
  vision-capable models (name contains `vl`, `vision`, `llava`, or `omni`) additionally
  advertise `image`. One capability entry is emitted per `(intent, input_modalities)`
  group so clients can pick the right model from discover.

## [0.7.32] — 2026-06-03

### Added — multi-intent advertising (#409)

- A node advertises **every intent its backend serves** (chat + embedding), not just the
  configured default, by probing the backend's model list. Fixes the backend model probe
  for authenticated `/v1` OpenAI-compat backends.

## [0.7.31] — 2026-06-02

### Fixed — backend_url precedence regression-lock (#410)

- Regression-lock test confirming `--backend-url` / `IICP_BACKEND_URL` precedence (the TS
  CLI was already correct; the test prevents future drift).

## [0.7.30] — 2026-06-02

### Added — Bearer auth for OpenAI-compat backends (#5)

- **`--backend-api-key` / `IICP_BACKEND_API_KEY`** — a Bearer key for authenticated
  backends (LM Studio, hosted gateways). Empty/undefined sends no auth header. The
  `anthropic` backend (0.7.35) reuses this flag as its `x-api-key`.

## [0.7.29] — 2026-06-02

### Fixed — single-instance lock prevents duplicate-node thrash (#405)

- `serve` now holds a per-node_id pidfile (`~/.iicp/run/<node_id>.pid`) and **refuses
  a second live process for the same node_id** (`--force` / `IICP_FORCE` to take over).
  Two processes for one node_id otherwise fight — each registration rotates the token
  and invalidates the other's, causing a 401/re-register war that flaps the node.
  Distinct node_ids are unaffected (a fleet of N nodes runs fine). Fail-open. Parity
  with Python + Rust.

## [0.7.28] — 2026-06-02

### Fixed — node no longer needs a manual restart to reconnect (#404, reliability)

- **Registration retries with backoff** at startup (3 attempts) instead of giving up
  and running with no heartbeat. On persistent failure the heartbeat loop **still
  starts** (with an empty token) and re-registers on the first 401 (the #399 path) —
  a self-healing watchdog. Previously a transient startup failure, or the heartbeat
  loop stopping, left the node dormant in the directory until the operator killed and
  restarted the process. Parity with the Python + Rust SDKs.

## [0.7.27] — 2026-06-02

### Fixed — CIP policy now enforced on incoming tasks (#403, security)

- **`CooperativeInferencePolicy.allowToolExecution`** + **`permitsIntent(intent)`**, and the
  serve `/v1/task` handler now **rejects tool-execution-domain intents with 403**
  (`tool_execution_denied`) unless the operator opted in. Previously the node *declared* its
  CIP policy but never *enforced* it — a node with `allowToolExecution:false` would still run
  tool-execution tasks. The register policy block now also surfaces `allow_tool_execution`.
  Ported from the original adapter `cip_gate`; full parity with the Python + Rust SDKs.

## [0.7.26] — 2026-06-02

### Added — transport on parsed discover nodes (#397)

- `Node.transport?: string[]` — the directory now advertises which protocols each
  node speaks (`["https","iicp-native"]`), parsed from the discover response so
  clients can prefer the native binary path without a second round-trip to detail.
  Parity with the Python + Rust SDKs and the PHP + Rust directories.

## [0.7.25] — 2026-06-02

### Fixed — node recovers after the directory drops it (#399)

- **Heartbeat loop now re-registers on a node-unknown rejection.** Previously a
  `404`/`401`/`410` heartbeat (directory deregistered the node on a prior
  shutdown, TTL-expired it after a gap, or restarted and forgot it) was swallowed
  silently — the node kept heartbeating into the void and never reappeared in the
  directory until `serve` was restarted. The loop now detects the rejection,
  re-registers, and resumes with the fresh token. Parity with the Python + Rust SDKs.
- **`SDK_VERSION`** corrected `0.7.8` → `0.7.25` (was stale; the register payload
  had been reporting `0.7.8` regardless of the package version).

## [0.7.24] — 2026-06-02

### Changed — onboarding clarity

- **`iicp-node init` dependency check** now distinguishes opt-in capabilities
  from real problems. Optional packages that are not installed (`cbor-x` for
  native IICP-TCP transport, `nat-upnp`, `prom-client` for `/metrics`) render
  with a neutral `○` marker and an explicit "(optional — not installed)" note,
  plus a one-line "your node runs without them" reassurance, instead of the
  alarming `✗`. The auto-install prompt is reworded accordingly. No behavior
  change to the node itself — purely first-run output. Parity with the Rust
  and Python SDKs (same iteration).

## [0.5.3] — 2026-05-27

### Fixed — **upgrade required for binary IICP TCP transport**

- **Wire-compat: CBOR frame encoding (`src/iicp_tcp.ts`)** — earlier 0.5.x
  releases emitted non-standard CBOR on the native IICP TCP transport
  (port 9484). Python and Rust peers could connect but received
  text-string-keyed protocol headers (JS object literals stringify their
  numeric keys) and tagged map outputs (cbor-x's default `Encoder` enables
  `useRecords` and `mapsAsObjects`, which wrap output in tags 57343 / 57344 /
  259). Symptom: TS server in a mixed mesh returned `peer_node_id=null`
  and empty CALL results to Python/Rust clients; TS-only meshes worked
  because both endpoints spoke the same dialect.

  Fix: instantiate `new Encoder({ useRecords: false, mapsAsObjects: false })`
  and build every protocol-header frame as `Map<number, unknown>` instead
  of an object literal. Result: standard RFC 8949 CBOR with integer keys,
  fully interoperable with the Python (`cbor2`) and Rust (`ciborium`) SDKs.

  Verified by a 3×3 cross-SDK constellation matrix (Python / TypeScript /
  Rust as both client and server): 9/9 IICP TCP cells pass; 3/3 HTTP
  `/v1/task` cells pass; 127/127 unit tests pass.

- **Build: `src/conformance.ts`** — added explicit return-type casts on three
  `Response.json()` calls so `tsc --strict` compiles cleanly. No runtime
  behaviour change.

- **Build: `src/nat_detection.ts`** — `nat-upnp` is now loaded through a
  dynamic-import indirection so `tsc` can compile in repos where the
  optional peer dep has no `@types/`. Runtime behaviour unchanged.

### Migration

Users on 0.5.0 / 0.5.1 / 0.5.2 who use **only** the HTTP `/v1/task` transport
are unaffected and can stay on their current version. Users running native
IICP TCP servers (port 9484) **must** upgrade to 0.5.3 to talk to non-TS
peers — earlier versions are silently incompatible on the wire.

```bash
npm install @iicp/client@^0.5.3
```

No source-code changes are required; the fix is transparent to callers.

## [0.5.2] — 2026-05-27

- ConcurrencyGate parity port (Tier 2 Item 5). Counter-based non-blocking
  acquire; `concurrencyGate` option on `IicpTcpServerOptions`;
  `CapacityExceededError` translates to RESPONSE `error_code=429` (IICP-E021)
  matching the HTTP `/v1/task` path.

## [0.5.1] — 2026-05-27

- Four CONF self-conformance probes (Tier 2 Item 4): `CONF-REG-01`,
  `CONF-HEALTH-01`, `CONF-REACH-01`, `CONF-DISC-01`.

## [0.5.0] — 2026-05-27

- ADR-019 declarative pricing + HMAC signing (Tier 2 Item 3).

## Earlier 0.x releases

See git log — the Tier 1 ports (transport_endpoint, IICP TCP, UPnP NAT
detection, openai_compat backend, NAT observability) and Tier 2 items
(CIP policy, pricing, conformance, ConcurrencyGate) shipped across
iter-1409..1440 of the main repo's FORGE loop and were unit-tested
per-SDK but not yet cross-SDK validated until 0.5.3.

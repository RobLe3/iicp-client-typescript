# Changelog

All notable changes to the IICP TypeScript SDK (`@iicp/client`).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
within the scope of the IICP Software axis (see [`VERSIONING.md`](https://github.com/RobLe3/iicp.network/blob/main/project/VERSIONING.md)
in the main repo).

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

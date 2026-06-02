// ADR-016: IICP client SDK conformance
/**
 * #410 regression — backend_url precedence. The TS CLI was already correct
 * (the --backend-url flag defaults to "" so a saved-node config can supply it,
 * with localhost:11434 as the FINAL fallback). These tests lock that behavior
 * so it never regresses into the bug that affected the Rust/Python CLIs, where
 * a non-empty default silently shadowed the saved backend_url.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySavedNode, type ServeOpts } from "../src/cli.js";
import type { NodeIdentity } from "../src/identity.js";

function baseOpts(overrides: Partial<ServeOpts> = {}): ServeOpts {
  return {
    backendUrl: "",
    backendType: "openai_compat",
    backendApiKey: "",
    model: "",
    publicEndpoint: "",
    directoryUrl: "",
    region: "",
    intent: "",
    maxConcurrent: 4,
    nodeId: "",
    port: 9484,
    host: "0.0.0.0",
    skipRegistration: false,
    force: false,
    autoDetectNat: false,
    externalIpProbeUrl: "",
    relayWorkerEndpoint: "",
    node: "lmstudio",
    ...overrides,
  };
}

function savedNode(overrides: Partial<NodeIdentity> = {}): NodeIdentity {
  return {
    node_id: "n-1",
    operator_id: "op-1",
    name: "lmstudio",
    backend_url: "http://localhost:1234/v1",
    model: "qwen2.5-coder-14b-instruct-mlx",
    intent: "urn:iicp:intent:llm:chat:v1",
    region: "eu-central",
    directory_url: "https://iicp.network/api",
    max_concurrent: 4,
    port: 9487,
    host: "0.0.0.0",
    public_endpoint: "",
    auto_detect_nat: true,
    external_ip_probe_url: "",
    created_at: "2026-06-02T00:00:00Z",
    ...overrides,
  };
}

describe("#410 backend_url precedence (applySavedNode)", () => {
  it("saved backend_url/model apply when no flag/env supplied them", () => {
    const out = applySavedNode(baseOpts({ backendUrl: "" }), savedNode());
    assert.equal(out.backendUrl, "http://localhost:1234/v1");
    assert.equal(out.model, "qwen2.5-coder-14b-instruct-mlx");
  });

  it("explicit flag/env backend_url wins over saved", () => {
    const out = applySavedNode(baseOpts({ backendUrl: "http://flag:9999/v1" }), savedNode());
    assert.equal(out.backendUrl, "http://flag:9999/v1");
  });

  it("localhost:11434 is the final fallback when neither flag nor saved set it", () => {
    const out = applySavedNode(baseOpts({ backendUrl: "" }), savedNode({ backend_url: "" }));
    assert.equal(out.backendUrl, "http://localhost:11434");
  });
});

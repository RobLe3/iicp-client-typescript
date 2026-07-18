import assert from "node:assert/strict";
import test from "node:test";

import { applySavedNode, resolveReceiptProfiles, type ServeOpts } from "../src/cli.js";
import type { NodeIdentity } from "../src/identity.js";

test("receipt profiles deduplicate and reject unsupported values", () => {
  assert.deepEqual(
    resolveReceiptProfiles(["consumer_cosignature_v1", "consumer_cosignature_v1"], undefined),
    ["consumer_cosignature_v1"],
  );
  assert.throws(() => resolveReceiptProfiles(["unknown_v1"], undefined), /unsupported receipt profile/);
});

test("CLI and environment precedence is explicit", () => {
  assert.deepEqual(resolveReceiptProfiles([], "consumer_cosignature_v1", ["saved"]), []);
  assert.deepEqual(resolveReceiptProfiles(undefined, "consumer_cosignature_v1", ["saved"]), [
    "consumer_cosignature_v1",
  ]);
});

test("saved-node receipt profile is restored when no override exists", () => {
  const opts = {
    backendUrl: "", backendType: "openai_compat", backendApiKey: "", model: "", publicEndpoint: "",
    directoryUrl: "", intent: "urn:iicp:intent:llm:chat:v1", maxConcurrent: 4, nodeId: "", port: 9484,
    host: "::", skipRegistration: false, force: false, autoDetectNat: false, externalIpProbeUrl: "",
    relayWorkerEndpoint: "", node: "saved",
  } as ServeOpts;
  const saved = {
    node_id: "n", operator_id: "o", name: "saved", backend_url: "http://localhost", model: "m",
    intent: "urn:iicp:intent:llm:chat:v1", region: "unknown", directory_url: "https://example/api",
    max_concurrent: 4, port: 9484, host: "::", public_endpoint: "", auto_detect_nat: false,
    external_ip_probe_url: "", supported_receipt_profiles: ["consumer_cosignature_v1"], created_at: "now",
  } satisfies NodeIdentity;
  assert.deepEqual(applySavedNode(opts, saved).receiptProfiles, ["consumer_cosignature_v1"]);
});

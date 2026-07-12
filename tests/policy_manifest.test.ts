import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { operatorSigningKey, type OperatorIdentity } from "../src/identity.js";
import { canonicalPolicyManifest, loadAndSignPolicyManifest } from "../src/policy_manifest.js";

test("policy manifest is signed by the operator without leaking its secret", () => {
  const op: OperatorIdentity = {
    operator_id: "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=",
    operator_secret: Buffer.alloc(32, 7).toString("base64"),
    created_at: "2026-01-01T00:00:00Z",
    display_name: "KAT",
    contact: "",
  };
  const path = join(mkdtempSync(join(tmpdir(), "iicp-policy-")), "policy.json");
  writeFileSync(path, JSON.stringify({ version: "1", jurisdiction: "DE", retention: { task_payload: "none" } }));
  const manifest = loadAndSignPolicyManifest(path, op, new Date("2026-07-10T00:00:00Z"));
  const sig = manifest.signature as Record<string, string>;
  assert.equal(verify(null, canonicalPolicyManifest(manifest), createPublicKey(operatorSigningKey(op)), Buffer.from(sig.signature, "base64")), true);
  assert.equal(sig.public_key, op.operator_id);
  assert.equal(sig.signature, "Horps0SnJ4lenW97Z/vAEEihQ4/ICfBFo//uF4r808FuZzopAXzz2V3vgFXarl1FdPMXwndIo/7qP2/aXMZrAw==");
  assert.equal(JSON.stringify(manifest).includes(String(op.operator_secret)), false);
  assert.throws(
    () => loadAndSignPolicyManifest(path, { ...op, operator_id: Buffer.alloc(32).toString("base64") }, new Date("2026-07-10T00:00:00Z")),
    /does not match/,
  );
});

test("pre-normative profile fixture has portable reasons", () => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "parity/profile-compatibility-v0.json"), "utf8"));
  assert.equal(fixture.fixture_version, "0.2.0-draft");
  assert.equal(fixture.status, "pre-normative");
  assert.equal(fixture.result_contract.unsupported_status, "unsupported_pre_normative_profile");
  assert.equal(fixture.scenarios.length, 9);
  assert.equal(fixture.scenarios.every((scenario: { expected_reason?: string }) => Boolean(scenario.expected_reason)), true);
});

test("profile fixture native policy scenarios use the routing gate", async () => {
  const { filterNodesForRoutingPolicy } = await import("../src/routing_policy.js");
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "parity/profile-compatibility-v0.json"), "utf8"));
  for (const scenario of fixture.native_policy_scenarios) {
    const raw = scenario.node;
    const node = {
      node_id: `fixture-${scenario.name}`, endpoint: "https://node.example.test", score: 0.5,
      available: true, region: raw.region,
      cx_public_key: raw.cx_public_key ? { algorithm: "X25519", key: "fixture", key_id: "fixture" } : undefined,
      node_policy_manifest: raw.node_policy_manifest,
    };
    const decision = filterNodesForRoutingPolicy([node], scenario.policy);
    assert.equal(decision.eligible.length, 0);
    assert.deepEqual(decision.rejectedReasons, [scenario.expected_reason]);
  }
});

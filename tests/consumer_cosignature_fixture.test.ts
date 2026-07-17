import assert from "node:assert/strict";
import { createHash, createPublicKey, verify, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { canonicalizeJcs } from "../src/jcs.js";

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "parity/cip-consumer-cosignature-v1.json"), "utf8"),
);
const domain = Buffer.from("IICP-CIP-CONSUMER-COSIGNATURE-V1\0", "utf8");

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function evaluate(value: Record<string, string>): Record<string, string> {
  if (value.binding !== "match") {
    const reasons: Record<string, string> = {
      response_hash_mismatch: "response_hash_mismatch",
      cost_mismatch: "cost_mismatch",
      task_node_intent_mismatch: "receipt_binding_mismatch",
    };
    return { action: "refuse_signing", reason: reasons[value.binding], trust_weight: "0.0" };
  }
  if (value.consumer_key === "revoked") return { action: "reject", reason: "consumer_key_revoked", trust_weight: "0.0" };
  if (value.consumer_key === "rotated_outside_validity") return { action: "reject", reason: "consumer_key_not_valid_at_completion", trust_weight: "0.0" };
  if (value.time !== "valid") return { action: "reject", reason: "receipt_expired", trust_weight: "0.0" };
  if (value.nonce !== "fresh") return { action: "reject", reason: "dispatch_nonce_replayed", trust_weight: "0.0" };
  if (value.provider_signature !== "valid") return { action: "reject", reason: "provider_signature_invalid", trust_weight: "0.0" };
  if (value.consumer_signature !== "valid") {
    if (value.consumer_signature === "missing" && value.mode === "optional") {
      return { action: "accept_legacy", reason: "consumer_signature_missing_optional", trust_weight: "0.0" };
    }
    const reason = value.consumer_signature === "missing" ? "consumer_signature_required" : "consumer_signature_invalid";
    return { action: "reject", reason, trust_weight: "0.0" };
  }
  if (value.relationship === "same_node") return { action: "exclude", reason: "self_node", trust_weight: "0.0" };
  if (value.relationship === "same_operator") return { action: "exclude", reason: "self_operator", trust_weight: "0.0" };
  return { action: "accept", reason: "cosignature_verified", trust_weight: "1.0" };
}

test("consumer co-signature fixture is byte-identical in Node and browser crypto", async () => {
  const vector = fixture.canonical_vector;
  const encoded = Buffer.from(canonicalizeJcs(vector.receipt), "utf8");
  assert.equal(encoded.toString(), vector.canonical_json_utf8);
  assert.equal(createHash("sha256").update(encoded).digest("hex"), vector.canonical_json_sha256);
  const digest = createHash("sha256").update(domain).update(encoded).digest();
  assert.equal(digest.toString("hex"), vector.receipt_digest_hex);

  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  for (const role of ["provider", "consumer"] as const) {
    const rawKey = decode(vector[`${role}_public_key_b64url`]);
    const signature = decode(vector[`${role}_signature_b64url`]);
    const key = createPublicKey({ key: Buffer.concat([spkiPrefix, rawKey]), format: "der", type: "spki" });
    assert.equal(verify(null, digest, key, signature), true, `${role} Node verification`);

    const browserKey = await webcrypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
    assert.equal(
      await webcrypto.subtle.verify({ name: "Ed25519" }, browserKey, signature, digest),
      true,
      `${role} WebCrypto verification`,
    );
  }

  for (const item of fixture.conformance_cases) {
    assert.deepEqual(evaluate(item.input), item.expected, item.name);
  }
  for (const item of fixture.settlement_cases) {
    const input = item.input;
    const actual = input.reservation !== "held"
      ? { action: "refuse_dispatch", awards: 0, debits: 0 }
      : ["timeout", "cancelled", "partial"].includes(input.outcome)
        ? { action: "release", awards: 0, debits: 0 }
        : { action: "settle_once", awards: 1, debits: 1 };
    assert.deepEqual(actual, item.expected, item.name);
  }
  const receiptFields = new Set(Object.keys(vector.receipt));
  for (const field of fixture.privacy_contract.forbidden_fields) assert.equal(receiptFields.has(field), false);
  assert.equal(fixture.privacy_contract.self_reported_metrics_have_authority, false);
});

test("full JCS vectors and invalid number domain", () => {
  for (const vector of fixture.jcs_vectors) {
    assert.equal(canonicalizeJcs(vector.input), vector.canonical_json_utf8, vector.name);
  }
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 9_007_199_254_740_992]) {
    assert.throws(() => canonicalizeJcs({ invalid }), /JCS/);
  }
  assert.throws(() => canonicalizeJcs({ invalid: undefined }), /unsupported JCS/);
});

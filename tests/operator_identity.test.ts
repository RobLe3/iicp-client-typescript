// SPDX-License-Identifier: Apache-2.0
/**
 * #464 — OperatorIdentity is the ed25519 operator key: operator_id is the verifiable public
 * key (== the directory's operator_pubkey via the ADR-045 delegation), not a random UUID.
 * Fails without the fix (old operator_id was `op-<uuid>` with no key).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateOperator,
  operatorSigningKey,
  operatorIsKeyBacked,
  operatorPublicView,
  computeOperatorIntegrityHash,
  type OperatorIdentity,
} from "../src/identity.js";
import { operatorPubB64, issueDelegation, verifyDelegation } from "../src/delegation.js";

describe("#464 operator identity = ed25519 key", () => {
  it("operator_id is the base64 ed25519 pubkey (not a UUID)", () => {
    const op = generateOperator({ display_name: "Rebel One", contact: "me@example.com" });
    assert.ok(!op.operator_id.startsWith("op-"));
    assert.equal(Buffer.from(op.operator_id, "base64").length, 32);
    assert.equal(Buffer.from(op.operator_secret!, "base64").length, 32);
    assert.ok(operatorIsKeyBacked(op));
  });

  it("signing key's public matches operator_id", () => {
    const op = generateOperator();
    assert.equal(operatorPubB64(operatorSigningKey(op)), op.operator_id);
  });

  it("delegation uses the identity key and verifies", () => {
    const op = generateOperator();
    const token = issueDelegation(operatorSigningKey(op), "node-123");
    assert.equal(token.operator_pub, op.operator_id);
    assert.equal(verifyDelegation(token, "node-123"), true);
    assert.equal(verifyDelegation(token, "other-node"), false);
  });

  it("integrity hash binds operator_id + created_at", () => {
    const op = generateOperator();
    assert.equal(
      op.operator_integrity_hash,
      computeOperatorIntegrityHash(op.operator_id, op.created_at),
    );
    assert.notEqual(
      computeOperatorIntegrityHash(op.operator_id, "1999-01-01T00:00:00Z"),
      op.operator_integrity_hash,
    );
  });

  it("public view never leaks secret or contact", () => {
    const op = generateOperator({ display_name: "Pub", contact: "secret@example.com" });
    const pub = operatorPublicView(op);
    assert.ok(!("operator_secret" in pub));
    assert.ok(!("contact" in pub));
    assert.equal(pub.operator_id, op.operator_id);
  });

  it("legacy uuid identity is not key-backed and refuses to sign", () => {
    const legacy: OperatorIdentity = {
      operator_id: "op-deadbeef",
      created_at: "2026-01-01T00:00:00Z",
      display_name: "",
      contact: "",
    };
    assert.ok(!operatorIsKeyBacked(legacy));
    assert.throws(() => operatorSigningKey(legacy));
  });
});

// ── #503 — anonymous-registration notice ─────────────────────────────────────
// A node serving without a key-backed operator identity accrues NO founder or
// recognition standing; the SDK must say so loudly instead of staying silent.
// Each test fails if the notice helper is removed or stops covering its case.
describe("#503 anonymous-registration notice", () => {
  it("fires when no operator identity exists", async () => {
    const { noIdentityNotice, NO_IDENTITY_NOTICE } = await import("../src/identity.js");
    const notice = noIdentityNotice(null);
    assert.equal(notice, NO_IDENTITY_NOTICE);
    assert.ok(notice!.includes("iicp-node init"));
    assert.ok(notice!.toLowerCase().includes("founder"));
  });

  it("fires for a legacy keyless identity", async () => {
    const { noIdentityNotice } = await import("../src/identity.js");
    const legacy = {
      operator_id: "op-12345678-1234-1234-1234-123456789abc",
      created_at: "2026-01-01T00:00:00Z",
      display_name: "Legacy",
      contact: "",
    } as OperatorIdentity;
    assert.ok(!operatorIsKeyBacked(legacy));
    assert.ok(noIdentityNotice(legacy) !== null);
  });

  it("is silent for a key-backed identity", async () => {
    const { noIdentityNotice } = await import("../src/identity.js");
    const op = generateOperator({ display_name: "Keyed", contact: "" });
    assert.equal(noIdentityNotice(op), null);
  });
});

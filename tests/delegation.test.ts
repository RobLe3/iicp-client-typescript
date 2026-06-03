// SPDX-License-Identifier: Apache-2.0
// ADR-045 Phase A — operator→node delegation signing (#407).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalBytes,
  generateOperatorKey,
  issueDelegation,
  operatorPubB64,
  verifyDelegation,
} from "../src/delegation.js";

// Cross-language known-answer test — MUST equal the PHP
// OperatorDelegationVerifier::canonicalBytes (and the Python signer) for the
// same inputs, or directory verification of TS-signed delegations silently fails.
const KAT = '{"node_id":"node-kat-1","not_after":1893456000,"operator_pub":"T3BQdWJLZXlCYXNlNjQ="}';

describe("#407 ADR-045 delegation (TS)", () => {
  it("canonical bytes match the cross-language KAT", () => {
    assert.equal(canonicalBytes("node-kat-1", "T3BQdWJLZXlCYXNlNjQ=", 1893456000).toString("utf8"), KAT);
  });

  it("issue → verify round-trip", () => {
    const op = generateOperatorKey();
    const tok = issueDelegation(op, "node-1", 3600);
    assert.equal(tok.node_id, "node-1");
    assert.equal(tok.operator_pub, operatorPubB64(op));
    assert.equal(Buffer.from(tok.operator_pub, "base64").length, 32);
    assert.ok(verifyDelegation(tok, "node-1"));
  });

  it("rejects node_id mismatch", () => {
    const tok = issueDelegation(generateOperatorKey(), "node-1");
    assert.ok(!verifyDelegation(tok, "node-evil"));
  });

  it("rejects expired", () => {
    const tok = issueDelegation(generateOperatorKey(), "node-1", -1);
    assert.ok(!verifyDelegation(tok, "node-1"));
  });

  it("rejects tampered token", () => {
    const tok = issueDelegation(generateOperatorKey(), "node-1");
    tok.not_after += 1; // signature no longer covers the bytes
    assert.ok(!verifyDelegation(tok, "node-1"));
  });
});

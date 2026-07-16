import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POLICY_DETAIL_FIELDS, evaluatePolicyDetailDisclosure, verifyPolicyDetailConsumerToken } from "../src/policy_detail_disclosure.js";

const fixture = JSON.parse(fs.readFileSync(path.resolve("parity/policy-detail-disclosure-v0.json"), "utf8"));

describe("policy detail disclosure fixture", () => {
  it("applies portable authorization and redaction", () => {
    assert.deepEqual(fixture.allowed_detail_fields, POLICY_DETAIL_FIELDS);
    for (const testCase of fixture.cases) {
      const decision = evaluatePolicyDetailDisclosure(testCase.context);
      assert.equal(decision.status, testCase.expected.status, testCase.id);
      assert.equal(decision.reason, testCase.expected.reason, testCase.id);
      if (decision.status === 200) {
        assert.deepEqual(Object.keys(decision.body?.details as object), POLICY_DETAIL_FIELDS);
        const encoded = JSON.stringify(decision.body);
        for (const forbidden of ["must-not-leak", "private.example", "backend_topology", "natural_person_contact"])
          assert.ok(!encoded.includes(forbidden));
      }
    }
  });

  it("does not trust self-asserted authentication", () => {
    assert.deepEqual(evaluatePolicyDetailDisclosure({ consumer_auth: "self_asserted", disclosure_allowed: true }),
      { status: 401, reason: "consumer_auth_invalid" });
  });

  it("verifies portable consumer-token crypto vectors", () => {
    const vector = fixture.crypto_vectors;
    const verify = (token: string) => verifyPolicyDetailConsumerToken(
      token, vector.public_key_hex, vector.expected_target_node_id, vector.expected_intent, vector.evaluated_at_unix,
    );
    assert.equal(verify(vector.valid_consumer_token).status, "valid");
    assert.equal(verify(vector.valid_consumer_token).claims?.sub, vector.expected_subject);
    assert.equal(verify(vector.expired_consumer_token).status, "expired");
    assert.equal(verify(vector.tampered_consumer_token).status, "invalid");
  });
});

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePolicyOperationalEvidence } from "../src/policy_operational_evidence.js";

const fixture = JSON.parse(fs.readFileSync(path.resolve("parity/policy-operational-evidence-v0.json"), "utf8"));

describe("policy operational evidence fixture", () => {
  for (const item of fixture.cases) {
    it(item.id, () => {
      const decision = evaluatePolicyOperationalEvidence(item.requirement, item.context, fixture.evaluated_at);
      assert.equal(decision.reason, item.expected);
      assert.equal(decision.eligible, item.expected === "compatible");
    });
  }
});

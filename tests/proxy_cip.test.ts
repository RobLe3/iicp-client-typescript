// SPDX-License-Identifier: Apache-2.0
// CIP consumer dispatch gates (S.12 §2.2) — parity unit tests for the TS port of
// iicp_client.proxy.cip (gates.py + dispatch.py). #482(b) full parity.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CIPInsufficientCredits,
  CIPNoEligibleWorkers,
  type CipConfig,
  computeCipEnvelope,
  decideDispatch,
  validateCipRequestFields,
} from "../src/proxy/cip.js";

function cfg(over: Partial<CipConfig> = {}): CipConfig {
  return {
    enabled: true,
    strategy: "remote-first",
    maxCreditsPerTask: 10,
    sessionCreditBudget: null,
    sendSensitivePrompts: false,
    trustedPeers: [],
    minReputation: 0,
    ...over,
  };
}

describe("decideDispatch gates", () => {
  it("not enabled → local", () => {
    assert.equal(decideDispatch({ estimatedCredits: 1, eligibleWorkers: ["a"], config: cfg({ enabled: false }) }).result, "local");
  });
  it("over per-task credit ceiling → local", () => {
    assert.equal(decideDispatch({ estimatedCredits: 99, eligibleWorkers: ["a"], config: cfg() }).result, "local");
  });
  it("unaffordable (balance < cost), remote-first → error IICP-E036", () => {
    const d = decideDispatch({ estimatedCredits: 1, eligibleWorkers: ["a"], config: cfg(), consumerBalance: 0 });
    assert.equal(d.result, "error");
    assert.equal(d.errorCode, "IICP-E036");
  });
  it("unaffordable, local-first → local (graceful fallback)", () => {
    const d = decideDispatch({ estimatedCredits: 1, eligibleWorkers: ["a"], config: cfg({ strategy: "local-first" }), consumerBalance: 0 });
    assert.equal(d.result, "local");
  });
  it("sensitivity high not opted-in → local", () => {
    assert.equal(decideDispatch({ estimatedCredits: 1, sensitivity: "high", eligibleWorkers: ["a"], config: cfg() }).result, "local");
  });
  it("no eligible workers, remote-first → error IICP-E022", () => {
    const d = decideDispatch({ estimatedCredits: 1, eligibleWorkers: [], config: cfg() });
    assert.equal(d.result, "error");
    assert.equal(d.errorCode, "IICP-E022");
  });
  it("no eligible workers, local-first → local", () => {
    assert.equal(decideDispatch({ estimatedCredits: 1, eligibleWorkers: [], config: cfg({ strategy: "local-first" }) }).result, "local");
  });
  it("all gates pass → remote with a session key", () => {
    const d = decideDispatch({ estimatedCredits: 1, eligibleWorkers: ["a", "b"], config: cfg(), consumerBalance: 100 });
    assert.equal(d.result, "remote");
    assert.ok(d.cipSessionKey);
  });
});

describe("computeCipEnvelope", () => {
  const nodes = [{ node_id: "n1", allow_remote_inference: true, reputation_score: 0.9 }];
  it("disabled → null", () => {
    assert.equal(computeCipEnvelope(nodes, {}, cfg({ enabled: false }), "t1"), null);
  });
  it("remote-first + unaffordable → throws CIPInsufficientCredits", () => {
    assert.throws(() => computeCipEnvelope(nodes, {}, cfg(), "t1", null, 0), CIPInsufficientCredits);
  });
  it("remote-first + no eligible nodes → throws CIPNoEligibleWorkers", () => {
    const ineligible = [{ node_id: "n1", allow_remote_inference: false }];
    assert.throws(() => computeCipEnvelope(ineligible, {}, cfg(), "t1", null, 100), CIPNoEligibleWorkers);
  });
  it("remote decision → envelope with worker role + session key", () => {
    const env = computeCipEnvelope(nodes, {}, cfg(), "parent-1", null, 100);
    assert.equal(env?.cip_role, "worker");
    assert.equal(env?.cip_parent_task_id, "parent-1");
    assert.ok(env?.cip_session_key);
  });
  it("trusted_peers filter excludes untrusted nodes → E022", () => {
    assert.throws(() => computeCipEnvelope(nodes, {}, cfg({ trustedPeers: ["other"] }), "t1", null, 100), CIPNoEligibleWorkers);
  });
});

describe("validateCipRequestFields", () => {
  it("no cip block → null", () => assert.equal(validateCipRequestFields({}), null));
  it("invalid policy → IICP-E028", () => assert.equal(validateCipRequestFields({ cip: { policy: "nope" } }), "IICP-E028"));
  it("majority_vote with even replicas → IICP-E025", () => assert.equal(validateCipRequestFields({ cip: { policy: "majority_vote", replicas: 2 } }), "IICP-E025"));
  it("replicas out of range → IICP-E028", () => assert.equal(validateCipRequestFields({ cip: { replicas: 99 } }), "IICP-E028"));
  it("valid → null", () => assert.equal(validateCipRequestFields({ cip: { policy: "best_of_n", replicas: 3 } }), null));
});

// ADR-016: IICP client SDK conformance
/** Unit tests for the policy trio: token_validator, idempotency, trust_auditor
 * (parity Block E). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenValidator } from "../src/token_validator.js";
import { IdempotencyGuard } from "../src/idempotency.js";
import { modelsDiverge } from "../src/trust_auditor.js";

describe("TokenValidator", () => {
  it("empty expected rejects all", () => {
    assert.equal(new TokenValidator("").isValid("anything"), false);
  });
  it("matching token accepted", () => {
    assert.equal(new TokenValidator("secret-123").isValid("secret-123"), true);
  });
  it("mismatched token rejected", () => {
    assert.equal(new TokenValidator("secret-123").isValid("secret-456"), false);
  });
  it("null presented rejected", () => {
    assert.equal(new TokenValidator("secret-123").isValid(null), false);
  });
  it("update token after registration", () => {
    const v = new TokenValidator("old");
    v.updateToken("new");
    assert.equal(v.isValid("new"), true);
    assert.equal(v.isValid("old"), false);
  });
});

describe("IdempotencyGuard", () => {
  it("first seen is new, duplicate rejected", () => {
    const g = new IdempotencyGuard();
    assert.equal(g.checkAndRegister("task-1"), true);
    assert.equal(g.checkAndRegister("task-1"), false);
  });
  it("distinct ids both new", () => {
    const g = new IdempotencyGuard();
    assert.equal(g.checkAndRegister("a"), true);
    assert.equal(g.checkAndRegister("b"), true);
  });
  it("empty task_id always new", () => {
    const g = new IdempotencyGuard();
    assert.equal(g.checkAndRegister(""), true);
    assert.equal(g.checkAndRegister(undefined), true);
  });
  it("ttl expiry allows reuse", async () => {
    const g = new IdempotencyGuard(40);
    assert.equal(g.checkAndRegister("t"), true);
    assert.equal(g.checkAndRegister("t"), false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(g.checkAndRegister("t"), true);
  });
});

describe("trust_auditor.modelsDiverge", () => {
  it("no divergence when health is a superset", () => {
    assert.deepEqual(modelsDiverge(["a", "b"], ["a", "b", "c"]), []);
  });
  it("missing model is divergence", () => {
    assert.deepEqual(modelsDiverge(["a", "b"], ["a"]), ["b"]);
  });
  it("empty registered never diverges", () => {
    assert.deepEqual(modelsDiverge([], ["a"]), []);
  });
});

import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("quality runner emits the shared content-free evidence contract", () => {
  const runner = readFileSync("scripts/run-sdk-quality.mjs", "utf8");
  for (const value of ["iicp.sdk-quality-evidence.v1", 'sdk: "typescript"', "minimum_percent", "git\", \"status"]) {
    assert.ok(runner.includes(value));
  }
  for (const forbidden of ["credentials", "test_output", "node_ids", "endpoints"]) {
    assert.ok(!runner.includes(forbidden));
  }
});

test("quality documentation identifies local matrix and coverage ratchet", () => {
  const quality = readFileSync("QUALITY.md", "utf8");
  assert.match(quality, /Node 18, 20, 22 and 24/);
  assert.match(quality, /75 percent/);
  assert.match(quality, /free GitHub account/);
});

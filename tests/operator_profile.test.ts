import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateManagedOperator, type ManagedOperatorInput } from "../src/operator_profile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "managed-operator-v1.json");

test("managed operator decisions match the shared vectors", () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    vectors: Array<{ name: string; input: ManagedOperatorInput; expected: unknown }>;
  };
  for (const vector of fixture.vectors) {
    assert.deepEqual(evaluateManagedOperator(vector.input), vector.expected, vector.name);
  }
});

test("vendored fixture matches adjacent authority when available", () => {
  const authority = path.resolve(here, "../../IICP/research/pre-normative-profiles/fixtures/managed-operator-v1.json");
  if (fs.existsSync(authority)) {
    assert.deepEqual(JSON.parse(fs.readFileSync(fixturePath, "utf8")), JSON.parse(fs.readFileSync(authority, "utf8")));
  }
});

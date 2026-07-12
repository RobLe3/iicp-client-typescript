import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { weightedV1Order } from "../src/selection.js";

test("weighted_v1 fixture vectors are deterministic", () => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "parity/selection-v1.json"), "utf8"));
  for (const vector of fixture.vectors) {
    const order = weightedV1Order(vector.nodes, 3, vector.random).map((node) => node.node_id);
    assert.deepEqual(order, vector.expected_order, vector.name);
  }
});

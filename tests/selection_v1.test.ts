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

test("weighted_v1 distribution and top-k boundary are portable", () => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "parity/selection-v1.json"), "utf8"));
  for (const vector of fixture.distribution_vectors) {
    const counts = Object.fromEntries(vector.nodes.map((node: { node_id: string }) => [node.node_id, 0]));
    for (let index = 0; index < vector.sample_count; index++) {
      const randomValue = (index + 0.5) / vector.sample_count;
      const selected = weightedV1Order(vector.nodes, vector.nodes.length, randomValue, vector.top_k)[0];
      counts[selected.node_id] += 1;
    }
    assert.deepEqual(counts, vector.expected_first_counts, vector.name);
  }
});

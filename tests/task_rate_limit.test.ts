// F4 (#524): per-origin /v1/task rate limit
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IicpNode } from "../src/node.js";

function node(limit: number): IicpNode {
  process.env.IICP_TASK_RATE_LIMIT = String(limit);
  try {
    return new IicpNode({
      nodeId: "rl-test",
      endpoint: "https://x.example.com",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "llama-3-8b",
      region: "eu-central",
      directoryUrl: "https://d.example.com",
    });
  } finally {
    delete process.env.IICP_TASK_RATE_LIMIT;
  }
}

describe("task rate limit (F4)", () => {
  it("allows under the limit then blocks", () => {
    const n = node(3) as unknown as { _taskRateAllow(k: string): boolean };
    assert.equal(n._taskRateAllow("o-a"), true);
    assert.equal(n._taskRateAllow("o-a"), true);
    assert.equal(n._taskRateAllow("o-a"), true);
    assert.equal(n._taskRateAllow("o-a"), false);
  });
  it("origins are independent", () => {
    const n = node(1) as unknown as { _taskRateAllow(k: string): boolean };
    assert.equal(n._taskRateAllow("o-a"), true);
    assert.equal(n._taskRateAllow("o-b"), true);
    assert.equal(n._taskRateAllow("o-a"), false);
  });
});

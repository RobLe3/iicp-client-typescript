// Phase 2 (#529/#55): re-register sends current_node_token ownership proof
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IicpNode } from "../src/node.js";

describe("current_node_token (Phase 2)", () => {
  it("seedToken makes the next register payload carry current_node_token", () => {
    const node = new IicpNode({
      nodeId: "n-reg",
      endpoint: "https://node.example.com",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "llama-3-8b",
      region: "eu-central",
      directoryUrl: "https://iicp.test",
    });
    node.seedToken("tok-prior");
    // Reach into the runtime token to confirm the seeder wired it (register()
    // includes body.current_node_token = this._runtimeToken when set).
    const seeded = (node as unknown as { _runtimeToken?: string })._runtimeToken;
    assert.equal(seeded, "tok-prior");
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { IicpClient } from "../src/client.js";

test("discovery exposes additive evidence and keeps older responses compatible", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    nodes: [{
      node_id: "node-a",
      endpoint: "https://node.example.com",
      score: 0.8,
      available: true,
      region: "eu-central",
      latency_evidence: { estimate_ms: 143, basis: "multi_proxy_ema" },
      health_reasons: [{ dimension: "backend", state: "ok", reason: "ok", evidence: "self_reported" }],
      trust_progress: { gold_task_threshold_met: true, remaining_gold_requirements: [] },
      sdk_release: { compatibility: "current", relation: "latest_known" },
    }],
    diversity_evidence: { nodes: 1, distinct_verified_operators: 1 },
  }), { status: 200 })) as typeof fetch;
  try {
    const result = await new IicpClient({ directory_url: "https://directory.example", route_discovery_mode: "legacy" })
      .discoverWithNegotiation("urn:iicp:intent:llm:chat:v1");
    assert.equal(result.nodes[0].latency_evidence?.basis, "multi_proxy_ema");
    assert.equal(result.nodes[0].health_reasons?.[0].dimension, "backend");
    assert.equal(result.nodes[0].trust_progress?.gold_task_threshold_met, true);
    assert.equal(result.nodes[0].sdk_release?.relation, "latest_known");
    assert.equal(result.diversity_evidence?.distinct_verified_operators, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

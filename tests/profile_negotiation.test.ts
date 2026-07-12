import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { IicpClient } from "../src/client.js";

const request = {
  profile_id: "iicp.profile.compatibility.v0",
  profile_version: "0.3.0-draft",
  profile_fixture_sha256: "a".repeat(64),
  required: true,
};

test("profile negotiation fixture matches the discovery wire contract", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "parity/profile-negotiation-v0.json"), "utf8"));
  assert.equal(fixture.fixture_version, "0.2.0-draft");
  assert.equal(fixture.profile_fixture_sha256, "4137ecf91b4748a2b368cf4428b4604c6947f8879d77402cc7937d11d24b2aaf");
  for (const item of fixture.cases) {
    if (item.expected.requested) assert.equal(item.request.profile_fixture_sha256.length, 64, item.name);
  }
});

test("required profile negotiation is encoded and exposed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.searchParams.get("profile_id"), request.profile_id);
    assert.equal(parsed.searchParams.get("profile_required"), "true");
    return new Response(JSON.stringify({
      nodes: [{ node_id: "node-a", endpoint: "https://node.example.com", score: 0.8, available: true, region: "eu-central" }],
      profile_negotiation: { requested: true, status: "compatible", reason: "compatible", dispatch_allowed: true },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await new IicpClient({ directory_url: "https://directory.example", route_discovery_mode: "legacy" }).discoverWithNegotiation("urn:iicp:intent:llm:chat:v1", { profile_request: request });
    assert.equal(result.nodes.length, 1);
    assert.equal(result.profile_negotiation?.status, "compatible");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("required profile negotiation fails closed when absent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ nodes: [] }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      () => new IicpClient({ directory_url: "https://directory.example", route_discovery_mode: "legacy" }).discoverWithNegotiation("urn:iicp:intent:llm:chat:v1", { profile_request: request }),
      /required pre-normative profile/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

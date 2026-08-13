// Phase 2 (#529/#55): re-register sends current_node_token ownership proof
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { IicpNode } from "../src/node.js";

const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/e050-client-credential-lifecycle-v1.json", import.meta.url), "utf8"),
) as { scenarios: Array<Record<string, unknown>> };

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

  it("applies the shared credential rotation and refusal lifecycle", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const node = new IicpNode({
        nodeId: "n-reg",
        endpoint: "https://node.example.com",
        intent: "urn:iicp:intent:llm:chat:v1",
        model: "llama-3-8b",
        region: "eu-central",
        directoryUrl: "https://iicp.test",
      });
      for (const scenario of fixture.scenarios) {
        const starting = scenario.starting_token as string | null;
        (node as unknown as { _runtimeToken: string })._runtimeToken = starting ?? "";
        let body: Record<string, unknown> = {};
        globalThis.fetch = async (_url, opts) => {
          body = JSON.parse(String(opts?.body ?? "{}"));
          return new Response(
            JSON.stringify(
              scenario.directory_token
                ? { node_token: scenario.directory_token }
                : { error: "IICP-E050" },
            ),
            { status: Number(scenario.directory_status), headers: { "content-type": "application/json" } },
          );
        };
        const before = (node as unknown as { _runtimeToken: string })._runtimeToken;
        if (scenario.directory_status === 201) {
          await node.register();
          assert.equal((node as unknown as { _runtimeToken: string })._runtimeToken, scenario.expected_saved_token);
        } else {
          await assert.rejects(node.register());
          assert.equal((node as unknown as { _runtimeToken: string })._runtimeToken, before);
        }
        assert.equal(
          (node as unknown as { _runtimeToken: string })._runtimeToken,
          scenario.expected_saved_token,
        );
        assert.equal(body.current_node_token, scenario.expected_request_token ?? undefined);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

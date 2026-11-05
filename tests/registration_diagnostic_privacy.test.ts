import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IicpNode } from "../src/node.js";

const marker = "SYNTHETIC_REGISTRATION_DETAIL_NOT_FOR_DIAGNOSTICS";
const directory = "https://directory.example.invalid";

function node(): IicpNode {
  return new IicpNode({
    nodeId: "synthetic-registration-node",
    endpoint: "https://provider.example.invalid",
    intent: "urn:iicp:intent:llm:chat:v1",
    model: "fixture-model",
    directoryUrl: directory,
  });
}

async function withResponse(body: unknown, check: (instance: IicpNode) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `${directory}/v1/register`);
    assert.equal(init?.method, "POST");
    calls += 1;
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    await check(node());
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
}

const rejected = [
  { name: "missing-token", body: { private_detail: marker } },
  { name: "null-token", body: { node_token: null, token: null, node_hmac_key: marker } },
  { name: "empty-tokens", body: { node_token: "", token: "", private_detail: marker } },
  // TypeScript's existing nullish selection does not use an alias after an empty primary.
  { name: "empty-primary-preserves-rejection", body: { node_token: "", token: "alias", private_detail: marker } },
];

describe("registration diagnostic privacy", { concurrency: false }, () => {
  for (const item of rejected) {
    it(`redacts response for ${item.name}`, async () => {
      await withResponse(item.body, async (instance) => {
        instance.seedToken("synthetic-existing-token");
        await assert.rejects(instance.register(), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "Directory did not return node_token");
          assert.equal(error.message.includes(marker), false);
          return true;
        });
        assert.equal((instance as unknown as { _runtimeToken: string })._runtimeToken, "synthetic-existing-token");
      });
    });
  }
  for (const item of [
    { body: { node_token: "primary", token: "alias" }, expected: "primary" },
    { body: { token: "alias" }, expected: "alias" },
    { body: { node_token: null, token: "alias" }, expected: "alias" },
  ]) {
    it(`preserves token selection for ${JSON.stringify(item.body)}`, async () => {
      await withResponse(item.body, async (instance) => {
        assert.equal(await instance.register(), item.expected);
      });
    });
  }
});

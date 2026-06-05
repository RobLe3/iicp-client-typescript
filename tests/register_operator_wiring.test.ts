// SPDX-License-Identifier: Apache-2.0
/**
 * #463/#464 — the register payload carries the operator identity (delegation + display_name)
 * so the directory records the operator + surfaces display_name on node detail; it NEVER
 * sends the operator's secret key or contact/email. Fails without the wiring (payload would
 * omit operator_display_name).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IicpNode } from "../src/node.js";
import { generateOperator, operatorSigningKey } from "../src/identity.js";
import { issueDelegation } from "../src/delegation.js";

function fakeFetch(capture: { body?: Record<string, unknown> }) {
  return async (_url: string | URL, init?: { body?: string }) => {
    capture.body = JSON.parse(init?.body ?? "{}");
    return { ok: true, status: 201, json: async () => ({ node_token: "tok", node_hmac_key: "hk" }) } as Response;
  };
}

describe("#463 register operator wiring", () => {
  it("payload carries operator delegation + display_name, never the secret or contact", async () => {
    const op = generateOperator({ display_name: "Rebel One", contact: "me@example.com" });
    const nodeId = "test-node-1";
    const node = new IicpNode({
      nodeId,
      endpoint: "http://host.test:9484",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "m",
      operatorDelegation: issueDelegation(operatorSigningKey(op), nodeId),
      operatorDisplayName: op.display_name,
      operatorCreatedAt: op.created_at,
      operatorIntegrityHash: op.operator_integrity_hash,
    });
    const capture: { body?: Record<string, unknown> } = {};
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch(capture) as typeof fetch;
    try {
      await node.register();
    } finally {
      globalThis.fetch = orig;
    }
    const b = capture.body!;
    const deleg = b.operator_delegation as { operator_pub: string };
    assert.equal(deleg.operator_pub, op.operator_id); // operator_pub IS operator_id (#464)
    assert.equal(b.operator_display_name, "Rebel One");
    assert.equal(b.operator_integrity_hash, op.operator_integrity_hash);
    const raw = JSON.stringify(b);
    assert.ok(!raw.includes(op.operator_secret!), "secret key must never be sent");
    assert.ok(!raw.includes("me@example.com"), "contact/email must never be sent");
    assert.ok(!raw.includes("operator_secret"));
    assert.ok(!raw.includes("contact"));
  });

  it("omits operator fields when no operator identity is bound", async () => {
    const node = new IicpNode({
      nodeId: "n2",
      endpoint: "http://host.test:9484",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "m",
    });
    const capture: { body?: Record<string, unknown> } = {};
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch(capture) as typeof fetch;
    try {
      await node.register();
    } finally {
      globalThis.fetch = orig;
    }
    assert.ok(!("operator_delegation" in capture.body!));
    assert.ok(!("operator_display_name" in capture.body!));
  });
});

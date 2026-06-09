// SPDX-License-Identifier: Apache-2.0
/**
 * TC-9c — server-side CIPWorkerReceipt posting.
 *
 * Behavior test: postCipReceipt() fires an HMAC-signed POST to /v1/credits/award
 * after a successful task. Fails if the fix is reverted (no call fired / wrong HMAC).
 *
 * #WQ-079 — credit system gap: iicp-node serve never posted receipts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createHmac, createHash } from "node:crypto";
import { postCipReceipt } from "../src/node.js";

/** Start a one-shot HTTP server, return port + first-request capture. */
function captureServer(): Promise<{ port: number; capture: () => Promise<{ body: Record<string, unknown>; auth: string }> }> {
  return new Promise((resolve) => {
    let captured: ((v: { body: Record<string, unknown>; auth: string }) => void) | null = null;
    const pending = new Promise<{ body: Record<string, unknown>; auth: string }>((r) => { captured = r; });
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const auth = (req.headers["authorization"] as string) ?? "";
        captured!({ body, auth });
        srv.close();
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, capture: () => pending });
    });
  });
}

describe("postCipReceipt — TC-9c server-side award path", () => {
  it("posts to /v1/credits/award with a valid HMAC signature", async () => {
    const { port, capture } = await captureServer();

    const hmacKey = "test-hmac-key-abc123";
    const taskId = "task-abc-001";
    const tokensUsed = 75;
    const result = { status: "completed", result: { answer: "hello", usage: { total_tokens: 75 } } };

    await postCipReceipt({
      directoryUrl: `http://127.0.0.1:${port}`,
      token: "bearer-tok",
      hmacKey,
      nodeId: "node-test-1",
      taskId,
      tokensUsed,
      result,
    });

    const { body, auth } = await capture();

    // Authorization header.
    assert.equal(auth, "Bearer bearer-tok");

    // Required fields.
    assert.equal(body["node_id"], "node-test-1");
    assert.equal(body["task_id"], taskId);
    assert.equal(body["tokens_used"], tokensUsed);
    assert.equal(body["reason"], "task_completion");
    assert.ok(typeof body["nonce"] === "string" && (body["nonce"] as string).length === 32);
    assert.ok(typeof body["expires_at"] === "string");
    assert.ok(typeof body["signature"] === "string" && (body["signature"] as string).length === 64);
    assert.ok(typeof body["response_hash"] === "string" && (body["response_hash"] as string).length === 64);

    // amount: max(75,1)/1000 = 0.075
    assert.equal(body["amount"] as number, 0.075);

    // Verify response_hash = SHA-256 of canonical JSON with sorted keys.
    const expectedCanonical = JSON.stringify(result, (_k, v: unknown) => {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        );
      }
      return v;
    });
    const expectedResponseHash = createHash("sha256").update(expectedCanonical, "utf8").digest("hex");
    assert.equal(body["response_hash"] as string, expectedResponseHash, "response_hash mismatch");

    // Verify HMAC signature over canonical message.
    const msg = `${taskId}:${tokensUsed}:::${body["nonce"]}:${body["response_hash"]}`;
    const expectedSig = createHmac("sha256", hmacKey).update(msg, "utf8").digest("hex");
    assert.equal(body["signature"] as string, expectedSig, "HMAC signature mismatch");
  });

  it("sends amount floored at 0.001 for 0-token tasks", async () => {
    const { port, capture } = await captureServer();

    await postCipReceipt({
      directoryUrl: `http://127.0.0.1:${port}`,
      token: "tok",
      hmacKey: "key",
      nodeId: "n1",
      taskId: "t1",
      tokensUsed: 0,
      result: { status: "completed" },
    });

    const { body } = await capture();
    // max(0,1)/1000 = 0.001
    assert.equal(body["amount"] as number, 0.001);
  });

  // #488 — self-query neutrality: querying_node_id forwarded in receipt body.
  it("includes querying_node_id in request body when provided", async () => {
    const { port, capture } = await captureServer();

    await postCipReceipt({
      directoryUrl: `http://127.0.0.1:${port}`,
      token: "tok",
      hmacKey: "key",
      nodeId: "serving-node",
      taskId: "t-self",
      tokensUsed: 10,
      result: { status: "completed" },
      queryingNodeId: "querying-node-abc",
    });

    const { body } = await capture();
    assert.equal(body["querying_node_id"] as string, "querying-node-abc",
      "querying_node_id must be forwarded to directory for self-query detection");
  });

  it("omits querying_node_id from body when not provided", async () => {
    const { port, capture } = await captureServer();

    await postCipReceipt({
      directoryUrl: `http://127.0.0.1:${port}`,
      token: "tok",
      hmacKey: "key",
      nodeId: "serving-node",
      taskId: "t-no-qni",
      tokensUsed: 10,
      result: { status: "completed" },
    });

    const { body } = await capture();
    assert.ok(!("querying_node_id" in body),
      "querying_node_id must be absent when not provided (backwards compat)");
  });
});

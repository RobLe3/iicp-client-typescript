/**
 * #456 — `iicp-node credits` CLI.
 *
 * Renders a 200 summary, and ERRORS on 401: a forged/wrong token cannot fabricate
 * credits (figures come authenticated from the directory, not the local config).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { main } from "../src/cli.js";

/** Single-shot mock of GET /v1/credits/summary on a free port. */
function serveOnce(status: number, body: string): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
      srv.close();
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

describe("iicp-node credits", () => {
  it("renders on a 200 summary", async () => {
    const body = JSON.stringify({
      node_id: "n1",
      total_earned: 142.5,
      total_spent: 38.25,
      balance: 104.25,
      tx_count: 2,
      reconciles: true,
      unit: "credit",
      tokens_per_credit: 1000,
    });
    const port = await serveOnce(200, body);
    const rc = await main([
      "credits", "--node-id", "n1", "--token", "t",
      "--directory-url", `http://127.0.0.1:${port}`, "--json",
    ]);
    assert.equal(rc, 0);
  });

  it("errors on a forged token (401) — local config cannot fabricate credits", async () => {
    const body = JSON.stringify({ error: { code: "unauthorized", message: "invalid node_token" } });
    const port = await serveOnce(401, body);
    const rc = await main([
      "credits", "--node-id", "n1", "--token", "forged",
      "--directory-url", `http://127.0.0.1:${port}`,
    ]);
    assert.equal(rc, 1);
  });
});

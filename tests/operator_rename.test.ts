// SPDX-License-Identifier: Apache-2.0
/**
 * #460 — `iicp-node operator rename <name>` CLI.
 *
 * Behavior: the command signs the canonical rename bytes with the OPERATOR's own key and
 * POSTs {operator_pub, display_name, ts, sig} to /v1/operator/rename; operator_pub equals
 * the operator_id; the signature verifies; the secret/contact are NEVER sent; and the local
 * operator.json display_name is updated on success. Fails without the wiring.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { main } from "../src/cli.js";
import { generateOperator, loadOperator, saveOperator } from "../src/identity.js";
import { canonicalRenameBytes } from "../src/delegation.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function oneShot(status: number, body: string, sink: { payload?: Record<string, unknown> }): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        sink.payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

describe("#460 operator rename CLI (TS)", () => {
  let home: string;
  const origHome = process.env.IICP_HOME;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "iicp-rename-"));
    process.env.IICP_HOME = home;
  });
  after(() => {
    if (origHome === undefined) delete process.env.IICP_HOME;
    else process.env.IICP_HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("signs with the operator key, posts, and updates the local identity", async () => {
    const op = generateOperator({ display_name: "Old Name", contact: "me@example.com" });
    saveOperator(op);
    const sink: { payload?: Record<string, unknown> } = {};
    const srv = await oneShot(200, '{"display_name":"New Name"}', sink);
    const port = (srv.address() as { port: number }).port;

    const rc = await main(["operator", "rename", "New Name", "--directory-url", `http://127.0.0.1:${port}`]);
    srv.close();
    assert.equal(rc, 0);

    const p = sink.payload!;
    assert.equal(p["operator_pub"], op.operator_id); // operator_pub IS the operator_id (#464)
    assert.equal(p["display_name"], "New Name");
    assert.equal(p["operator_secret"], undefined); // never transmitted
    assert.equal(p["contact"], undefined);
    const pk = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(op.operator_id, "base64")]),
      format: "der",
      type: "spki",
    });
    assert.ok(
      verify(
        null,
        canonicalRenameBytes("New Name", op.operator_id, p["ts"] as number),
        pk,
        Buffer.from(p["sig"] as string, "base64"),
      ),
    );
    assert.equal(loadOperator()!.display_name, "New Name");
  });

  it("errors on directory rejection without mutating the local identity", async () => {
    saveOperator(generateOperator({ display_name: "Keep" }));
    const sink: { payload?: Record<string, unknown> } = {};
    const srv = await oneShot(404, '{"error":{"code":"IICP-E044","message":"unknown operator"}}', sink);
    const port = (srv.address() as { port: number }).port;

    const rc = await main(["operator", "rename", "Ghost", "--directory-url", `http://127.0.0.1:${port}`]);
    srv.close();
    assert.equal(rc, 1);
    assert.equal(loadOperator()!.display_name, "Keep");
  });
});

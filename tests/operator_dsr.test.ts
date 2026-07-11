// SPDX-License-Identifier: Apache-2.0
/** #599 — CLI-assisted operator data-subject-rights flow. */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { canonicalOperatorSelfServiceBytes } from "../src/delegation.js";
import { generateOperator, saveOperator } from "../src/identity.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

describe("#599 operator DSR CLI (TS)", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalFetch: typeof fetch;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "iicp-dsr-"));
    originalHome = process.env.IICP_HOME;
    process.env.IICP_HOME = home;
    originalFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.IICP_HOME;
    else process.env.IICP_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("signs a one-use challenge locally and writes export mode 0600", async () => {
    const op = generateOperator({ display_name: "Rights Test", contact: "private@example.test" });
    saveOperator(op);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/challenge")) return new Response(JSON.stringify({ nonce: "nonce-1234567890123456" }), { status: 200 });
      return new Response(JSON.stringify({ schema: "iicp.dsr.export.v1", tracking_id: "dsr-test", retention_notice: "ledger retained" }), { status: 200 });
    }) as typeof fetch;

    const output = join(home, "rights.json");
    const rc = await main(["operator", "dsr", "export", "--directory-url", "https://directory.test/api", "--output", output]);
    assert.equal(rc, 0);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { schema: "iicp.dsr.export.v1", tracking_id: "dsr-test", retention_notice: "ledger retained" });
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(requests.length, 2);
    const payload = requests[1].body;
    assert.equal(payload.operator_pub, op.operator_id);
    assert.equal(payload.operator_secret, undefined);
    assert.equal(payload.contact, undefined);
    const pub = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(op.operator_id, "base64")]), format: "der", type: "spki" });
    assert.equal(verify(null, canonicalOperatorSelfServiceBytes("dsr_export", payload), pub, Buffer.from(payload.sig as string, "base64")), true);
  });

  it("requires explicit confirmation for destructive actions", async () => {
    const rc = await main(["operator", "dsr", "anonymize"]);
    assert.equal(rc, 2);
  });
});

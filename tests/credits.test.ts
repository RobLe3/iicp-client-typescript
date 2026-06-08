/**
 * #456 — `iicp-node credits` CLI.
 *
 * Renders a 200 summary, and ERRORS on 401: a forged/wrong token cannot fabricate
 * credits (figures come authenticated from the directory, not the local config).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { main, verifyCreditAwards } from "../src/cli.js";
import { saveNode } from "../src/identity.js";

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

// --- credits node auto-selection fallback (regression: default.json no token → opaque error) ---
describe("iicp-node credits — default-no-token fallback", () => {
  let tmpHome: string;
  let savedHome: string | undefined;

  function makeTestNode(name: string, nodeToken?: string): void {
    saveNode({
      node_id: `node-${name}`,
      operator_id: "op-test",
      name,
      backend_url: "http://localhost:11434",
      model: "test:1b",
      intent: "urn:iicp:intent:llm:chat:v1",
      region: "unknown",
      directory_url: "https://iicp.network/api",
      max_concurrent: 4,
      port: 8020,
      host: "0.0.0.0",
      public_endpoint: "",
      auto_detect_nat: false,
      external_ip_probe_url: "",
      node_token: nodeToken,
      created_at: new Date().toISOString(),
    });
  }

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "iicp-test-"));
    savedHome = process.env.IICP_HOME;
    process.env.IICP_HOME = tmpHome;
  });

  after(() => {
    if (savedHome === undefined) delete process.env.IICP_HOME;
    else process.env.IICP_HOME = savedHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("default-no-token + one node with token → falls back and prints hint", async () => {
    // Regression: default.json exists but has no cached token; exactly one other
    // node has a token. credits must auto-select that node rather than emitting the
    // opaque "no node_token — run serve" error.
    makeTestNode("default", undefined);
    makeTestNode("ollama", "tok-ollama");
    const lines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(typeof s === "string" ? s : s.toString());
      return (origWrite as (...a: unknown[]) => boolean)(s, ...rest);
    };
    try {
      await main(["credits"]);
    } finally {
      process.stderr.write = origWrite;
    }
    const err = lines.join("");
    assert.ok(err.includes("no cached token"), `expected 'no cached token' in: ${err}`);
    assert.ok(err.includes("ollama"), `expected 'ollama' in: ${err}`);
    // Specifically check that the "multiple saved nodes — pass --node" ambiguity error is absent.
    assert.ok(!err.includes("multiple saved nodes"), `unexpected ambiguity error in: ${err}`);
  });

  it("default-no-token + multiple nodes with tokens → lists them", async () => {
    makeTestNode("lmstudio", "tok-b");  // ollama + lmstudio already saved above
    const lines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(typeof s === "string" ? s : s.toString());
      return (origWrite as (...a: unknown[]) => boolean)(s, ...rest);
    };
    try {
      await main(["credits"]);
    } finally {
      process.stderr.write = origWrite;
    }
    const err = lines.join("");
    assert.ok(err.includes("no cached token"), `expected 'no cached token' in: ${err}`);
    assert.ok(err.includes("ollama"), `expected 'ollama' in: ${err}`);
    assert.ok(err.includes("lmstudio"), `expected 'lmstudio' in: ${err}`);
  });
});

// --- #456 --verify: cryptographic audit + tamper rejection (fails without the fix, #404) ---

/** Canonical form matching the directory + the verifier, for signing test events. */
function canonForSign(obj: Record<string, unknown>): string {
  const enc = (v: unknown): string =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? canonForSign(v as Record<string, unknown>)
      : JSON.stringify(v);
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + enc(obj[k])).join(",") + "}";
}

/** Build a directory-signed CREDIT_AWARD event log + the matching did.json `x`. */
function makeSignedEvents(payload: Record<string, unknown>): {
  x: string;
  events: unknown;
  sign: (p: Record<string, unknown>) => string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const x = Buffer.from(der.subarray(der.length - 32)).toString("base64url");
  const eventId = "11111111-1111-1111-1111-111111111111";
  const seq = 2;
  const tsMs = 1_700_000_000_000;
  // #458: genesis-case hash-chain link, bound into the signing input.
  const prevHash = "c44802bedf3e63b5a3f1634c5d19263634f92f26dd15401b09b06dd53a80cf9d";
  const signFor = (p: Record<string, unknown>): string => {
    const ph = createHash("sha256").update(canonForSign(p)).digest("hex");
    const msg = createHash("sha256")
      .update(`${eventId}:CREDIT_AWARD:${seq}:${tsMs}:${ph}:${prevHash}`)
      .digest();
    return sign(null, msg, privateKey).toString("hex");
  };
  const events = {
    events: [
      {
        event_id: eventId,
        event_type: "CREDIT_AWARD",
        seq,
        ts_ms: tsMs,
        node_id: "n1",
        payload,
        prev_hash: prevHash,
        sig: signFor(payload),
      },
    ],
    next_seq: seq,
    has_more: false,
  };
  return { x, events, sign: signFor };
}

/** Two-path mock: /.well-known/did.json + /v1/events. */
function serveVerify(x: string, events: unknown): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const did = { verificationMethod: [{ publicKeyJwk: { kty: "OKP", crv: "Ed25519", x } }] };
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url?.includes("did.json") ? did : events));
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, close: () => srv.close() });
    });
  });
}

describe("iicp-node credits --verify", () => {
  it("accepts a validly-signed CREDIT_AWARD", async () => {
    const { x, events } = makeSignedEvents({ amount: 5.0, new_balance: 5.0, task_id: "t1" });
    const { port, close } = await serveVerify(x, events);
    try {
      const v = await verifyCreditAwards(`http://127.0.0.1:${port}`, "n1");
      assert.deepEqual(v, { sum: 5, verified: 1, failed: 0 });
    } finally {
      close();
    }
  });

  it("rejects a tampered amount (signature no longer matches)", async () => {
    const { x, events } = makeSignedEvents({ amount: 5.0, new_balance: 5.0, task_id: "t1" });
    // Mutate the awarded amount while keeping the original signature — a lying directory.
    (events as { events: { payload: Record<string, unknown> }[] }).events[0]!.payload["amount"] = 9999.0;
    const { port, close } = await serveVerify(x, events);
    try {
      const v = await verifyCreditAwards(`http://127.0.0.1:${port}`, "n1");
      assert.equal(v.verified, 0, "tampered amount must not verify");
      assert.ok(v.failed >= 1, "tampered award must be counted as a failure");
    } finally {
      close();
    }
  });
});

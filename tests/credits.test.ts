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

  it("human output shows the operator wallet before the node ledger", async () => {
    const body = JSON.stringify({
      node_id: "n1",
      total_earned: 2.5,
      total_spent: 1.0,
      balance: 1.5,
      tx_count: 3,
      reconciles: true,
      unit: "credit",
      tokens_per_credit: 1000,
      operator_wallet: {
        total_balance: 8.5,
        total_earned: 10.0,
        total_spent: 1.5,
        tx_count: 6,
        node_count: 2,
        reconciles: true,
        operator_fingerprint: "abc123",
      },
    });
    const port = await serveOnce(200, body);
    let out = "";
    const oldWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = await main([
        "credits", "--node-id", "n1", "--token", "t",
        "--directory-url", `http://127.0.0.1:${port}`,
      ]);
      assert.equal(rc, 0);
    } finally {
      process.stdout.write = oldWrite;
    }
    assert.match(out, /IICP operator wallet · operator abc123/);
    assert.match(out, /Wallet balance/);
    assert.match(out, /Node ledger — n1/);
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

  it("default-no-token + multiple nodes with tokens → shows credits for all (0.7.44)", async () => {
    // 0.7.44 fix: when multiple nodes have tokens, the command shows credits for ALL
    // rather than emitting a "no cached token — pass --node" listing error.
    // Behavior test: if the fix is reverted, "showing credits for all" disappears and
    // "no cached token" reappears. (Fetch results in network error since no mock server —
    // that is fine; the intent assertion is on the routing message in stderr.)
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
    // Must route to "show all" path — NOT the old listing-error path
    assert.ok(err.includes("showing credits for all"), `expected 'showing credits for all' in: ${err}`);
    assert.ok(!err.includes("no cached token"), `unexpected old listing-error message in: ${err}`);
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

// --- 2026-06-11: transient-failure retry + all-nodes continue-on-error ---
describe("iicp-node credits — retry + multi-node resilience", () => {
  const OK_BODY = JSON.stringify({
    node_id: "n1", total_earned: 5, total_spent: 0, balance: 5,
    tx_count: 1, reconciles: true, unit: "credit", tokens_per_credit: 1000,
  });
  const WALLET_BODY = JSON.stringify({
    node_id: "n1",
    total_earned: 2.5,
    total_spent: 1.0,
    balance: 1.5,
    tx_count: 3,
    reconciles: true,
    unit: "credit",
    tokens_per_credit: 1000,
    operator_wallet: {
      total_balance: 8.5,
      total_earned: 10.0,
      total_spent: 1.5,
      tx_count: 6,
      node_count: 2,
      reconciles: true,
      operator_fingerprint: "abc123",
    },
  });
  const ERR_BODY = JSON.stringify({
    error: { code: "server_error", message: "An internal error occurred" },
  });

  /** Mock server answering successive requests from `responses`; counts calls. */
  function serveSequence(
    responses: Array<[number, string]>,
  ): Promise<{ port: number; calls: () => number; close: () => void }> {
    return new Promise((resolve) => {
      let n = 0;
      const srv = http.createServer((_req, res) => {
        const [status, body] = responses[Math.min(n, responses.length - 1)]!;
        n++;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      });
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        resolve({
          port: typeof addr === "object" && addr ? addr.port : 0,
          calls: () => n,
          close: () => srv.close(),
        });
      });
    });
  }

  it("retries once on a transient 500 and succeeds (fails if retry removed)", async () => {
    const srv = await serveSequence([[500, ERR_BODY], [200, OK_BODY]]);
    try {
      const rc = await main([
        "credits", "--node-id", "n1", "--token", "t",
        "--directory-url", `http://127.0.0.1:${srv.port}`, "--json",
      ]);
      assert.equal(rc, 0, "transient 500 followed by 200 must succeed via retry");
      assert.equal(srv.calls(), 2);
    } finally {
      srv.close();
    }
  });

  it("does not retry a definitive 4xx", async () => {
    const srv = await serveSequence([[401, JSON.stringify({ error: { message: "bad token" } })]]);
    try {
      const rc = await main([
        "credits", "--node-id", "n1", "--token", "bad",
        "--directory-url", `http://127.0.0.1:${srv.port}`,
      ]);
      assert.equal(rc, 1);
      assert.equal(srv.calls(), 1, "definitive 4xx must not be retried");
    } finally {
      srv.close();
    }
  });

  it("all-nodes listing continues past a failing node and exits non-zero", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "iicp-test-"));
    const savedHome = process.env.IICP_HOME;
    process.env.IICP_HOME = tmpHome;
    const bad = await serveSequence([[500, ERR_BODY], [500, ERR_BODY]]);
    const good = await serveSequence([[200, OK_BODY], [200, OK_BODY]]);
    const outLines: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array, ...rest: unknown[]) => {
      outLines.push(typeof s === "string" ? s : s.toString());
      return (origOut as (...a: unknown[]) => boolean)(s, ...rest);
    };
    try {
      const base = {
        operator_id: "op-test", backend_url: "http://localhost:11434",
        model: "test:1b", intent: "urn:iicp:intent:llm:chat:v1", region: "unknown",
        max_concurrent: 4, port: 8020, host: "0.0.0.0", public_endpoint: "",
        auto_detect_nat: false, external_ip_probe_url: "",
        created_at: new Date().toISOString(),
      };
      // 'default' without token + ≥2 nodes with tokens → all-nodes path.
      saveNode({ ...base, node_id: "n-def", name: "default", directory_url: "https://iicp.network/api", node_token: undefined });
      saveNode({ ...base, node_id: "n-bad", name: "aaa-bad", directory_url: `http://127.0.0.1:${bad.port}`, node_token: "t1" });
      saveNode({ ...base, node_id: "n-good", name: "zzz-good", directory_url: `http://127.0.0.1:${good.port}`, node_token: "t2" });

      const rc = await main(["credits"]);
      const out = outLines.join("");
      assert.ok(out.includes("zzz-good"), `the healthy node must still be displayed; got: ${out}`);
      assert.equal(rc, 1, "exit must be non-zero when any node failed");
    } finally {
      process.stdout.write = origOut;
      bad.close();
      good.close();
      if (savedHome === undefined) delete process.env.IICP_HOME;
      else process.env.IICP_HOME = savedHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("all-nodes listing prints the operator wallet once, then every node ledger", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "iicp-test-"));
    const savedHome = process.env.IICP_HOME;
    process.env.IICP_HOME = tmpHome;
    const a = await serveSequence([[200, WALLET_BODY]]);
    const b = await serveSequence([[200, WALLET_BODY]]);
    const outLines: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array, ...rest: unknown[]) => {
      outLines.push(typeof s === "string" ? s : s.toString());
      return (origOut as (...a: unknown[]) => boolean)(s, ...rest);
    };
    try {
      const base = {
        operator_id: "op-test", backend_url: "http://localhost:11434",
        model: "test:1b", intent: "urn:iicp:intent:llm:chat:v1", region: "unknown",
        max_concurrent: 4, port: 8020, host: "0.0.0.0", public_endpoint: "",
        auto_detect_nat: false, external_ip_probe_url: "",
        created_at: new Date().toISOString(),
      };
      saveNode({ ...base, node_id: "n-def", name: "default", directory_url: "https://iicp.network/api", node_token: undefined });
      saveNode({ ...base, node_id: "n-a", name: "aaa", directory_url: `http://127.0.0.1:${a.port}`, node_token: "t1" });
      saveNode({ ...base, node_id: "n-b", name: "bbb", directory_url: `http://127.0.0.1:${b.port}`, node_token: "t2" });

      const rc = await main(["credits"]);
      const out = outLines.join("");
      assert.equal(rc, 0);
      assert.equal((out.match(/IICP operator wallet/g) ?? []).length, 1, out);
      assert.ok(out.includes("Node ledger — aaa"), out);
      assert.ok(out.includes("Node ledger — bbb"), out);
    } finally {
      process.stdout.write = origOut;
      a.close();
      b.close();
      if (savedHome === undefined) delete process.env.IICP_HOME;
      else process.env.IICP_HOME = savedHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

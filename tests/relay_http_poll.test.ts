// ADR-016: IICP client SDK conformance — #450 HTTP long-poll relay transport
// (TypeScript parity with iicp-client-python tests/test_relay_http_poll.py).
//
// Behavior tests (fail if the #450 implementation is reverted):
// - HttpPollWorkerSession queue/promise roundtrip + liveness semantics
// - POST /v1/relay/bind (200 token, 409 alive-rebind — #510 interim-C parity)
// - Bearer auth on pull/result/unbind (401 without/with-wrong token)
// - Path-scoped /v1/relay-for/<wid>/v1/task forwarding (R1 misattribution fix)
// - /v1/relay-for/<wid>/iicp/health session liveness view
// - CORS headers + OPTIONS preflight (web pages are first-class callers)
// - RELAY_ACK field 4 carries the relay HTTP port
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as net from "node:net";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IicpNode } from "../src/node.js";
import {
  decryptPayloadWithContext,
  decryptResponse,
  encryptPayloadWithContext,
  encryptResponse,
  loadOrCreateNodeCxKey,
} from "../src/confidentiality.js";
import {
  HttpPollWorkerSession,
  RelayAcceptServer,
  RelaySessionRegistry,
} from "../src/relay_session.js";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signedTicket(workerId: string, relayId: string): { token: string; publicKeyHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  const payload = b64url(JSON.stringify({
    v: 1, typ: "relay-bind-ticket", jti: randomBytes(16).toString("hex"),
    iss: "test", sub: workerId, aud: relayId, iat: 1, exp: 9_999_999_999,
  }));
  const sigHex = sign(null, Buffer.from("iicp:relay-bind-ticket:v1\n" + payload), privateKey).toString("hex");
  return { token: `${payload}.${sigHex}`, publicKeyHex };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// ── HttpPollWorkerSession unit behavior ──────────────────────────────────────

describe("HttpPollWorkerSession", () => {
  it("forward → pull → result roundtrip", async () => {
    const sess = new HttpPollWorkerSession("w-browser", { models: ["tinyllama"] });
    const forward = sess.forwardTask({ payload: { q: 1 } }, 5_000);
    const call = await sess.nextCall(5_000);
    assert.ok(call);
    assert.deepEqual((call.task as Record<string, unknown>).payload, { q: 1 });
    sess.onResponse(call.call_id, { result: { a: 2 } });
    assert.deepEqual(await forward, { result: { a: 2 } });
  });

  it("nextCall times out to null", async () => {
    const sess = new HttpPollWorkerSession("w-idle");
    assert.equal(await sess.nextCall(50), null);
  });

  it("liveness window and close", async () => {
    const sess = new HttpPollWorkerSession("w-live", { livenessWindowMs: 50 });
    assert.equal(sess.isAlive(), true);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sess.isAlive(), false); // stale — displaceable
    const fresh = new HttpPollWorkerSession("w-fresh");
    fresh.close();
    assert.equal(fresh.isAlive(), false);
  });

  it("registry getByToken", () => {
    const reg = new RelaySessionRegistry();
    const sess = new HttpPollWorkerSession("w-tok");
    reg.bind("w-tok", sess);
    assert.strictEqual(reg.getByToken(sess.sessionToken), sess);
    assert.equal(reg.getByToken("wrong"), undefined);
    assert.equal(reg.getByToken(""), undefined);
  });
});

// ── RELAY_ACK http_port field ────────────────────────────────────────────────

describe("RelayAcceptServer httpPort", () => {
  it("carries the configured HTTP port for RELAY_ACK field 4", () => {
    const srv = new RelayAcceptServer(new RelaySessionRegistry(), {
      host: "127.0.0.1",
      port: 0,
      httpPort: 12345,
    });
    assert.equal(srv.httpPort, 12345);
  });

  it("defaults to 9484 when unspecified", () => {
    const srv = new RelayAcceptServer(new RelaySessionRegistry(), {});
    assert.equal(srv.httpPort, 9484);
  });
});

// ── HTTP endpoint behavior (real serve()) ────────────────────────────────────

describe("relay HTTP-poll endpoints", () => {
  let port: number;
  let stop: () => void;
  let base: string;

  before(async () => {
    port = await freePort();
    const relayAcceptPort = await freePort();
    const node = new IicpNode({
      nodeId: "relay-node",
      endpoint: "http://relay.local",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "relay-model",
      directoryUrl: "https://iicp.test",
      relayCapable: true,
      relayAcceptPort,
    });
    stop = node.serve(async () => ({ result: { echo: true } }), {
      host: "127.0.0.1",
      port,
    });
    base = `http://127.0.0.1:${port}`;
    // wait for listen
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`${base}/iicp/health`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  });

  after(() => stop());

  async function bind(workerId: string, models: string[] = ["tinyllama-1.1b"], extra: Record<string, unknown> = {}) {
    return fetch(`${base}/v1/relay/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker_id: workerId, intent: "urn:iicp:intent:llm:chat:v1", models, ...extra }),
    });
  }

  it("bind returns token + CORS", async () => {
    const resp = await bind("w-bind-1");
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("access-control-allow-origin"), "*");
    const body = await resp.json();
    assert.ok(typeof body.session_token === "string" && body.session_token.length >= 32);
    assert.equal(body.worker_endpoint_path, "/v1/relay-for/w-bind-1");
  });

  it("alive rebind rejected 409", async () => {
    assert.equal((await bind("w-rebind")).status, 200);
    const resp2 = await bind("w-rebind");
    assert.equal(resp2.status, 409);
    const body = await resp2.json();
    assert.equal(body.error.code, "IICP-E038");
  });

  it("strict bind ticket mode accepts valid HTTP-poll tickets and rejects wrong workers", async () => {
    const good = signedTicket("w-http-ticket", "relay-node");
    const bad = signedTicket("attacker", "relay-node");
    const oldKey = process.env["IICP_RELAY_BIND_TICKET_PUBLIC_KEY"];
    const oldRequire = process.env["IICP_RELAY_REQUIRE_BIND_TICKET"];
    process.env["IICP_RELAY_BIND_TICKET_PUBLIC_KEY"] = good.publicKeyHex;
    process.env["IICP_RELAY_REQUIRE_BIND_TICKET"] = "1";
    try {
      const ok = await bind("w-http-ticket", [], { bind_ticket: good.token });
      assert.equal(ok.status, 200);
      const okBody = await ok.json();
      const unbind = await fetch(`${base}/v1/relay/unbind`, {
        method: "POST",
        headers: { Authorization: `Bearer ${okBody.session_token}` },
      });
      assert.equal(unbind.status, 204);
      const replay = await bind("w-http-ticket", [], { bind_ticket: good.token });
      assert.equal(replay.status, 409);
      assert.match((await replay.json()).error.message, /replayed/);
      const wrong = await bind("w-http-ticket-2", [], { bind_ticket: bad.token });
      assert.equal(wrong.status, 401);
      const body = await wrong.json();
      assert.equal(body.error.code, "IICP-E040");
      const missing = await bind("w-http-ticket-missing");
      assert.equal(missing.status, 401);
    } finally {
      if (oldKey === undefined) delete process.env["IICP_RELAY_BIND_TICKET_PUBLIC_KEY"]; else process.env["IICP_RELAY_BIND_TICKET_PUBLIC_KEY"] = oldKey;
      if (oldRequire === undefined) delete process.env["IICP_RELAY_REQUIRE_BIND_TICKET"]; else process.env["IICP_RELAY_REQUIRE_BIND_TICKET"] = oldRequire;
    }
  });

  it("bind requires worker_id", async () => {
    const resp = await fetch(`${base}/v1/relay/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "x" }),
    });
    assert.equal(resp.status, 422);
  });

  it("pull and result require bearer", async () => {
    assert.equal((await fetch(`${base}/v1/relay/pull`)).status, 401);
    assert.equal(
      (await fetch(`${base}/v1/relay/pull`, { headers: { Authorization: "Bearer nope" } })).status,
      401,
    );
    const r = await fetch(`${base}/v1/relay/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: JSON.stringify({ call_id: "x", result: {} }),
    });
    assert.equal(r.status, 401);
  });

  it("full dispatch roundtrip via /v1/relay-for", async () => {
    const bresp = await bind("w-roundtrip");
    assert.equal(bresp.status, 200);
    const { session_token: token } = await bresp.json();

    // Worker side: one pull → answer.
    const worker = (async () => {
      const pull = await fetch(`${base}/v1/relay/pull`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(pull.status, 200);
      const call = await pull.json();
      assert.equal((call.task as Record<string, unknown>).task_id, "t-1");
      await fetch(`${base}/v1/relay/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          call_id: call.call_id,
          result: { result: { text: "MESH OK from browser" } },
        }),
      });
    })();

    // Consumer side — exactly what a published SDK consumer sends.
    const dispatch = await fetch(`${base}/v1/relay-for/w-roundtrip/v1/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: "t-1",
        intent: "urn:iicp:intent:llm:chat:v1",
        payload: { messages: [{ role: "user", content: "hi" }] },
        constraints: { timeout_ms: 120000, qos: "best_effort" },
      }),
    });
    await worker;
    assert.equal(dispatch.status, 200);
    assert.equal(dispatch.headers.get("access-control-allow-origin"), "*");
    const resp = await dispatch.json();
    assert.equal(resp.status, "completed");
    assert.equal((resp.result as Record<string, unknown>).text, "MESH OK from browser");
  });

  it("strict bind keeps encrypted request and response opaque through the relay", async () => {
    const workerId = "w-cx-roundtrip";
    const taskId = "t-cx-relay-1";
    const secretText = "relay must never observe this plaintext";
    const ticket = signedTicket(workerId, "relay-node");
    const oldKey = process.env["IICP_RELAY_BIND_TICKET_PUBLIC_KEY"];
    const oldRequire = process.env["IICP_RELAY_REQUIRE_BIND_TICKET"];
    const oldCxDir = process.env["IICP_CX_KEY_DIR"];
    const cxDir = mkdtempSync(join(tmpdir(), "iicp-relay-cx-"));
    process.env["IICP_RELAY_BIND_TICKET_PUBLIC_KEY"] = ticket.publicKeyHex;
    process.env["IICP_RELAY_REQUIRE_BIND_TICKET"] = "1";
    process.env["IICP_CX_KEY_DIR"] = cxDir;
    try {
      const keys = loadOrCreateNodeCxKey(workerId, "relay://test");
      keys.publicKey.features = ["response_encryption_v1"];
      const encrypted = encryptPayloadWithContext(
        { secret: secretText }, keys.publicKey, taskId, "urn:iicp:intent:llm:chat:v1",
      );
      const bresp = await bind(workerId, [], { bind_ticket: ticket.token });
      assert.equal(bresp.status, 200);
      const { session_token: token } = await bresp.json();
      let relayVisible: Record<string, unknown> = {};

      const worker = (async () => {
        const pull = await fetch(`${base}/v1/relay/pull`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(pull.status, 200);
        const call = await pull.json();
        relayVisible = call;
        const task = call.task as Record<string, unknown>;
        assert.equal("payload" in task, false);
        const opened = decryptPayloadWithContext(
          task.iicp_conf as Record<string, unknown>, keys.privateKeyBytes, keys.publicKeyBytes,
        );
        assert.deepEqual(opened.payload, { secret: secretText });
        const plainResponse = {
          task_id: taskId,
          status: "success",
          result: { text: "encrypted relay response" },
        };
        const responseEnvelope = encryptResponse(plainResponse, opened.sharedSecret, taskId);
        await fetch(`${base}/v1/relay/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ call_id: call.call_id, result: { iicp_conf_resp: responseEnvelope } }),
        });
      })();

      const dispatch = await fetch(`${base}/v1/relay-for/${workerId}/v1/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          intent: "urn:iicp:intent:llm:chat:v1",
          iicp_conf: encrypted.envelope,
          cx_response_encryption: "required",
        }),
      });
      await worker;
      assert.equal(dispatch.status, 200);
      const response = await dispatch.json();
      assert.equal("result" in response, false);
      const openedResponse = decryptResponse(
        response.iicp_conf_resp as Record<string, unknown>, encrypted.sharedSecret, taskId,
      ) as Record<string, unknown>;
      assert.equal(((openedResponse.result as Record<string, unknown>).text), "encrypted relay response");
      assert.equal(JSON.stringify(relayVisible).includes(secretText), false);
      assert.equal(JSON.stringify(response).includes("encrypted relay response"), false);
    } finally {
      if (oldKey === undefined) delete process.env["IICP_RELAY_BIND_TICKET_PUBLIC_KEY"];
      else process.env["IICP_RELAY_BIND_TICKET_PUBLIC_KEY"] = oldKey;
      if (oldRequire === undefined) delete process.env["IICP_RELAY_REQUIRE_BIND_TICKET"];
      else process.env["IICP_RELAY_REQUIRE_BIND_TICKET"] = oldRequire;
      if (oldCxDir === undefined) delete process.env["IICP_CX_KEY_DIR"];
      else process.env["IICP_CX_KEY_DIR"] = oldCxDir;
      rmSync(cxDir, { recursive: true, force: true });
    }
  });

  it("relay-for unknown worker → 404 IICP-E030", async () => {
    const resp = await fetch(`${base}/v1/relay-for/w-ghost/v1/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: "t-x" }),
    });
    assert.equal(resp.status, 404);
    assert.equal((await resp.json()).error.code, "IICP-E030");
  });

  it("relay-for health reflects session", async () => {
    assert.equal((await bind("w-health", ["m1", "m2"])).status, 200);
    const resp = await fetch(`${base}/v1/relay-for/w-health/iicp/health`);
    assert.equal(resp.status, 200);
    const health = await resp.json();
    assert.equal(health.status, "ok");
    assert.equal(health.via_relay, true);
    assert.deepEqual(health.models, ["m1", "m2"]);
  });

  it("unbind releases the worker id", async () => {
    const bresp = await bind("w-unbind");
    const { session_token: token } = await bresp.json();
    const u = await fetch(`${base}/v1/relay/unbind`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    });
    assert.equal(u.status, 204);
    assert.equal((await bind("w-unbind")).status, 200);
  });

  it("OPTIONS preflight", async () => {
    const resp = await fetch(`${base}/v1/relay/bind`, { method: "OPTIONS" });
    assert.equal(resp.status, 204);
    assert.equal(resp.headers.get("access-control-allow-origin"), "*");
    assert.ok((resp.headers.get("access-control-allow-headers") ?? "").includes("Authorization"));
  });
});

// ── Node-wide CORS (browser consumers, 2026-06-12) ───────────────────────────
// Web pages dispatch /v1/task to https nodes directly — every endpoint must
// answer preflights and carry CORS (fails if node-wide CORS is reverted).
describe("node-wide CORS", () => {
  let port: number;
  let stop: () => void;
  let base: string;

  before(async () => {
    port = await freePort();
    const node = new IicpNode({
      nodeId: "cors-node",
      endpoint: "http://cors.local",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "m",
      directoryUrl: "https://iicp.test",
    });
    stop = node.serve(async () => ({ result: { echo: true } }), { host: "127.0.0.1", port });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
      try { await fetch(`${base}/iicp/health`); break; }
      catch { await new Promise((r) => setTimeout(r, 50)); }
    }
  });

  after(() => stop());

  it("OPTIONS /v1/task preflight → 204 + CORS", async () => {
    const r = await fetch(`${base}/v1/task`, { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });

  it("/iicp/health carries CORS", async () => {
    const r = await fetch(`${base}/iicp/health`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });

  it("/v1/task response carries CORS", async () => {
    const r = await fetch(`${base}/v1/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: "t-cors", intent: "urn:iicp:intent:llm:chat:v1", payload: { messages: [] } }),
    });
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });
});

// ── Red-team F5: session-cap DoS protection (2026-06-12) ─────────────────────
describe("session cap (F5)", () => {
  it("atCapacity excludes rebind of an existing worker", async () => {
    const { RelaySessionRegistry, HttpPollWorkerSession } = await import("../src/relay_session.js");
    const reg = new RelaySessionRegistry(2);
    reg.bind("a", new HttpPollWorkerSession("a"));
    reg.bind("b", new HttpPollWorkerSession("b"));
    assert.equal(reg.count(), 2);
    assert.equal(reg.atCapacity("c"), true);  // new → capped
    assert.equal(reg.atCapacity("a"), false); // rebind → exempt
  });
});

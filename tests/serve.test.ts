/**
 * Integration tests for IicpNode server features.
 * Binds to a free OS port, exercises all endpoints, then shuts down.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { IicpNode } from "../src/node.js";
import type { NodeConfig } from "../src/node.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function waitPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => setTimeout(attempt, 50));
    };
    attempt();
  });
}

function jsonReq(
  method: string,
  port: number,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; body: unknown; headers: http.IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(data ? { "Content-Length": Buffer.byteLength(data).toString() } : {}),
      ...extraHeaders,
    };
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { parsed = Buffer.concat(chunks).toString(); }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── module-scoped node ────────────────────────────────────────────────────────

let cleanup: (() => void) | undefined;
let port: number;

const cfg: NodeConfig = {
  nodeId: "test-node",
  endpoint: "http://test.local",
  intent: "urn:iicp:intent:llm:chat:v1",
  region: "test-region",
  model: "test-model",
  maxConcurrent: 4,
};

describe("IicpNode server", () => {
  before(async () => {
    port = await freePort();
    const node = new IicpNode(cfg);
    cleanup = node.serve(
      async (task) => ({ echo: task.payload }),
      { host: "127.0.0.1", port }
    );
    await waitPort(port);
  });

  after(() => cleanup?.());

  // ── GET /iicp/health ────────────────────────────────────────────────────────

  it("health returns 200 with required fields", async () => {
    const { status, body } = await jsonReq("GET", port, "/iicp/health");
    assert.equal(status, 200);
    const b = body as Record<string, unknown>;
    assert.equal(b.status, "ok");
    assert.equal(b.node_id, "test-node");
    assert.equal(b.region, "test-region");
    assert.equal(b.max_concurrent, 4);
    assert.equal(typeof b.active_jobs, "number");
    assert.equal(typeof b.available, "boolean");
    assert.equal(typeof b.load, "number");
  });

  it("unknown GET path → 404", async () => {
    const { status } = await jsonReq("GET", port, "/nope");
    assert.equal(status, 404);
  });

  // ── GET /metrics ────────────────────────────────────────────────────────────

  it("metrics endpoint returns 200 or 503", async () => {
    const { status } = await jsonReq("GET", port, "/metrics");
    assert.ok([200, 503].includes(status));
  });

  // ── POST /v1/task ───────────────────────────────────────────────────────────

  it("task returns 200 with status=completed", async () => {
    const { status, body } = await jsonReq("POST", port, "/v1/task", {
      task_id: "t-001",
      intent: "x",
      payload: { msg: "hi" },
    });
    assert.equal(status, 200);
    const b = body as Record<string, unknown>;
    assert.equal(b.status, "completed");
    assert.equal(b.task_id, "t-001");
  });

  // ── Concurrency gate (IICP-E021) ────────────────────────────────────────────

  it("concurrency gate → 429 IICP-E021 with Retry-After: 2", async () => {
    const gPort = await freePort();
    const gNode = new IicpNode({ ...cfg, nodeId: "gate-node", maxConcurrent: 0 });
    const gCleanup = gNode.serve(async () => ({}), { host: "127.0.0.1", port: gPort });
    await waitPort(gPort);

    const { status, body, headers } = await jsonReq("POST", gPort, "/v1/task", {
      task_id: "t",
      intent: "x",
      payload: {},
    });
    gCleanup();

    assert.equal(status, 429);
    assert.equal((body as Record<string, unknown>)?.error?.["code"], "IICP-E021");
    assert.equal(headers["retry-after"], "2");
  });

  // ── Nonce replay (IICP-E011) ────────────────────────────────────────────────

  it("duplicate nonce → 409 IICP-E011", async () => {
    const nonce = "nonce-ts-replay-test";
    const r1 = await jsonReq("POST", port, "/v1/task", {
      task_id: "t1", intent: "x", payload: {}, nonce,
    });
    const r2 = await jsonReq("POST", port, "/v1/task", {
      task_id: "t2", intent: "x", payload: {}, nonce,
    });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 409);
    assert.equal((r2.body as Record<string, unknown>)?.error?.["code"], "IICP-E011");
  });

  // ── W3C traceparent propagation ─────────────────────────────────────────────

  it("traceparent header is propagated to handler._trace", async () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    let captured: Record<string, unknown> = {};

    const tPort = await freePort();
    const tNode = new IicpNode({ ...cfg, nodeId: "trace-node" });
    const tCleanup = tNode.serve(
      async (task) => { captured = task; return {}; },
      { host: "127.0.0.1", port: tPort }
    );
    await waitPort(tPort);

    await jsonReq("POST", tPort, "/v1/task", { task_id: "t1", intent: "x", payload: {} }, {
      traceparent: tp,
    });

    // Small delay to let the async handler complete
    await new Promise((r) => setTimeout(r, 50));
    tCleanup();

    assert.equal((captured._trace as Record<string, unknown>)?.traceparent, tp);
  });
});

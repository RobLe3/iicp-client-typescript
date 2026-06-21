/**
 * Integration tests for IicpNode server features — ADR-016 §2/§3.
 * Conformance: SDK-03 (node serve), SDK-05 (error codes), SDK-06 (traceparent).
 * Binds to a free OS port, exercises all endpoints, then shuts down.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IicpNode } from "../src/node.js";
import type { NodeConfig } from "../src/node.js";
import { encryptPayload, loadOrCreateNodeCxKey } from "../src/confidentiality.js";

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

  it("health returns 200 with required fields including pinhole_state", async () => {
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
    // #343 — pinhole_state always surfaced (active: false when no pinhole opened)
    const ps = b.pinhole_state as Record<string, unknown>;
    assert.equal(typeof ps, "object");
    assert.equal(ps.active, false);
  });

  it("#494 health endpoint exposes models[] containing the primary model", async () => {
    const { body } = await jsonReq("GET", port, "/iicp/health");
    const b = body as Record<string, unknown>;
    assert.ok(Array.isArray(b.models), "/iicp/health must include models[] array");
    assert.ok((b.models as string[]).includes("test-model"), "primary model must appear in models[]");
  });

  it("#494 health endpoint models[] includes capabilities", async () => {
    const p2 = await freePort();
    const node2 = new IicpNode({
      nodeId: "multi-node",
      endpoint: "http://multi.local",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "primary-model",
      capabilities: ["extra-model"],
    });
    const cleanup2 = node2.serve(async () => ({}), { host: "127.0.0.1", port: p2 });
    await waitPort(p2);
    try {
      const { body } = await jsonReq("GET", p2, "/iicp/health");
      const models = (body as Record<string, unknown>).models as string[];
      assert.ok(models.includes("primary-model"), "primary model must be in models[]");
      assert.ok(models.includes("extra-model"), "capability must be in models[]");
    } finally {
      cleanup2();
    }
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

  it("decrypts iicp_conf before invoking the task handler", async () => {
    const oldCxDir = process.env.IICP_CX_KEY_DIR;
    const cxDir = mkdtempSync(join(tmpdir(), "iicp-cx-"));
    process.env.IICP_CX_KEY_DIR = cxDir;
    const cxPort = await freePort();
    const nodeId = "cx-server";
    const endpoint = "http://cx.local";
    const cx = loadOrCreateNodeCxKey(nodeId, endpoint);
    let captured: Record<string, unknown> = {};
    const cxNode = new IicpNode({ ...cfg, nodeId, endpoint });
    const cxCleanup = cxNode.serve(async (task) => {
      captured = task;
      return { result: { payload: task.payload } };
    }, { host: "127.0.0.1", port: cxPort });
    try {
      await waitPort(cxPort);
      const payload = { messages: [{ role: "user", content: "secret" }] };
      const env = encryptPayload(payload, cx.publicKey, "cx-ts-1", cfg.intent);
      const { status, body } = await jsonReq("POST", cxPort, "/v1/task", {
        task_id: "cx-ts-1",
        intent: cfg.intent,
        iicp_conf: env,
      });
      assert.equal(status, 200);
      assert.equal((body as Record<string, unknown>).status, "completed");
      assert.deepEqual(captured.payload, payload);
      assert.equal(captured._cx_encrypted, true);
    } finally {
      cxCleanup();
      if (oldCxDir === undefined) delete process.env.IICP_CX_KEY_DIR;
      else process.env.IICP_CX_KEY_DIR = oldCxDir;
      rmSync(cxDir, { recursive: true, force: true });
    }
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

// #404 — heartbeat self-heal: a tick on an empty/invalid token re-registers
describe("heartbeat self-heal (#404)", () => {
  function cfg(): NodeConfig {
    return {
      nodeId: "t",
      endpoint: "http://t.local",
      intent: "urn:iicp:intent:llm:chat:v1",
      region: "r",
      model: "m",
      maxConcurrent: 1,
    } as NodeConfig;
  }

  it("re-registers when a heartbeat tick is rejected with 401 (empty startup token)", async () => {
    const node = new IicpNode(cfg());
    let hbCalls = 0;
    let regCalls = 0;
    // empty token → directory rejects with 401
    (node as unknown as { heartbeat: (t: string) => Promise<void> }).heartbeat = async (t: string) => {
      hbCalls++;
      if (t === "") throw Object.assign(new Error("Heartbeat failed: 401"), { status: 401 });
    };
    (node as unknown as { register: () => Promise<string> }).register = async () => {
      regCalls++;
      return "recovered-token";
    };
    const next = await (node as unknown as { _heartbeatTick: (t: string) => Promise<string> })._heartbeatTick("");
    assert.equal(regCalls, 1, "empty-token tick must re-register on 401");
    assert.equal(next, "recovered-token", "tick must return the recovered token for the next tick");
    assert.equal(hbCalls, 1);
  });

  it("keeps the same token on a healthy tick", async () => {
    const node = new IicpNode(cfg());
    (node as unknown as { heartbeat: (t: string) => Promise<void> }).heartbeat = async () => undefined;
    let regCalls = 0;
    (node as unknown as { register: () => Promise<string> }).register = async () => {
      regCalls++;
      return "x";
    };
    const next = await (node as unknown as { _heartbeatTick: (t: string) => Promise<string> })._heartbeatTick("good-token");
    assert.equal(next, "good-token");
    assert.equal(regCalls, 0, "healthy tick must not re-register");
  });

  // The heartbeat body MUST carry an explicit `available: true` boolean (not only the
  // `status: "available"` string). The directory keys discover eligibility off the
  // `available` field, so sending it restores a briefly-dormant node on the next beat —
  // robust even against directory builds older than v1.10.17.

  it("includes avg_latency_ms when task counters are present", async () => {
    let captured: Record<string, unknown> | null = null;
    const dir = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const port = await freePort();
    await new Promise<void>((r) => dir.listen(port, "127.0.0.1", () => r()));
    try {
      const node = new IicpNode({ ...cfg(), directoryUrl: `http://127.0.0.1:${port}` } as NodeConfig);
      (node as unknown as { _tasksSuccessPending: number })._tasksSuccessPending = 1;
      (node as unknown as { _tasksFailedPending: number })._tasksFailedPending = 1;
      (node as unknown as { _tasksLatencyTotalMsPending: number })._tasksLatencyTotalMsPending = 300;
      await (node as unknown as { heartbeat: (t: string) => Promise<void> }).heartbeat("tok");
      const metrics = (captured as { metrics?: Record<string, number> }).metrics;
      assert.equal(metrics?.avg_latency_ms, 150);
    } finally {
      await new Promise<void>((r) => dir.close(() => r()));
    }
  });

  it("sends available:true in the heartbeat body", async () => {
    let captured: Record<string, unknown> | null = null;
    const dir = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const port = await freePort();
    await new Promise<void>((r) => dir.listen(port, "127.0.0.1", () => r()));
    try {
      const node = new IicpNode({ ...cfg(), directoryUrl: `http://127.0.0.1:${port}` } as NodeConfig);
      await (node as unknown as { heartbeat: (t: string) => Promise<void> }).heartbeat("tok");
      assert.ok(captured, "directory must have received a heartbeat");
      assert.equal((captured as Record<string, unknown>).available, true);
      assert.equal((captured as Record<string, unknown>).status, "available");
    } finally {
      await new Promise<void>((r) => dir.close(() => r()));
    }
  });
});

// ── #494 — health_models heartbeat reporting ─────────────────────────────────

describe("health_models heartbeat reporting (#494)", () => {
  function cfg(): NodeConfig {
    return {
      nodeId: "hm-ts-test",
      endpoint: "http://127.0.0.1:9999",
      intent: "urn:iicp:intent:llm:chat:v1",
      directoryUrl: "http://localhost:8888",
    } as NodeConfig;
  }

  it("includes health_models in heartbeat when probe returns models", async () => {
    let captured: Record<string, unknown> | null = null;
    const dir = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const port = await freePort();
    await new Promise<void>((r) => dir.listen(port, "127.0.0.1", () => r()));
    try {
      const node = new IicpNode({
        ...cfg(),
        directoryUrl: `http://127.0.0.1:${port}`,
        backendUrl: "http://localhost:11434",
      } as NodeConfig);
      // Inject a stub for _probeHealthModels
      (node as unknown as { _probeHealthModels: () => Promise<string[] | null> })._probeHealthModels =
        async () => ["llama3:latest", "qwen2.5:0.5b"];
      await (node as unknown as { heartbeat: (t: string) => Promise<void> }).heartbeat("tok");
      assert.ok(captured, "heartbeat payload must have been received");
      assert.deepEqual(
        (captured as Record<string, unknown>).health_models,
        ["llama3:latest", "qwen2.5:0.5b"],
        "health_models must appear in heartbeat when probe succeeds",
      );
    } finally {
      await new Promise<void>((r) => dir.close(() => r()));
    }
  });

  it("sends health_models=[] when probe returns empty list", async () => {
    let captured: Record<string, unknown> | null = null;
    const dir = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const port = await freePort();
    await new Promise<void>((r) => dir.listen(port, "127.0.0.1", () => r()));
    try {
      const node = new IicpNode({
        ...cfg(),
        directoryUrl: `http://127.0.0.1:${port}`,
        backendUrl: "http://localhost:11434",
      } as NodeConfig);
      (node as unknown as { _probeHealthModels: () => Promise<string[] | null> })._probeHealthModels =
        async () => [];
      await (node as unknown as { heartbeat: (t: string) => Promise<void> }).heartbeat("tok");
      assert.ok(captured, "heartbeat payload must have been received");
      assert.deepEqual(
        (captured as Record<string, unknown>).health_models,
        [],
        "health_models=[] must be sent when backend reports no models",
      );
    } finally {
      await new Promise<void>((r) => dir.close(() => r()));
    }
  });

  it("omits health_models when no backendUrl is configured", async () => {
    let captured: Record<string, unknown> | null = null;
    const dir = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        captured = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const port = await freePort();
    await new Promise<void>((r) => dir.listen(port, "127.0.0.1", () => r()));
    try {
      const node = new IicpNode({
        ...cfg(),
        directoryUrl: `http://127.0.0.1:${port}`,
        // No backendUrl
      } as NodeConfig);
      await (node as unknown as { heartbeat: (t: string) => Promise<void> }).heartbeat("tok");
      assert.ok(captured, "heartbeat payload must have been received");
      assert.ok(
        !Object.hasOwn(captured as Record<string, unknown>, "health_models"),
        "health_models must be absent when no backendUrl is set",
      );
    } finally {
      await new Promise<void>((r) => dir.close(() => r()));
    }
  });
});

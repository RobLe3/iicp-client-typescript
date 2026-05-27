/**
 * Unit tests for cip_policy — S.12 §2.2 worker-role gate. TS port of the
 * Python tests/test_cip_policy.py matrix.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  CooperativeInferencePolicy,
  configureCipPolicy,
  getCipPolicy,
} from "../src/cip_policy.js";
import { IicpNode } from "../src/node.js";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  configureCipPolicy(); // reset module-level policy so tests don't leak
});

function mockFetch(
  handler: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>
) {
  globalThis.fetch = handler as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CooperativeInferencePolicy gate predicates", () => {
  it("default is all off", () => {
    const p = new CooperativeInferencePolicy();
    assert.equal(p.enabled, false);
    assert.equal(p.allowCoordinator, false);
    assert.equal(p.allowWorker, false);
    assert.equal(p.checkCoordinator(), false);
    assert.equal(p.checkWorker(), false);
  });

  it("enabled alone does not open gates", () => {
    const p = new CooperativeInferencePolicy({ enabled: true });
    assert.equal(p.checkCoordinator(), false);
    assert.equal(p.checkWorker(), false);
  });

  it("role flag alone does not open gates", () => {
    const p = new CooperativeInferencePolicy({
      allowCoordinator: true,
      allowWorker: true,
    });
    assert.equal(p.checkCoordinator(), false);
    assert.equal(p.checkWorker(), false);
  });

  it("enabled + coordinator opens coordinator only", () => {
    const p = new CooperativeInferencePolicy({ enabled: true, allowCoordinator: true });
    assert.equal(p.checkCoordinator(), true);
    assert.equal(p.checkWorker(), false);
  });

  it("enabled + worker opens worker only", () => {
    const p = new CooperativeInferencePolicy({ enabled: true, allowWorker: true });
    assert.equal(p.checkCoordinator(), false);
    assert.equal(p.checkWorker(), true);
  });
});

describe("CooperativeInferencePolicy capacity gate", () => {
  it("max_concurrent_remote lower bound enforced", () => {
    const p = new CooperativeInferencePolicy({ maxConcurrentRemote: 0 });
    assert.equal(p.maxConcurrentRemote, 1);
  });
  it("max_worker_timeout_ms upper bound enforced", () => {
    const p = new CooperativeInferencePolicy({ maxWorkerTimeoutMs: 999_999 });
    assert.equal(p.maxWorkerTimeoutMs, 60_000);
  });
  it("slot acquire and release", () => {
    const p = new CooperativeInferencePolicy({ maxConcurrentRemote: 2 });
    assert.equal(p.tryAcquireCipSlot(), true);
    assert.equal(p.tryAcquireCipSlot(), true);
    // Capacity reached → next acquire fails (S.12 §2.2)
    assert.equal(p.tryAcquireCipSlot(), false);
    p.releaseCipSlot();
    assert.equal(p.tryAcquireCipSlot(), true);
  });
});

describe("CIP register payload integration", () => {
  it("CIP disabled emits no policy block", async () => {
    let captured: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok", node_id: "n" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n",
      endpoint: "https://provider.example:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "q",
      directoryUrl: "https://iicp.test",
      cipPolicy: new CooperativeInferencePolicy(), // default OFF
    });
    await node.register();
    assert.ok(captured);
    assert.equal((captured as Record<string, unknown>).policy, undefined);
  });

  it("CIP worker enabled emits allow_remote_inference=true", async () => {
    let captured: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok", node_id: "n" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n",
      endpoint: "https://provider.example:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "q",
      directoryUrl: "https://iicp.test",
      cipPolicy: new CooperativeInferencePolicy({ enabled: true, allowWorker: true }),
    });
    await node.register();
    assert.ok(captured);
    const policy = (captured as Record<string, unknown>).policy as Record<string, unknown>;
    assert.equal(policy.allow_remote_inference, true);
  });

  it("module-level policy used when NodeConfig.cipPolicy unset", async () => {
    configureCipPolicy({ enabled: true, allowWorker: true });
    let captured: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok", node_id: "n" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n",
      endpoint: "https://provider.example:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "q",
      directoryUrl: "https://iicp.test",
    });
    await node.register();
    const policy = (captured as Record<string, unknown>).policy as Record<string, unknown>;
    assert.equal(policy.allow_remote_inference, true);
  });
});

describe("module-level cip_policy state", () => {
  it("getCipPolicy returns default when unconfigured", () => {
    configureCipPolicy();
    const p = getCipPolicy();
    assert.equal(p.enabled, false);
    assert.equal(p.allowWorker, false);
  });
  it("configureCipPolicy replaces global", () => {
    configureCipPolicy({ enabled: true, allowWorker: true, maxConcurrentRemote: 5 });
    const p = getCipPolicy();
    assert.equal(p.enabled, true);
    assert.equal(p.allowWorker, true);
    assert.equal(p.maxConcurrentRemote, 5);
  });
});

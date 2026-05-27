/**
 * Unit tests for the 4 CONF self-conformance probes. TS port of the Python
 * test_conformance matrix using fetch monkey-patching.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runConformanceChecks } from "../src/conformance.js";
import { IicpNode } from "../src/node.js";

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Match a URL by prefix → return the response from the handler. */
type Route = { matches: (url: string) => boolean; handler: (url: string) => Response | Promise<Response> };

function routedFetch(routes: Route[]): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = url.toString();
    for (const r of routes) {
      if (r.matches(u)) return r.handler(u);
    }
    throw new Error(`unmocked fetch: ${u}`);
  }) as typeof fetch;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeNode(overrides: Record<string, unknown> = {}) {
  return new IicpNode({
    nodeId: "n-test",
    endpoint: "https://node.iicpnet.test-host.org:8080",
    intent: "urn:iicp:intent:llm:chat:v1",
    directoryUrl: "https://iicp.test/api",
    model: "m",
    ...overrides,
  });
}

// ── CONF-REG-01 ────────────────────────────────────────────────────────────

describe("CONF-REG-01 registration probe", () => {
  it("passes when node_id + token both set", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n-test",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:true})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999, { nodeToken: "tok" });
    const reg = r.tests.find((t) => t.testId === "CONF-REG-01")!;
    assert.equal(reg.passed, true);
    assert.match(reg.message, /Registered/);
  });

  it("passes with node_id only when token not tracked", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n-test",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:true})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999);
    const reg = r.tests.find((t) => t.testId === "CONF-REG-01")!;
    assert.equal(reg.passed, true);
    assert.match(reg.message, /not tracked/);
  });

  it("fails when node_id is empty", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:true})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[]})},
    ]);
    const r = await runConformanceChecks(makeNode({ nodeId: "" }), 9999);
    const reg = r.tests.find((t) => t.testId === "CONF-REG-01")!;
    assert.equal(reg.passed, false);
  });
});

// ── CONF-HEALTH-01 ─────────────────────────────────────────────────────────

describe("CONF-HEALTH-01 health-schema probe", () => {
  it("passes with complete schema", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:true})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999);
    const h = r.tests.find((t) => t.testId === "CONF-HEALTH-01")!;
    assert.equal(h.passed, true, h.message);
  });

  it("fails when required field missing", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n",region:"eu",load:0.1})},  // missing 'models'
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:true})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999);
    const h = r.tests.find((t) => t.testId === "CONF-HEALTH-01")!;
    assert.equal(h.passed, false);
    assert.match(h.message, /models/);
  });

  it("fails on HTTP 500", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => new Response("oops", {status:500})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:true})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999);
    const h = r.tests.find((t) => t.testId === "CONF-HEALTH-01")!;
    assert.equal(h.passed, false);
    assert.match(h.message, /500/);
  });
});

// ── CONF-REACH-01 ──────────────────────────────────────────────────────────

describe("CONF-REACH-01 reachability probe", () => {
  it("skips for non-routable endpoint", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode({ endpoint: "http://localhost:8080" }), 9999);
    const reach = r.tests.find((t) => t.testId === "CONF-REACH-01")!;
    assert.equal(reach.passed, false);
    assert.match(reach.message, /non-routable/);
  });

  it("passes when directory probe reports reachable", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:true})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999);
    const reach = r.tests.find((t) => t.testId === "CONF-REACH-01")!;
    assert.equal(reach.passed, true);
  });

  it("fails when directory probe reports unreachable", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:false,error:"timeout"})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999);
    const reach = r.tests.find((t) => t.testId === "CONF-REACH-01")!;
    assert.equal(reach.passed, false);
    assert.match(reach.message, /timeout/);
  });
});

// ── CONF-DISC-01 ───────────────────────────────────────────────────────────

describe("CONF-DISC-01 discover-self probe", () => {
  it("passes when node_id appears in NODELIST", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:true})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"other"},{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999);
    const disc = r.tests.find((t) => t.testId === "CONF-DISC-01")!;
    assert.equal(disc.passed, true);
    assert.match(disc.message, /Found/);
  });

  it("fails when node_id is absent from NODELIST", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:true})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"other"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999);
    const disc = r.tests.find((t) => t.testId === "CONF-DISC-01")!;
    assert.equal(disc.passed, false);
    assert.match(disc.message, /absent/);
  });
});

// ── Orchestrator ───────────────────────────────────────────────────────────

describe("runConformanceChecks orchestrator", () => {
  it("runs all four and produces a report with timestamps", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:true})},
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999, { nodeToken: "tok" });
    assert.equal(r.passCount, 4);
    assert.equal(r.failCount, 0);
    assert.equal(new Set(r.tests.map((t) => t.testId)).size, 4);
    // ISO timestamp parses
    assert.ok(!isNaN(Date.parse(r.lastRunAt)));
  });

  it("counts mixed pass/fail correctly", async () => {
    routedFetch([
      { matches: (u) => u.endsWith("/iicp/health"), handler: () => jsonResponse({status:"ok",node_id:"n",region:"eu",load:0.1,models:["m"]})},
      { matches: (u) => u.includes("/v1/probe"), handler: () => jsonResponse({reachable:false,error:"timeout"})},  // FAIL
      { matches: (u) => u.includes("/v1/discover"), handler: () => jsonResponse({nodes:[{node_id:"n-test"}]})},
    ]);
    const r = await runConformanceChecks(makeNode(), 9999, { nodeToken: "tok" });
    assert.equal(r.passCount, 3);
    assert.equal(r.failCount, 1);
  });
});

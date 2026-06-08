/**
 * IICP TypeScript SDK tests — SDK-01..SDK-06 conformance (ADR-016 §5)
 * Runs with: node --loader tsx/esm --test tests/client.test.ts
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { IicpClient } from "../src/client.js";
import { IicpError } from "../src/errors.js";
import { IicpNode } from "../src/node.js";

// Helper: mock globalThis.fetch for a test
function mockFetch(handler: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof handler }).fetch = handler;
  return () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// SDK-04: construction rejects timeout_ms > 120000
describe("IicpClient construction", () => {
  it("accepts valid config", () => {
    const client = new IicpClient({ directory_url: "https://example.com", timeout_ms: 5000 });
    assert.ok(client instanceof IicpClient);
  });

  it("SDK-04: rejects timeout_ms > 120000", () => {
    assert.throws(
      () => new IicpClient({ timeout_ms: 200_000 }),
      (err: unknown) => {
        assert.ok(err instanceof IicpError);
        assert.equal(err.code, "SDK-04");
        return true;
      },
    );
  });

  it("uses default config when none provided", () => {
    const client = new IicpClient();
    assert.ok(client instanceof IicpClient);
  });
});

// SDK-02: intent validation
describe("intent validation", () => {
  it("SDK-02: rejects non-URN intent in submit", async () => {
    const client = new IicpClient();
    await assert.rejects(
      () => client.submit({ intent: "not-a-urn", payload: {} }),
      (err: unknown) => {
        assert.ok(err instanceof IicpError);
        assert.equal(err.code, "SDK-02");
        return true;
      },
    );
  });

  it("SDK-02: rejects intent without urn:iicp:intent: prefix", async () => {
    const client = new IicpClient();
    await assert.rejects(
      () => client.submit({ intent: "urn:ietf:params:acme:something", payload: {} }),
      (err: unknown) => {
        assert.ok(err instanceof IicpError);
        assert.equal(err.code, "SDK-02");
        return true;
      },
    );
  });

  it("SDK-02: valid intent URN is not rejected by intent check", async () => {
    const restore = mockFetch((url) => {
      const u = url.toString();
      if (u.includes("discover")) {
        return jsonResponse({
          nodes: [{ node_id: "abc", endpoint: "http://1.2.3.4:8080", score: 0.9, available: true, region: "eu" }],
        });
      }
      // Chat node endpoint returns 503 — causes an error, but NOT SDK-02
      return new Response("unavailable", { status: 503 });
    });
    const client = new IicpClient({ directory_url: "http://fake.test" });
    await assert.rejects(
      () => client.chat([{ role: "user", content: "hi" }], {
        intent: "urn:iicp:intent:llm:chat:v1",
      }),
      (err: unknown) => {
        // Must fail for a reason OTHER than SDK-02 (intent validation)
        assert.ok(err instanceof IicpError);
        assert.notEqual(err.code, "SDK-02");
        return true;
      },
    );
    restore();
  });
});

// SDK-03: discover returns nodes
describe("discover", () => {
  it("SDK-03: returns parsed nodes from directory", async () => {
    const restore = mockFetch((url) => {
      const u = url.toString();
      if (u.includes("/v1/discover")) {
        return jsonResponse({
          nodes: [
            { node_id: "n1", endpoint: "https://1.2.3.4:9484", score: 0.95, available: true, region: "eu", health_label: "healthy", exposure_mode: "ipv4_public_direct", transport: ["https", "iicp-native"] },
            { node_id: "n2", endpoint: "https://1.2.3.5:9484", score: 0.80, available: true, region: "us" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const client = new IicpClient({ directory_url: "https://fake-dir.test" });
    const nodes = await client.discover("urn:iicp:intent:llm:chat:v1");
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].node_id, "n1");
    assert.equal(nodes[0].score, 0.95);
    assert.equal(nodes[0].region, "eu");
    // ADR-044 — health_label + exposure_mode parsed (directory v1.10.0+)
    assert.equal(nodes[0].health_label, "healthy");
    assert.equal(nodes[0].exposure_mode, "ipv4_public_direct");
    // #397 — transport parsed from discover
    assert.deepEqual(nodes[0].transport, ["https", "iicp-native"]);
    // absent against older directory → undefined, no break
    assert.equal(nodes[1].health_label, undefined);
    restore();
  });

  it("SDK-03: returns empty array when no nodes available", async () => {
    const restore = mockFetch(() => jsonResponse({ nodes: [] }));
    const client = new IicpClient({ directory_url: "https://fake-dir.test" });
    const nodes = await client.discover("urn:iicp:intent:llm:chat:v1");
    assert.equal(nodes.length, 0);
    restore();
  });

  it("SDK-03: throws IicpError when directory returns 500", async () => {
    const restore = mockFetch(() => new Response("error", { status: 500 }));
    const client = new IicpClient({ directory_url: "https://fake-dir.test" });
    await assert.rejects(
      () => client.discover("urn:iicp:intent:llm:chat:v1"),
      (err: unknown) => {
        assert.ok(err instanceof IicpError);
        assert.equal(err.status_code, 500);
        return true;
      },
    );
    restore();
  });
});

// SDK-05 / SDK-06: IicpError has code always
describe("IicpError", () => {
  it("SDK-05: IicpError is instance of Error", () => {
    const err = new IicpError("something went wrong", "SDK-05");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof IicpError);
  });

  it("SDK-06: error code is always set", () => {
    const err = new IicpError("test", "SDK-TEST");
    assert.equal(err.code, "SDK-TEST");
    assert.ok(err.code.length > 0);
  });

  it("SDK-06: error includes status_code when present", () => {
    const err = new IicpError("http error", "SDK-05", { status_code: 429 });
    assert.equal(err.status_code, 429);
  });

  it("component defaults to sdk", () => {
    const err = new IicpError("test", "SDK-01");
    assert.equal(err.component, "sdk");
  });

  it("component can be overridden", () => {
    const err = new IicpError("test", "SDK-05", { component: "directory" });
    assert.equal(err.component, "directory");
  });
});

// SDK-01: submit throws IicpError when no nodes (after discover)
describe("submit", () => {
  it("SDK-01: throws when no nodes available for intent", async () => {
    const restore = mockFetch(() => jsonResponse({ nodes: [] }));
    const client = new IicpClient({ directory_url: "https://fake-dir.test" });
    await assert.rejects(
      () => client.submit({ intent: "urn:iicp:intent:llm:chat:v1", payload: { msg: "hi" } }),
      (err: unknown) => {
        assert.ok(err instanceof IicpError);
        assert.equal(err.code, "SDK-03");
        return true;
      },
    );
    restore();
  });

  it("SDK-01: submit forwards auth token in Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {};
    const restore = mockFetch((url, init) => {
      const u = url.toString();
      if (u.includes("discover")) {
        return jsonResponse({ nodes: [{ node_id: "n1", endpoint: "http://1.2.3.4:8080", score: 1, available: true, region: "eu" }] });
      }
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse({ task_id: "t1", result: {}, status: "ok" });
    });

    const client = new IicpClient({ directory_url: "http://fake.test" });
    await client.submit({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: {},
      auth: { token: "secret-node-token" },
    });

    assert.equal(capturedHeaders["authorization"], "Bearer secret-node-token");
    restore();
  });
});

// SDK-06: W3C traceparent propagation
describe("SDK-06 traceparent", () => {
  it("discover sends a valid traceparent header", async () => {
    let capturedHeaders: Record<string, string> = {};
    const restore = mockFetch((_url, init) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse({ nodes: [] });
    });
    const client = new IicpClient({ directory_url: "http://fake.test" });
    await client.discover("urn:iicp:intent:llm:chat:v1");
    const tp = capturedHeaders["traceparent"] ?? "";
    const parts = tp.split("-");
    assert.equal(parts.length, 4, `bad traceparent: ${tp}`);
    assert.equal(parts[0], "00");
    assert.equal(parts[1].length, 32);
    assert.equal(parts[2].length, 16);
    assert.equal(parts[3], "01");
    restore();
  });

  it("iter-1412: node.register sends spec-compliant payload (capabilities array of objects)", async () => {
    let captured: Record<string, unknown> | null = null;
    const restore = mockFetch((_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok-1", node_id: "n-1" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n-1",
      endpoint: "https://provider.example.com:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "llama-3-8b",
      region: "eu-central",
      directoryUrl: "https://iicp.test",
      maxConcurrent: 2,
      tokensPerMin: 2000,
      maxTokens: 8192,
    });
    await node.register();
    restore();
    assert.ok(captured, "no register payload captured");
    const body = captured as Record<string, unknown>;
    assert.equal(body.endpoint, "https://provider.example.com:8080");
    assert.equal(body.region, "eu-central");
    assert.deepEqual(body.limits, { max_concurrent: 2, tokens_per_min: 2000 });
    assert.deepEqual(body.capabilities, [{
      intent: "urn:iicp:intent:llm:chat:v1",
      models: ["llama-3-8b"],
      max_tokens: 8192,
      // #408/ADR-046 — capability declares input modalities (text-only here).
      input_modalities: ["text"],
    }]);
    assert.equal(body.transport_endpoint, undefined, "transport_endpoint should be absent when not configured");
    assert.equal(body.intent, undefined, "flat intent must NOT appear at top level (spec violation)");
  });

  it("#414: register includes the detected backend flavor when set", async () => {
    let captured: Record<string, unknown> | null = null;
    const restore = mockFetch((_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok-1", node_id: "n-b" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n-b",
      endpoint: "https://provider.example.com:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "llama-3-8b",
      backend: "ollama",
      directoryUrl: "https://iicp.test",
    });
    await node.register();
    restore();
    assert.equal((captured as Record<string, unknown>).backend, "ollama");
  });

  it("#407 ADR-045: register attaches operator_delegation when configured", async () => {
    const { issueDelegation, generateOperatorKey, verifyDelegation } = await import("../src/delegation.js");
    const delegation = issueDelegation(generateOperatorKey(), "n-1", 3600);
    assert.ok(verifyDelegation(delegation, "n-1"));

    let captured: Record<string, unknown> | null = null;
    const restore = mockFetch((_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok-1", node_id: "n-1" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n-1",
      endpoint: "https://provider.example.com:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "llama-3-8b",
      directoryUrl: "https://iicp.test",
      operatorDelegation: delegation,
    });
    await node.register();
    restore();
    assert.deepEqual((captured as Record<string, unknown>).operator_delegation, delegation);
  });

  it("#407: register omits operator_delegation when not configured", async () => {
    let captured: Record<string, unknown> | null = null;
    const restore = mockFetch((_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "t", node_id: "n-2" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n-2",
      endpoint: "https://p.example.com:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "m",
      directoryUrl: "https://iicp.test",
    });
    await node.register();
    restore();
    assert.equal((captured as Record<string, unknown>).operator_delegation, undefined);
  });

  it("#411 ADR-047: heartbeat answers the liveness challenge", async () => {
    const { createHmac } = await import("node:crypto");
    const bodies: Record<string, unknown>[] = [];
    const restore = mockFetch((_url, init) => {
      bodies.push(JSON.parse(init?.body as string));
      return jsonResponse({ ok: true, challenge: "nonce-abc" }, 200);
    });
    const node = new IicpNode({
      nodeId: "n-1",
      endpoint: "https://p.example.com:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "m",
      directoryUrl: "https://iicp.test",
      nodeHmacKey: "secret-key",
    });
    await node.heartbeat("tok"); // beat 1 → captures nonce, no answer
    await node.heartbeat("tok"); // beat 2 → answers
    restore();
    assert.equal(bodies[0].challenge_response, undefined);
    const expected = createHmac("sha256", "secret-key").update("nonce-abc").digest("hex");
    assert.equal(bodies[1].challenge_response, expected);
  });

  it("iter-1412: node.register includes transport_endpoint when configured (spec v0.7.0)", async () => {
    let captured: Record<string, unknown> | null = null;
    const restore = mockFetch((_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok-2", node_id: "n-2" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n-2",
      endpoint: "https://provider.example.com:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "qwen2.5:0.5b",
      directoryUrl: "https://iicp.test",
      transportEndpoint: "iicp://provider.example.com:9484",
    });
    await node.register();
    restore();
    assert.ok(captured);
    assert.equal((captured as Record<string, unknown>).transport_endpoint, "iicp://provider.example.com:9484");
  });

  it("iter-1412: node.register folds legacy capabilities[] into models array", async () => {
    let captured: Record<string, unknown> | null = null;
    const restore = mockFetch((_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok-3", node_id: "n-3" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n-3",
      endpoint: "https://provider.example.com:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "llama-3-8b",
      capabilities: ["mistral-7b", "phi-3-mini"],
      directoryUrl: "https://iicp.test",
    });
    await node.register();
    restore();
    assert.ok(captured);
    const caps = (captured as Record<string, unknown>).capabilities as Array<{ models: string[] }>;
    const models = caps[0].models.sort();
    assert.deepEqual(models, ["llama-3-8b", "mistral-7b", "phi-3-mini"]);
  });

  it("iter-1427: node.register includes NAT observability when set on NodeConfig", async () => {
    let captured: Record<string, unknown> | null = null;
    const restore = mockFetch((_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok-nat", node_id: "n-nat" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n-nat",
      endpoint: "https://provider.example.com:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "qwen2.5:0.5b",
      directoryUrl: "https://iicp.test",
      transportEndpoint: "iicp://provider.example.com:9484",
      transportMethod: "upnp_mapped",
      natType: "full_cone",
      transportMetadata: { tier: 1, detection_log_tail: ["upnp ok"] },
    });
    await node.register();
    restore();
    assert.ok(captured);
    const body = captured as Record<string, unknown>;
    assert.equal(body.transport_method, "upnp_mapped");
    assert.equal(body.nat_type, "full_cone");
    assert.deepEqual(body.transport_metadata, { tier: 1, detection_log_tail: ["upnp ok"] });
  });

  it("iter-1427: applyNatProfile populates fields + overrides endpoint when reachable", async () => {
    let captured: Record<string, unknown> | null = null;
    const restore = mockFetch((_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok-applied", node_id: "n-applied" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n-applied",
      endpoint: "http://placeholder.example.com:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "q",
      directoryUrl: "https://iicp.test",
    });
    node.applyNatProfile({
      tier: 1,
      transportMethod: "upnp_mapped",
      publicEndpoint: "http://203.0.113.5:8080",
      transportEndpoint: "iicp://203.0.113.5:9484",
      detectionLog: ["tier-1: UPnP mapped 8080"],
      isReachable() {
        return true;
      },
    });
    await node.register();
    restore();
    assert.ok(captured);
    const body = captured as Record<string, unknown>;
    assert.equal(body.endpoint, "http://203.0.113.5:8080");
    assert.equal(body.transport_endpoint, "iicp://203.0.113.5:9484");
    assert.equal(body.transport_method, "upnp_mapped");
    assert.equal(body.nat_type, "unknown"); // helper-defaulted
    const meta = body.transport_metadata as Record<string, unknown>;
    assert.equal(meta.tier, 1);
    assert.deepEqual(meta.detection_log_tail, ["tier-1: UPnP mapped 8080"]);
  });

  it("iter-1427: applyNatProfile on tier-4 unreachable does NOT overwrite endpoint", async () => {
    let captured: Record<string, unknown> | null = null;
    const restore = mockFetch((_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "tok-keep", node_id: "n-keep" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n-keep",
      endpoint: "https://manual-endpoint.example.com:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "q",
      directoryUrl: "https://iicp.test",
    });
    node.applyNatProfile({
      tier: 4,
      transportMethod: "unreachable",
      publicEndpoint: undefined,
      isReachable() {
        return false;
      },
    });
    await node.register();
    restore();
    assert.ok(captured);
    const body = captured as Record<string, unknown>;
    assert.equal(body.endpoint, "https://manual-endpoint.example.com:8080");
    assert.equal(body.transport_method, undefined, "unreachable should not surface");
  });

  it("submit shares trace-id between discover and node POST", async () => {
    const captured: string[] = [];
    const restore = mockFetch((url, init) => {
      const u = url.toString();
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      captured.push(headers["traceparent"] ?? "");
      if (u.includes("discover")) {
        return jsonResponse({ nodes: [{ node_id: "n1", endpoint: "http://1.2.3.4:8080", score: 1, available: true, region: "eu" }] });
      }
      return jsonResponse({ task_id: "t1", result: {}, status: "ok" });
    });
    const client = new IicpClient({ directory_url: "http://fake.test" });
    await client.submit({ intent: "urn:iicp:intent:llm:chat:v1", payload: {} });
    assert.equal(captured.length, 2);
    const traceId0 = captured[0].split("-")[1];
    const traceId1 = captured[1].split("-")[1];
    assert.equal(traceId0, traceId1, `trace-id mismatch: ${captured[0]} vs ${captured[1]}`);
    restore();
  });
});

// ---------------------------------------------------------------------------
// ε-greedy provider selection (R4 / #486)
// ---------------------------------------------------------------------------

const MULTI_NODE_IPS = ["1.2.3.1", "1.2.3.2", "1.2.3.3", "1.2.3.4", "1.2.3.5"];
const multiNodes = MULTI_NODE_IPS.map((ip, i) => ({
  node_id: `node-${String(i + 1).padStart(2, "0")}`,
  endpoint: `http://${ip}:9484`,
  score: parseFloat((1.0 - i * 0.1).toFixed(1)),
  available: true,
  region: "eu-west",
}));

describe("ε-greedy provider selection (#486)", () => {
  it("with ε=1.0 explores non-top nodes across 20 calls", async () => {
    const hitEndpoints = new Set<string>();
    const restore = mockFetch((url) => {
      const u = url.toString();
      if (u.includes("discover")) {
        return jsonResponse({ nodes: multiNodes });
      }
      hitEndpoints.add(u);
      return jsonResponse({ task_id: "t1", result: {}, status: "ok" });
    });
    const client = new IicpClient({ directory_url: "http://fake.test", routing_epsilon: 1.0 });
    for (let i = 0; i < 20; i++) {
      await client.submit({ intent: "urn:iicp:intent:llm:chat:v1", payload: {} });
    }
    restore();
    // With ε=1.0 and 5 nodes, 20 draws should hit >1 unique endpoint
    assert.ok(
      hitEndpoints.size > 1,
      `ε-greedy not working: only hit ${JSON.stringify([...hitEndpoints])} — exploration never fired`,
    );
  });

  it("with ε=0.0 always picks the top (first) node", async () => {
    const hitEndpoints = new Set<string>();
    const restore = mockFetch((url) => {
      const u = url.toString();
      if (u.includes("discover")) return jsonResponse({ nodes: multiNodes });
      hitEndpoints.add(u);
      return jsonResponse({ task_id: "t1", result: {}, status: "ok" });
    });
    const client = new IicpClient({ directory_url: "http://fake.test", routing_epsilon: 0.0 });
    for (let i = 0; i < 5; i++) {
      await client.submit({ intent: "urn:iicp:intent:llm:chat:v1", payload: {} });
    }
    restore();
    assert.equal(hitEndpoints.size, 1, `ε=0 should only hit one endpoint, got ${JSON.stringify([...hitEndpoints])}`);
    assert.ok([...hitEndpoints][0].includes("1.2.3.1"), "should always pick the top node (1.2.3.1)");
  });

  it("IICP_ROUTING_EPSILON env var overrides default", () => {
    const orig = process.env["IICP_ROUTING_EPSILON"];
    process.env["IICP_ROUTING_EPSILON"] = "0.0";
    const client = new IicpClient({ directory_url: "http://fake.test" });
    assert.equal(client["cfg"].routing_epsilon, 0.0, "env var should set epsilon to 0.0");
    if (orig === undefined) delete process.env["IICP_ROUTING_EPSILON"];
    else process.env["IICP_ROUTING_EPSILON"] = orig;
  });
});

// ADR-016: IICP client SDK conformance
/**
 * Unit tests for ADR-019 pricing + HMAC. TS port of the Python pricing
 * test matrix. The wire-compat check is critical: PHP json_encode(1.0) → "1"
 * and Python json.dumps(1.0) → "1.0"; both SDKs canonicalize through the
 * phpCanonicalSignBody helper so HMACs round-trip with the directory.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  buildPricingBlock,
  phpCanonicalSignBody,
  signBody,
  verifySignature,
} from "../src/pricing.js";
import { IicpNode } from "../src/node.js";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
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

describe("HMAC primitive", () => {
  it("signBody matches node:crypto reference HMAC", () => {
    const body = Buffer.from("hello world");
    const got = signBody(body, "secret");
    const expected = createHmac("sha256", "secret").update(body).digest("hex");
    assert.equal(got, expected);
  });
  it("verifySignature round trip", () => {
    const body = Buffer.from("hello");
    const sig = signBody(body, "k");
    assert.equal(verifySignature(body, "k", sig), true);
    assert.equal(verifySignature(body, "k", "deadbeef"), false);
    assert.equal(verifySignature(body, "wrong-key", sig), false);
  });
});

describe("PHP canonical body (wire-compat)", () => {
  it("whole float emits integer form", () => {
    const body = phpCanonicalSignBody({ creditCostMultiplier: 1.0, pricingModel: "per_token" });
    assert.equal(
      body.toString(),
      '{"credit_cost_multiplier":1,"pricing_model":"per_token"}'
    );
  });
  it("fractional float emits decimal", () => {
    const body = phpCanonicalSignBody({ creditCostMultiplier: 1.5, pricingModel: "per_token" });
    assert.equal(
      body.toString(),
      '{"credit_cost_multiplier":1.5,"pricing_model":"per_token"}'
    );
  });
  it("byte-equal HMAC vs node:crypto reference", () => {
    const body = phpCanonicalSignBody({ creditCostMultiplier: 1.5, pricingModel: "per_token" });
    const expected = createHmac("sha256", "test-secret-key").update(body).digest("hex");
    assert.equal(signBody(body, "test-secret-key"), expected);
  });
});

describe("buildPricingBlock", () => {
  it("unsigned when signDeclarations disabled", () => {
    const block = buildPricingBlock({ creditCostMultiplier: 1.5 }, "k");
    assert.equal(block.declaration_signature, undefined);
    assert.equal(block.credit_cost_multiplier, 1.5);
    assert.equal(block.pricing_model, "per_token");
  });
  it("unsigned when enabled but no key", () => {
    const block = buildPricingBlock(
      { creditCostMultiplier: 1.5, signDeclarations: true },
      ""
    );
    assert.equal(block.declaration_signature, undefined);
  });
  it("signed when enabled with key", () => {
    const block = buildPricingBlock(
      { creditCostMultiplier: 1.5, signDeclarations: true },
      "k"
    );
    assert.ok(typeof block.declaration_signature === "string");
    const body = phpCanonicalSignBody({ creditCostMultiplier: 1.5, pricingModel: "per_token" });
    assert.equal(verifySignature(body, "k", block.declaration_signature as string), true);
  });
  it("effective window passed through", () => {
    const block = buildPricingBlock({
      creditCostMultiplier: 1.0,
      effectiveFrom: "2026-06-01T00:00:00Z",
      effectiveUntil: "2026-12-31T23:59:59Z",
    });
    assert.equal(block.effective_from, "2026-06-01T00:00:00Z");
    assert.equal(block.effective_until, "2026-12-31T23:59:59Z");
  });
});

describe("Register payload integration", () => {
  it("no pricing in NodeConfig → no pricing block", async () => {
    let captured: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "t", node_id: "n" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n",
      endpoint: "https://provider:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "q",
      directoryUrl: "https://iicp.test",
    });
    await node.register();
    assert.equal((captured as Record<string, unknown>).pricing, undefined);
  });

  it("pricing in NodeConfig → block emitted", async () => {
    let captured: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "t", node_id: "n" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n",
      endpoint: "https://provider:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "q",
      directoryUrl: "https://iicp.test",
      pricing: { creditCostMultiplier: 1.5 },
    });
    await node.register();
    const pricing = (captured as Record<string, unknown>).pricing as Record<string, unknown>;
    assert.equal(pricing.credit_cost_multiplier, 1.5);
    assert.equal(pricing.pricing_model, "per_token");
    assert.equal(pricing.declaration_signature, undefined);
  });

  it("signs with operator-provisioned key", async () => {
    let captured: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      captured = JSON.parse(init?.body as string);
      return jsonResponse({ node_token: "t", node_id: "n" }, 201);
    });
    const node = new IicpNode({
      nodeId: "n",
      endpoint: "https://provider:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "q",
      directoryUrl: "https://iicp.test",
      pricing: { creditCostMultiplier: 1.5, signDeclarations: true },
      nodeHmacKey: "op-key",
    });
    await node.register();
    const c = captured as Record<string, unknown>;
    const pricing = c.pricing as Record<string, unknown>;
    assert.ok(typeof pricing.declaration_signature === "string");
    assert.equal(c.node_hmac_key, "op-key");
    const body = phpCanonicalSignBody({ creditCostMultiplier: 1.5, pricingModel: "per_token" });
    assert.equal(
      verifySignature(body, "op-key", pricing.declaration_signature as string),
      true
    );
  });

  it("captures directory-issued node_hmac_key", async () => {
    mockFetch(async () =>
      jsonResponse({ node_token: "t", node_id: "n", node_hmac_key: "dir-key-deadbeef" }, 201)
    );
    const node = new IicpNode({
      nodeId: "n",
      endpoint: "https://provider:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "q",
      directoryUrl: "https://iicp.test",
    });
    await node.register();
    assert.equal(node.nodeHmacKey, "dir-key-deadbeef");
  });

  it("operator key wins over directory-issued", async () => {
    mockFetch(async () =>
      jsonResponse({ node_token: "t", node_id: "n", node_hmac_key: "dir-tried" }, 201)
    );
    const node = new IicpNode({
      nodeId: "n",
      endpoint: "https://provider:8080",
      intent: "urn:iicp:intent:llm:chat:v1",
      model: "q",
      directoryUrl: "https://iicp.test",
      nodeHmacKey: "op-set",
    });
    await node.register();
    assert.equal(node.nodeHmacKey, "op-set");
  });
});

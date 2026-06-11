// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests — model-list drift re-registration (#494).
 *
 * These tests fail if _maybeReregisterOnModelDrift() is removed or its
 * re-registration logic is broken. Each verifies one observable behavior per
 * the #494 acceptance criteria.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { IicpNode } from "../src/node.js";

function makeNode(backendUrl = "http://mock-backend") {
  return new IicpNode({
    nodeId: "drift-ts-1",
    endpoint: "http://node.local:8080",
    intent: "urn:iicp:intent:llm:chat:v1",
    model: "phi3:mini",
    capabilities: ["llama3.2:1b"],
    directoryUrl: "http://mock-dir",
    backendUrl,
  });
}

describe("model drift re-registration (#494)", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("re-registers when the live model list differs from registered", async () => {
    const node = makeNode();
    // Simulate prior registration: registered phi3:mini + llama3.2:1b
    (node as any)._registeredModels = new Set(["phi3:mini", "llama3.2:1b"]);

    const registerCalls: unknown[] = [];
    globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
      const u = url.toString();
      if (u.includes("/api/tags")) {
        // Backend now only has phi3:mini (llama3.2:1b drifted away)
        return new Response(JSON.stringify({ models: [{ name: "phi3:mini" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/v1/register")) {
        registerCalls.push(opts?.body ? JSON.parse(opts.body as string) : {});
        return new Response(JSON.stringify({ node_token: "tok-drift-ts-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    };

    await (node as any)._maybeReregisterOnModelDrift("tok-old");

    assert.equal(registerCalls.length, 1, "re-register must fire when models drift");
    const body = registerCalls[0] as Record<string, unknown>;
    const caps = (body.capabilities as { models?: string[] }[]) ?? [];
    const registered = new Set(caps.flatMap((c) => c.models ?? []));
    assert.deepEqual(registered, new Set(["phi3:mini"]));
  });

  it("does not re-register when models are unchanged", async () => {
    const node = makeNode();
    (node as any)._registeredModels = new Set(["llama3.2:1b", "phi3:mini"]);

    let registerFired = false;
    globalThis.fetch = async (url: RequestInfo | URL) => {
      const u = url.toString();
      if (u.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "phi3:mini" }, { name: "llama3.2:1b" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (u.includes("/v1/register")) registerFired = true;
      return new Response("{}", { status: 200 });
    };

    await (node as any)._maybeReregisterOnModelDrift("tok-same");
    assert.equal(registerFired, false, "must not re-register when models unchanged");
  });

  it("does not re-register when backend returns empty model list", async () => {
    const node = makeNode();
    (node as any)._registeredModels = new Set(["phi3:mini"]);

    let registerFired = false;
    globalThis.fetch = async (url: RequestInfo | URL) => {
      const u = url.toString();
      if (u.includes("/api/tags")) {
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/v1/register")) registerFired = true;
      return new Response("{}", { status: 200 });
    };

    await (node as any)._maybeReregisterOnModelDrift("tok-empty");
    assert.equal(registerFired, false, "must not re-register on empty backend model list");
  });

  it("does not re-register when backendUrl is not set", async () => {
    const node = makeNode(""); // no backendUrl
    (node as any)._registeredModels = new Set(["phi3:mini"]);

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    await (node as any)._maybeReregisterOnModelDrift("tok-no-backend");
    assert.equal(fetchCalled, false, "must not call fetch when no backendUrl");
  });
});

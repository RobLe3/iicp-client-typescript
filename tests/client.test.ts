/**
 * IICP TypeScript SDK tests — SDK-01..SDK-06 conformance (ADR-016 §5)
 * Runs with: node --loader tsx/esm --test tests/client.test.ts
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { IicpClient } from "../src/client.js";
import { IicpError } from "../src/errors.js";

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
          nodes: [{ node_id: "abc", endpoint: "http://fake-node.test", score: 0.9, available: true, region: "eu" }],
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
      if (u.includes("/api/v1/discover")) {
        return jsonResponse({
          nodes: [
            { node_id: "n1", endpoint: "https://node1.test", score: 0.95, available: true, region: "eu" },
            { node_id: "n2", endpoint: "https://node2.test", score: 0.80, available: true, region: "us" },
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
        return jsonResponse({ nodes: [{ node_id: "n1", endpoint: "http://fake-node.test", score: 1, available: true, region: "eu" }] });
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

  it("submit shares trace-id between discover and node POST", async () => {
    const captured: string[] = [];
    const restore = mockFetch((url, init) => {
      const u = url.toString();
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      captured.push(headers["traceparent"] ?? "");
      if (u.includes("discover")) {
        return jsonResponse({ nodes: [{ node_id: "n1", endpoint: "http://fake-node.test", score: 1, available: true, region: "eu" }] });
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

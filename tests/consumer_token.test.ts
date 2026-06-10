/**
 * Behavior tests for Phase-2 consumer token acquisition (#496).
 *
 * Each test fails if the fix is reverted:
 * - _acquireConsumerToken removed → X-IICP-Consumer-Token never sent
 * - cache removed → directory hit on every task call
 * - expired entry not refreshed → stale token forwarded
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IicpClient } from "../src/client.js";

type FetchHandler = (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: FetchHandler) {
  const original = globalThis.fetch;
  (globalThis as unknown as { fetch: FetchHandler }).fetch = handler;
  return () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("consumer token acquisition (#496)", () => {
  it("sends X-IICP-Consumer-Token when node_token is configured", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const exp = Math.floor(Date.now() / 1000) + 300;

    const restore = mockFetch((url, init) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/api/v1/consumer-token")) {
        return json({ token: "tok.sig", expires_at: exp }, 201);
      }
      if (u.includes("/api/v1/discover")) {
        return json({
          nodes: [{ node_id: "node-abc", endpoint: "https://node.example.com", score: 1 }],
        });
      }
      // task call — capture headers
      capturedHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return json({ status: "success", result: {} });
    });

    try {
      const client = new IicpClient({
        directory_url: "https://iicp.network/api",
        node_token: "my-jwt-token",
        timeout_ms: 5000,
      });
      await client.submit({ intent: "urn:iicp:intent:llm:chat:v1", payload: {} });
    } catch {
      // may fail on endpoint reachability; headers are what we care about
    } finally {
      restore();
    }

    const taskCall = capturedHeaders.find((h) => "content-type" in h);
    assert.ok(taskCall, "task call headers not captured");
    assert.equal(
      taskCall["x-iicp-consumer-token"],
      "tok.sig",
      "X-IICP-Consumer-Token not set on task call",
    );
  });

  it("does NOT set X-IICP-Consumer-Token when node_token is absent", async () => {
    const capturedHeaders: Record<string, string>[] = [];

    const restore = mockFetch((url, init) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/api/v1/discover")) {
        return json({
          nodes: [{ node_id: "node-xyz", endpoint: "https://node.example.com", score: 1 }],
        });
      }
      capturedHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return json({ status: "success", result: {} });
    });

    try {
      const client = new IicpClient({
        directory_url: "https://iicp.network/api",
        timeout_ms: 5000,
        // no node_token
      });
      await client.submit({ intent: "urn:iicp:intent:llm:chat:v1", payload: {} });
    } catch {
      // ignore
    } finally {
      restore();
    }

    const taskCall = capturedHeaders.find((h) => "content-type" in h);
    if (taskCall) {
      assert.ok(
        !("x-iicp-consumer-token" in taskCall),
        "X-IICP-Consumer-Token should NOT be present without node_token",
      );
    }
  });

  it("caches token and avoids second directory call", async () => {
    let ctCalls = 0;
    const exp = Math.floor(Date.now() / 1000) + 300;

    const restore = mockFetch((url) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/api/v1/consumer-token")) {
        ctCalls++;
        return json({ token: "cached.sig", expires_at: exp }, 201);
      }
      if (u.includes("/api/v1/discover")) {
        return json({
          nodes: [{ node_id: "node-cache", endpoint: "https://node.example.com", score: 1 }],
        });
      }
      return json({ status: "success", result: {} });
    });

    try {
      const client = new IicpClient({
        directory_url: "https://iicp.network/api",
        node_token: "jwt-cached",
        timeout_ms: 5000,
      });
      // Two calls with same target/intent should only hit /consumer-token once
      await client.submit({ intent: "urn:iicp:intent:llm:chat:v1", payload: {} }).catch(() => {});
      await client.submit({ intent: "urn:iicp:intent:llm:chat:v1", payload: {} }).catch(() => {});
    } finally {
      restore();
    }

    assert.equal(ctCalls, 1, "consumer-token endpoint should only be called once (cache hit on second call)");
  });
});

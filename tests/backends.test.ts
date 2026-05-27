// ADR-016: IICP client SDK conformance
/**
 * Unit tests for the openai_compat backend handler. fetch is monkey-patched
 * per test so we exercise the routing + error mapping logic without a real
 * provider.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openaiCompatHandler } from "../src/backends/openai_compat.js";

let originalFetch: typeof globalThis.fetch;
let lastRequest: { url: string; init: RequestInit | undefined } | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastRequest = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  lastRequest = null;
});

function mockFetchJson(body: unknown, status = 200): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    lastRequest = { url: url.toString(), init };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function mockFetchText(body: string, status: number): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    lastRequest = { url: url.toString(), init };
    return new Response(body, { status });
  }) as typeof fetch;
}

describe("openaiCompatHandler", () => {
  it("chat intent → POST /chat/completions with model from factory", async () => {
    mockFetchJson({ id: "chatcmpl-test", choices: [{ message: { content: "PONG" } }] });
    const handler = openaiCompatHandler({ model: "qwen2.5:0.5b" });
    const result = await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal((result as { error_code?: number }).error_code, undefined);
    assert.match(lastRequest!.url, /\/chat\/completions$/);
    const body = JSON.parse(lastRequest!.init!.body as string);
    assert.equal(body.model, "qwen2.5:0.5b");
    const r = result as { result: { id: string } };
    assert.equal(r.result.id, "chatcmpl-test");
  });

  it("completion intent → /completions path", async () => {
    mockFetchJson({ choices: [{ text: "PONG" }] });
    const handler = openaiCompatHandler({ model: "q" });
    await handler({
      intent: "urn:iicp:intent:llm:completion:v1",
      payload: { prompt: "ping" },
    });
    assert.match(lastRequest!.url, /\/completions$/);
    assert.doesNotMatch(lastRequest!.url, /chat/);
  });

  it("embedding intent → /embeddings path", async () => {
    mockFetchJson({ data: [{ embedding: [0.1, 0.2] }] });
    const handler = openaiCompatHandler({ model: "text-embedding-3-small" });
    const result = await handler({
      intent: "urn:iicp:intent:llm:embedding:v1",
      payload: { input: "hello" },
    });
    assert.match(lastRequest!.url, /\/embeddings$/);
    const r = result as { result: { data: Array<{ embedding: number[] }> } };
    assert.deepEqual(r.result.data[0].embedding, [0.1, 0.2]);
  });

  it("task payload model overrides factory default", async () => {
    mockFetchJson({ choices: [] });
    const handler = openaiCompatHandler({ model: "qwen2.5:0.5b" });
    await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [], model: "llama-3-8b" },
    });
    const body = JSON.parse(lastRequest!.init!.body as string);
    assert.equal(body.model, "llama-3-8b");
  });

  it("unsupported intent returns 400", async () => {
    const handler = openaiCompatHandler({ model: "q" });
    const result = await handler({
      intent: "urn:iicp:intent:llm:fancy:v1",
      payload: {},
    });
    assert.equal((result as { error_code: number }).error_code, 400);
    assert.match((result as { error_message: string }).error_message, /unsupported intent/);
  });

  it("no model anywhere returns 400", async () => {
    const handler = openaiCompatHandler({});
    const result = await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [] },
    });
    assert.equal((result as { error_code: number }).error_code, 400);
    assert.match((result as { error_message: string }).error_message, /no model/);
  });

  it("non-dict payload returns 400", async () => {
    const handler = openaiCompatHandler({ model: "q" });
    const result = await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: "string-not-dict" as unknown as Record<string, unknown>,
    });
    assert.equal((result as { error_code: number }).error_code, 400);
    assert.match((result as { error_message: string }).error_message, /must be a dict/);
  });

  it("upstream 500 is surfaced verbatim", async () => {
    mockFetchText("model not loaded", 500);
    const handler = openaiCompatHandler({ model: "q" });
    const result = await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [] },
    });
    assert.equal((result as { error_code: number }).error_code, 500);
    assert.match((result as { error_message: string }).error_message, /model not loaded/);
  });

  it("upstream 429 rate limit is surfaced", async () => {
    mockFetchText("rate limit exceeded", 429);
    const handler = openaiCompatHandler({ model: "q" });
    const result = await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [] },
    });
    assert.equal((result as { error_code: number }).error_code, 429);
  });

  it("api_key sets Authorization header", async () => {
    mockFetchJson({});
    const handler = openaiCompatHandler({ model: "q", apiKey: "sk-test-1234" });
    await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [] },
    });
    const headers = new Headers(lastRequest!.init!.headers);
    assert.equal(headers.get("authorization"), "Bearer sk-test-1234");
  });

  it("baseUrl trailing slash is normalized", async () => {
    mockFetchJson({});
    const handler = openaiCompatHandler({
      baseUrl: "http://localhost:11434/v1/",
      model: "q",
    });
    await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [] },
    });
    assert.equal(lastRequest!.url, "http://localhost:11434/v1/chat/completions");
  });
});

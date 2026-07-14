// ADR-016: IICP client SDK conformance
/**
 * Unit tests for the openai_compat backend handler. fetch is monkey-patched
 * per test so we exercise the routing + error mapping logic without a real
 * provider.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openaiCompatHandler } from "../src/backends/openai_compat.js";
import { vllmHandler } from "../src/backends/vllm.js";
import { llamacppHandler } from "../src/backends/llamacpp.js";
import { meshllmHandler } from "../src/backends/meshllm.js";
import { getBackendHandler, BACKEND_TYPES } from "../src/backends/index.js";

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

  it("#414 audio:transcribe → multipart POST /audio/transcriptions returns text", async () => {
    mockFetchJson({ text: "hello world" });
    const handler = openaiCompatHandler({ model: "whisper-1" });
    const audio = Buffer.from("RIFF....fake-wav-bytes").toString("base64");
    const result = await handler({
      intent: "urn:iicp:intent:audio:transcribe:v1",
      payload: { audio, filename: "clip.wav", language: "en" },
    });
    assert.equal((result as { error_code?: number }).error_code, undefined);
    assert.match(lastRequest!.url, /\/audio\/transcriptions$/);
    const fd = lastRequest!.init!.body as FormData;
    assert.ok(fd instanceof FormData, "multipart body must be FormData (not JSON)");
    assert.equal(fd.get("model"), "whisper-1");
    assert.ok(fd.get("file") instanceof Blob, "file part must be a Blob");
    const r2 = result as { result: { text: string } };
    assert.equal(r2.result.text, "hello world");
  });

  it("#414 audio:transcribe rejects invalid base64", async () => {
    const handler = openaiCompatHandler({ model: "whisper-1" });
    const result = await handler({
      intent: "urn:iicp:intent:audio:transcribe:v1",
      payload: { audio: "!!not-base64!!" },
    });
    assert.equal((result as { error_code: number }).error_code, 400);
    assert.match((result as { error_message: string }).error_message, /base64/);
  });

  it("#414 audio:transcribe requires audio field", async () => {
    const handler = openaiCompatHandler({ model: "whisper-1" });
    const result = await handler({
      intent: "urn:iicp:intent:audio:transcribe:v1",
      payload: {},
    });
    assert.equal((result as { error_code: number }).error_code, 400);
    assert.match((result as { error_message: string }).error_message, /audio/);
  });

  it("#414 audio:speech → JSON POST /audio/speech returns base64 audio", async () => {
    const wav = Buffer.from("RIFF....fake-wav-audio");
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      lastRequest = { url: url.toString(), init };
      return new Response(wav, { status: 200, headers: { "Content-Type": "audio/wav" } });
    }) as typeof fetch;
    const handler = openaiCompatHandler({ model: "tts-1" });
    const result = await handler({
      intent: "urn:iicp:intent:audio:speech:v1",
      payload: { input: "hello world", voice: "alloy" },
    });
    assert.equal((result as { error_code?: number }).error_code, undefined);
    assert.match(lastRequest!.url, /\/audio\/speech$/);
    const r = result as { result: { audio: string; content_type: string } };
    assert.equal(Buffer.from(r.result.audio, "base64").toString(), "RIFF....fake-wav-audio");
    assert.equal(r.result.content_type, "audio/wav");
    const body = JSON.parse(lastRequest!.init!.body as string);
    assert.equal(body.input, "hello world");
    assert.equal(body.model, "tts-1");
  });

  it("#414 audio:speech requires input field", async () => {
    const handler = openaiCompatHandler({ model: "tts-1" });
    const result = await handler({ intent: "urn:iicp:intent:audio:speech:v1", payload: {} });
    assert.equal((result as { error_code: number }).error_code, 400);
    assert.match((result as { error_message: string }).error_message, /input/);
  });

  it("#414 safety:moderate → /moderations, model-optional", async () => {
    mockFetchJson({
      results: [{ flagged: true, categories: { harassment: true }, category_scores: { harassment: 0.99 } }],
    });
    const handler = openaiCompatHandler({}); // NO model configured
    const result = await handler({
      intent: "urn:iicp:intent:safety:moderate:v1",
      payload: { input: "bad text" },
    });
    assert.equal((result as { error_code?: number }).error_code, undefined);
    assert.match(lastRequest!.url, /\/moderations$/);
    const r = result as { result: { results: { flagged: boolean }[] } };
    assert.equal(r.result.results[0].flagged, true);
    const body = JSON.parse(lastRequest!.init!.body as string);
    assert.equal(body.input, "bad text");
    assert.equal(body.model, undefined); // no model injected for moderation
  });

  it("#5 api key → Authorization: Bearer header on backend calls", async () => {
    mockFetchJson({ id: "chatcmpl-key", choices: [{ message: { content: "ok" } }] });
    const handler = openaiCompatHandler({
      baseUrl: "http://localhost:1234/v1",
      model: "qwen2.5-coder-14b-instruct-mlx",
      apiKey: "sk-lm-test",
    });
    await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    const headers = new Headers(lastRequest!.init!.headers);
    assert.equal(headers.get("authorization"), "Bearer sk-lm-test");
  });

  it("#5 no api key → no Authorization header (local Ollama back-compat)", async () => {
    mockFetchJson({ choices: [{ message: { content: "ok" } }] });
    const handler = openaiCompatHandler({ model: "qwen2.5:0.5b" });
    await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    const headers = new Headers(lastRequest!.init!.headers);
    assert.equal(headers.get("authorization"), null);
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

  it("timeout is classified deterministically", async () => {
    globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
    const result = await openaiCompatHandler({ model: "q", timeoutMs: 1 })({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [] },
    });
    assert.equal((result as { error_code: number }).error_code, 408);
  });

  it("connection refused is classified as a transport error", async () => {
    globalThis.fetch = (async () => { throw new TypeError("fetch failed: connection refused"); }) as typeof fetch;
    const result = await openaiCompatHandler({ model: "q" })({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [] },
    });
    assert.equal((result as { error_code: number }).error_code, 502);
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

// ── Dedicated backends (vLLM / llama.cpp) + selector — parity Block B ────────

describe("dedicated backends", () => {
  it("vllmHandler defaults to port 8000", async () => {
    mockFetchJson({ choices: [] });
    const handler = vllmHandler({ model: "mistral-7b" });
    const result = await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [] },
    });
    assert.equal((result as { error_code?: number }).error_code, undefined);
    assert.equal(lastRequest!.url, "http://localhost:8000/v1/chat/completions");
  });

  it("llamacppHandler defaults to port 8080", async () => {
    mockFetchJson({ choices: [] });
    const handler = llamacppHandler({ model: "gguf" });
    const result = await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [] },
    });
    assert.equal((result as { error_code?: number }).error_code, undefined);
    assert.equal(lastRequest!.url, "http://localhost:8080/v1/chat/completions");
  });

  it("vllm error messages use the vllm engine label", async () => {
    const handler = vllmHandler({ model: "m" });
    const result = await handler({ intent: "urn:iicp:intent:bogus:v1", payload: {} });
    assert.equal((result as { error_code: number }).error_code, 400);
    assert.match((result as { error_message: string }).error_message, /^vllm:/);
  });
});

describe("getBackendHandler selector", () => {
  it("BACKEND_TYPES lists all named backends", () => {
    assert.deepEqual([...BACKEND_TYPES].sort(), ["anthropic", "llamacpp", "meshllm", "openai_compat", "vllm"]);
  });

  it("meshllm uses port 9337 and rejects non-chat intents", async () => {
    mockFetchJson({ choices: [] });
    const handler = meshllmHandler({ model: "model-a" });
    const chat = await handler({ intent: "urn:iicp:intent:llm:chat:v1", payload: { messages: [] } });
    assert.equal((chat as { error_code?: number }).error_code, undefined);
    assert.equal(lastRequest!.url, "http://localhost:9337/v1/chat/completions");
    const rejected = await handler({ intent: "urn:iicp:intent:llm:embedding:v1", payload: { input: "x" } });
    assert.equal((rejected as { error_code: number }).error_code, 400);
  });

  it("returns a callable for each type", () => {
    for (const t of BACKEND_TYPES) {
      assert.equal(typeof getBackendHandler(t, { model: "m" }), "function");
    }
  });

  it("throws on unknown type", () => {
    assert.throws(() => getBackendHandler("nope", { model: "m" }), /unknown backend_type/);
  });
});

// ── C1: native Anthropic Messages-API backend (#414) ────────────────────────

import { anthropicHandler } from "../src/backends/anthropic.js";

const ANTHROPIC_OK = {
  id: "msg_01abc",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-8",
  content: [{ type: "text", text: "PONG" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 11, output_tokens: 2 },
};

describe("anthropicHandler (C1)", () => {
  it("translates chat request (system hoist + max_tokens default + x-api-key) and maps response to OpenAI shape", async () => {
    mockFetchJson(ANTHROPIC_OK);
    const handler = anthropicHandler({ model: "claude-opus-4-8", apiKey: "sk-ant-test" });
    const result = await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: {
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "ping" },
        ],
      },
    });
    assert.match(lastRequest!.url, /\/messages$/);
    const headers = new Headers(lastRequest!.init!.headers);
    assert.equal(headers.get("x-api-key"), "sk-ant-test");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    const body = JSON.parse(lastRequest!.init!.body as string);
    assert.equal(body.system, "Be terse."); // hoisted out of messages
    assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
    assert.equal(body.max_tokens, 4096); // defaulted (Anthropic requires it)
    const r = result as { result: Record<string, unknown> };
    assert.equal(r.result.object, "chat.completion");
    const choices = r.result.choices as Array<{ message: { content: string }; finish_reason: string }>;
    assert.equal(choices[0].message.content, "PONG");
    assert.equal(choices[0].finish_reason, "stop");
    assert.deepEqual(r.result.usage, { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 });
  });

  it("maps an OpenAI image_url data-URL to an Anthropic base64 image block", async () => {
    mockFetchJson(ANTHROPIC_OK);
    const handler = anthropicHandler({ model: "claude-opus-4-8", apiKey: "k" });
    await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      },
    });
    const body = JSON.parse(lastRequest!.init!.body as string);
    assert.deepEqual(body.messages[0].content, [
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  it("passes through explicit max_tokens + stop → stop_sequences", async () => {
    mockFetchJson(ANTHROPIC_OK);
    const handler = anthropicHandler({ model: "claude-opus-4-8", apiKey: "k" });
    await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [{ role: "user", content: "hi" }], max_tokens: 256, stop: "END" },
    });
    const body = JSON.parse(lastRequest!.init!.body as string);
    assert.equal(body.max_tokens, 256);
    assert.deepEqual(body.stop_sequences, ["END"]);
  });

  it("rejects a non-chat intent with 400 (Messages serves only chat)", async () => {
    const handler = anthropicHandler({ model: "claude-opus-4-8", apiKey: "k" });
    const result = await handler({ intent: "urn:iicp:intent:llm:embedding:v1", payload: { input: "x" } });
    assert.equal((result as { error_code: number }).error_code, 400);
    assert.match((result as { error_message: string }).error_message, /only/);
  });

  it("surfaces an upstream error verbatim", async () => {
    mockFetchText('{"error":{"type":"authentication_error"}}', 401);
    const handler = anthropicHandler({ model: "claude-opus-4-8", apiKey: "bad" });
    const result = await handler({
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal((result as { error_code: number }).error_code, 401);
    assert.match((result as { error_message: string }).error_message, /authentication_error/);
  });
});

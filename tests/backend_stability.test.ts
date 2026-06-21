import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BackendStabilityObservation,
  observeBackendStability,
  parseLmStudioModels,
  parseOllamaPs,
} from "../src/backend_stability.js";

describe("backend stability observer", () => {
  it("parses Ollama /api/ps as ok and redacts public output", () => {
    const obs = parseOllamaPs({ models: [{ name: "qwen2.5:0.5b", size_vram: 123 }] }, "qwen2.5:0.5b");
    assert.equal(obs.backendState, "ok");
    assert.deepEqual(obs.publicDict(), { backend_state: "ok", reason_class: "ok" });
  });

  it("treats missing Ollama model as cold not draining", () => {
    const obs = parseOllamaPs({ models: [] }, "qwen2.5:0.5b");
    assert.equal(obs.backendState, "degraded");
    assert.equal(obs.reasonClass, "backend_cold");
    assert.equal(obs.isDraining(), false);
  });

  it("parses LM Studio loading instance as temporary drain", () => {
    const obs = parseLmStudioModels(
      { data: [{ id: "qwen", loaded_instances: [{ instance_id: "abc", state: "loading", model_size_bytes: 999 }] }] },
      "qwen",
      { nowMs: 1_000_000, loadingRetryS: 17 },
    );
    assert.equal(obs.backendState, "draining");
    assert.equal(obs.reasonClass, "backend_loading");
    assert.equal(obs.retryAfterS(1_000_000), 17);
    const pub = obs.publicDict(1_000_000);
    assert.equal(pub.retry_after_s, 17);
    assert.equal(pub.drain_until, 1017);
    assert.equal("model_size_bytes" in pub, false);
    assert.equal("loaded_instances" in pub, false);
  });

  it("parses LM Studio failed instance as unstable drain", () => {
    const obs = parseLmStudioModels(
      { data: [{ id: "qwen", loaded_instances: [{ status: "failed" }] }] },
      "qwen",
      { nowMs: 2_000_000, unstableRetryS: 45 },
    );
    assert.equal(obs.backendState, "draining");
    assert.equal(obs.reasonClass, "backend_unstable");
    assert.equal(obs.retryAfterS(2_000_000), 45);
  });

  it("observer uses read-only Ollama /api/ps", async () => {
    const calls: string[] = [];
    const obs = await observeBackendStability({
      backendUrl: "http://localhost:11434/v1",
      backend: "ollama",
      expectedModel: "qwen",
      fetchImpl: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ models: [{ name: "qwen" }] }), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(obs.backendState, "ok");
    assert.deepEqual(calls, ["http://localhost:11434/api/ps"]);
  });

  it("observer uses read-only LM Studio /api/v1/models", async () => {
    const calls: string[] = [];
    const obs = await observeBackendStability({
      backendUrl: "http://localhost:1234/v1",
      backend: "lmstudio",
      expectedModel: "qwen",
      fetchImpl: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ data: [{ id: "qwen", loaded_instances: [{ state: "loading" }] }] }), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(obs.backendState, "draining");
    assert.deepEqual(calls, ["http://localhost:1234/api/v1/models"]);
  });

  it("public dict exposes only coarse fields", () => {
    const obs = new BackendStabilityObservation({
      backendState: "draining",
      reasonClass: "backend_unstable",
      drainUntilMs: 10_000,
      diagnostics: { loaded_instances: [{ id: "secret" }] },
    });
    const pub = obs.publicDict(1_000);
    assert.deepEqual(pub, {
      backend_state: "draining",
      reason_class: "backend_unstable",
      retry_after_s: 9,
      drain_until: 10,
    });
  });
});

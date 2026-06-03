// ADR-016: IICP client SDK conformance
// #409 — multi-intent capability advertising (chat + embedding from one backend).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCapabilities } from "../src/node.js";

const CHAT = "urn:iicp:intent:llm:chat:v1";
const EMBED = "urn:iicp:intent:llm:embedding:v1";

describe("#409 buildCapabilities", () => {
  it("chat + embedding models advertise two intents (LM Studio case)", () => {
    const caps = buildCapabilities(
      ["qwen2.5-coder-14b-instruct", "text-embedding-nomic-embed-text-v1.5"],
      CHAT,
      4096,
    );
    assert.equal(caps.length, 2);
    assert.equal(caps[0].intent, CHAT); // configured model leads
    assert.deepEqual(caps[0].models, ["qwen2.5-coder-14b-instruct"]);
    assert.equal(caps[1].intent, EMBED);
    assert.deepEqual(caps[1].models, ["text-embedding-nomic-embed-text-v1.5"]);
  });

  it("chat-only yields a single text capability (back-compat)", () => {
    const caps = buildCapabilities(["qwen2.5:0.5b"], CHAT, 4096);
    assert.equal(caps.length, 1);
    assert.equal(caps[0].intent, CHAT);
    assert.deepEqual(caps[0].models, ["qwen2.5:0.5b"]);
    assert.deepEqual(caps[0].input_modalities, ["text"]);
  });

  it("empty models yields one default-intent text capability", () => {
    const caps = buildCapabilities([], CHAT, 1024);
    assert.deepEqual(caps, [{ intent: CHAT, models: [], max_tokens: 1024, input_modalities: ["text"] }]);
  });

  it("#408 vision model → image-modality chat capability, distinct from text chat", () => {
    const caps = buildCapabilities(["qwen2.5-coder-14b", "qwen/qwen3-vl-8b"], CHAT, 4096);
    assert.equal(caps.length, 2);
    assert.equal(caps[0].intent, CHAT);
    assert.deepEqual(caps[0].input_modalities, ["text"]);
    assert.deepEqual(caps[0].models, ["qwen2.5-coder-14b"]);
    assert.equal(caps[1].intent, CHAT);
    assert.deepEqual(caps[1].input_modalities, ["text", "image"]);
    assert.deepEqual(caps[1].models, ["qwen/qwen3-vl-8b"]);
  });
});

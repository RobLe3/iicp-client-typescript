import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  RUNTIME_IDENTITY_CHAT_INTENT,
  RUNTIME_IDENTITY_MARKER,
  RuntimeIdentityContextUnsupported,
  composeRuntimeIdentity,
} from "../src/runtime_identity.js";
import type { ChatMessage } from "../src/types.js";

const fixtureBytes = readFileSync(new URL("../parity/runtime-identity-context-v0/fixture.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  context_marker: string;
  composition: { eligible_intent: string; max_rendered_utf8_bytes: number };
};

describe("runtime identity shared parity contract", () => {
  it("pins the exact shared fixture", () => {
    assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"), "91514f8ad7a6a02ba75d834741096a605d22390e6e21210e6369254cf12cd897");
    assert.equal(fixture.context_marker, RUNTIME_IDENTITY_MARKER);
    assert.equal(fixture.composition.eligible_intent, RUNTIME_IDENTITY_CHAT_INTENT);
  });

  it("leaves disabled and non-chat messages unchanged", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    assert.deepEqual(composeRuntimeIdentity(messages, RUNTIME_IDENTITY_CHAT_INTENT), messages);
    assert.deepEqual(composeRuntimeIdentity(messages, "urn:iicp:intent:llm:embedding:v1", { mode: "explicit" }), messages);
  });

  it("follows leading application instructions and precedes the user", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Answer briefly." },
      { role: "developer", content: "Use plain text." },
      { role: "user", content: "What is this?" },
    ];
    const result = composeRuntimeIdentity(messages, RUNTIME_IDENTITY_CHAT_INTENT, { mode: "explicit" });
    assert.deepEqual(result.slice(0, 2), messages.slice(0, 2));
    assert.equal(result[2]?.role, "system");
    assert.match(result[2]?.content ?? "", /IICP-RUNTIME-CONTEXT\/1/);
    assert.deepEqual(result[3], messages[2]);
  });

  it("suppresses an existing marker", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: `[${RUNTIME_IDENTITY_MARKER}] existing` },
      { role: "user", content: "hello" },
    ];
    assert.deepEqual(composeRuntimeIdentity(messages, RUNTIME_IDENTITY_CHAT_INTENT, { mode: "explicit" }), messages);
  });

  it("renders only bounded supplied facts", () => {
    const result = composeRuntimeIdentity(
      [{ role: "user", content: "Which model?" }],
      RUNTIME_IDENTITY_CHAT_INTENT,
      {
        mode: "explicit",
        selected_model: "model-a",
        effective_capabilities: ["input_modality:image"],
        selection_reason: "matched_intent_and_constraints",
      },
    );
    const content = result[0]!.content;
    assert.match(content, /model-a/);
    assert.match(content, /input_modality:image/);
    assert.doesNotMatch(content, /candidate set|internal score|endpoint/);
    assert.ok(new TextEncoder().encode(content).byteLength <= fixture.composition.max_rendered_utf8_bytes);
  });

  it("degrades optional unsupported channels and refuses required ones", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    assert.deepEqual(
      composeRuntimeIdentity(messages, RUNTIME_IDENTITY_CHAT_INTENT, { mode: "explicit", instruction_channel: "unsupported" }),
      messages,
    );
    assert.throws(
      () => composeRuntimeIdentity(messages, RUNTIME_IDENTITY_CHAT_INTENT, { mode: "required", instruction_channel: "unsupported" }),
      RuntimeIdentityContextUnsupported,
    );
  });
});

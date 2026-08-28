import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  decodeFrame,
  encodeFrame,
  FRAME_HEADER_LEN,
  MAX_FRAME_PAYLOAD,
  MsgType,
} from "../src/iicp_tcp.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/native-framing-v1.json", import.meta.url), "utf8")
) as {
  frame: { header_bytes: number; max_payload_bytes: number };
  scenarios: Array<{
    name: string;
    wire_hex: string;
    expected: Record<string, string | number>;
  }>;
};

describe("native framing fixture", () => {
  it("matches the canonical implementation-backed 12-byte decoder vectors", () => {
    assert.equal(fixture.frame.header_bytes, FRAME_HEADER_LEN);
    assert.equal(FRAME_HEADER_LEN, 12);
    assert.equal(fixture.frame.max_payload_bytes, MAX_FRAME_PAYLOAD);
    const expectedErrors: Record<string, RegExp> = {
      invalid_magic: /Invalid IICP magic/,
      truncated_header: /frame too short/,
      truncated_payload: /payload truncated/,
      unsupported_version: /Unsupported IICP framing version/,
      payload_too_large: /frame payload too large/,
    };

    for (const scenario of fixture.scenarios) {
      const wire = Buffer.from(scenario.wire_hex, "hex");
      if (scenario.expected.outcome === "accept") {
        const { frame, consumed } = decodeFrame(wire);
        assert.equal(frame.version, scenario.expected.version, scenario.name);
        assert.equal(frame.msgType, scenario.expected.message_type, scenario.name);
        assert.equal(frame.flags, scenario.expected.flags, scenario.name);
        assert.deepEqual(frame.payload, Buffer.from(scenario.expected.payload_hex as string, "hex"), scenario.name);
        assert.equal(consumed, scenario.expected.consumed, scenario.name);
      } else {
        assert.throws(() => decodeFrame(wire), expectedErrors[scenario.expected.reason as string], scenario.name);
      }
    }
  });

  it("emits the canonical empty PING vector", () => {
    const ping = fixture.scenarios.find((scenario) => scenario.name === "ping_empty");
    assert.ok(ping);
    assert.deepEqual(encodeFrame(MsgType.PING), Buffer.from(ping.wire_hex, "hex"));
  });

  it("rejects a payload above the declared limit before encoding", () => {
    assert.throws(
      () => encodeFrame(MsgType.CALL, Buffer.alloc(MAX_FRAME_PAYLOAD + 1)),
      /frame payload too large/,
    );
  });
});

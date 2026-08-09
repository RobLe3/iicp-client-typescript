import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  NativeResponseFrame,
  NativeResponseSequence,
  NativeResponseSequenceError,
} from "../src/native_response_sequence.js";

const fixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "parity/service-profiles-v1.json"), "utf8"),
) as { lifecycle_vectors: Array<Record<string, unknown>> };
const vectors = new Map(fixture.lifecycle_vectors.map((vector) => [vector.id as string, vector]));

for (const id of ["SERVICE-LIFECYCLE-14", "SERVICE-LIFECYCLE-15", "SERVICE-LIFECYCLE-16"]) {
  test(`accepts ${id}`, () => {
    const vector = vectors.get(id)!;
    const input = vector.input as { session_id: string; call_id: string; task_id: string };
    const sequence = new NativeResponseSequence(input.session_id, input.call_id, input.task_id);
    for (const frame of vector.native_frames as NativeResponseFrame[]) sequence.accept(frame);
    sequence.finish();
  });
}

for (const [id, code] of [
  ["SERVICE-LIFECYCLE-17", "call_id_drift"],
  ["SERVICE-LIFECYCLE-18", "sequence_drift"],
  ["SERVICE-LIFECYCLE-19", "finality_disagreement"],
  ["SERVICE-LIFECYCLE-20", "response_after_terminal"],
] as const) {
  test(`rejects ${id}`, () => {
    const vector = vectors.get(id)!;
    const input = vector.input as { session_id: string; call_id: string; task_id: string };
    const sequence = new NativeResponseSequence(input.session_id, input.call_id, input.task_id);
    assert.throws(
      () => {
        for (const frame of vector.native_frames as NativeResponseFrame[]) sequence.accept(frame);
        sequence.finish();
      },
      (error: unknown) => error instanceof NativeResponseSequenceError && error.code === code,
    );
  });
}

test("rejects transport close before terminal", () => {
  const sequence = new NativeResponseSequence("session", "call", "task");
  assert.throws(() => sequence.finish(), /missing_terminal_response/);
});

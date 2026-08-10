import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { NativeCallIdentityError, NativeCallIdentityRegistry } from "../src/native_call_identity.js";

type Vector = { id: string; calls: Array<Record<string, unknown>> };
const fixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "parity/service-profiles-v1.json"), "utf8"),
) as { lifecycle_vectors: Vector[] };
const vector = (id: string): Vector => fixture.lifecycle_vectors.find((item) => item.id === id)!;

for (const id of ["SERVICE-LIFECYCLE-21", "SERVICE-LIFECYCLE-22"]) {
  test(`accepts ${id}`, () => {
    const registry = new NativeCallIdentityRegistry();
    for (const call of vector(id).calls) registry.accept(call);
  });
}

test("rejects missing and conflicting task identity", () => {
  const registry = new NativeCallIdentityRegistry();
  const errors: string[] = [];
  for (const call of vector("SERVICE-LIFECYCLE-23").calls) {
    try {
      registry.accept(call);
    } catch (error) {
      assert.ok(error instanceof NativeCallIdentityError);
      errors.push(error.code);
    }
  }
  assert.deepEqual(errors, ["missing_task_id", "task_identity_conflict"]);
});

test("does not impose lifecycle identity on an unnegotiated CALL", () => {
  new NativeCallIdentityRegistry().accept({ call_id: "base-call" });
});

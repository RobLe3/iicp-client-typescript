import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { decideLifecycleAccounting } from "../src/service_lifecycle_accounting.js";

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "parity/service-lifecycle-accounting-v1.json"), "utf8"));

test("service lifecycle accounting fixture is portable", () => {
  for (const item of fixture.cases) {
    assert.deepEqual(decideLifecycleAccounting(item.input), item.expected, item.id);
  }
});

test("invalid input fails closed", () => {
  assert.deepEqual(decideLifecycleAccounting({ operation: "settle" }), {
    decision: "reject_invalid_input",
    reservation_action: "none",
    settlement_action: "none",
    new_execution: false,
  });
});

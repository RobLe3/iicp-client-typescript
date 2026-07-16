import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { evaluateDistributedLifecycle } from "../src/service_lifecycle_distributed.js";

const fixture = JSON.parse(fs.readFileSync(path.resolve("parity/service-lifecycle-distributed-v1.json"), "utf8"));
for (const vector of fixture.vectors) test(vector.id, () => assert.equal(evaluateDistributedLifecycle(vector), vector.expected));

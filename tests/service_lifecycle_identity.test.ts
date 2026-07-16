import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { evaluateLifecycleIdentity } from "../src/service_lifecycle_identity.js";

const fixture = JSON.parse(fs.readFileSync(path.resolve("parity/service-lifecycle-identity-v1.json"), "utf8"));
for (const item of fixture.cases) test(item.id, () => assert.equal(evaluateLifecycleIdentity(item, fixture.audit_retention_seconds), item.expected));

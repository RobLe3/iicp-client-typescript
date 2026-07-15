import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { projectExecutionConstraints, projectRouteOptions } from "../src/request_projection.js";
import type { ClientConfig, TaskRequest } from "../src/types.js";

const fixturePath = path.join(process.cwd(), "parity/sdk-request-projection-v0.json");
const fixtureBytes = fs.readFileSync(fixturePath);
assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"), "0a89ae1ee02aca25f7989576b0ab88640bf382bf2d13e37e489798c81d010d8c");
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as { cases: Array<Record<string, any>> };

function canonicalRoute(value: ReturnType<typeof projectRouteOptions>) {
  return {
    region: value.region ?? null,
    qos: value.qos ?? null,
    model: value.model ?? null,
    min_reputation: value.min_reputation ?? null,
    browser_usable_only: value.browser_usable_only ?? false,
    limit: value.limit ?? 10,
    profile_request: value.profile_request ?? null,
  };
}

test("shared SDK request projection fixture", () => {
  for (const fixtureCase of fixture.cases) {
    const config: ClientConfig = {
      directory_url: "https://directory.example/api",
      timeout_ms: 30_000,
      tls_verify: true,
      ...fixtureCase.config,
    };
    const request: TaskRequest = {
      intent: "urn:iicp:intent:llm:chat:v1",
      payload: {},
      ...fixtureCase.task,
    };
    assert.deepEqual(canonicalRoute(projectRouteOptions(request, config)), fixtureCase.expected.route_options, fixtureCase.name);
    assert.deepEqual(projectExecutionConstraints(request), fixtureCase.expected.execution_constraints, fixtureCase.name);
  }
});

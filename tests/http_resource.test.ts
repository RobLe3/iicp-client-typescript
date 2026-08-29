import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HttpResourceError,
  MAX_HTTP_TASK_BODY_BYTES,
  encodeTaskRequest,
  encodeTaskResponse,
  parseContentLength,
  validateIdentityEncoding,
} from "../src/http_resource.js";

function jsonValueWithSize(size: number): Record<string, string> {
  const overhead = Buffer.byteLength(JSON.stringify({ padding: "" }));
  const value = { padding: "x".repeat(size - overhead) };
  assert.equal(Buffer.byteLength(JSON.stringify(value)), size);
  return value;
}

describe("supported HTTP task resource boundary", () => {
  it("matches the shared protocol fixture", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("../parity/http-task-resource-boundary-v1.json", import.meta.url),
      "utf8",
    )) as {
      max_encoded_request_bytes: number;
      max_encoded_response_bytes: number;
      supported_content_encodings: string[];
    };
    assert.equal(fixture.max_encoded_request_bytes, MAX_HTTP_TASK_BODY_BYTES);
    assert.equal(fixture.max_encoded_response_bytes, MAX_HTTP_TASK_BODY_BYTES);
    assert.deepEqual(fixture.supported_content_encodings, ["identity"]);
  });

  it("accepts an exact-limit request and rejects limit plus one", () => {
    assert.equal(encodeTaskRequest(jsonValueWithSize(MAX_HTTP_TASK_BODY_BYTES)).length, MAX_HTTP_TASK_BODY_BYTES);
    assert.throws(
      () => encodeTaskRequest(jsonValueWithSize(MAX_HTTP_TASK_BODY_BYTES + 1)),
      (error: unknown) => error instanceof HttpResourceError
        && error.status === 413
        && error.code === "request_too_large",
    );
  });

  it("rejects malformed and conflicting Content-Length values", () => {
    assert.equal(parseContentLength(["12", "12"]), 12);
    assert.throws(() => parseContentLength(["12", "13"]), /conflicting Content-Length/);
    assert.throws(() => parseContentLength("12x"), /invalid Content-Length/);
  });

  it("accepts identity encoding only", () => {
    assert.doesNotThrow(() => validateIdentityEncoding(undefined));
    assert.doesNotThrow(() => validateIdentityEncoding("identity"));
    assert.throws(() => validateIdentityEncoding("gzip"), /identity encoding only/);
  });

  it("replaces an oversize generated response with a bounded error", () => {
    const exact = encodeTaskResponse(jsonValueWithSize(MAX_HTTP_TASK_BODY_BYTES));
    assert.equal(exact.status, 200);
    assert.equal(exact.body.length, MAX_HTTP_TASK_BODY_BYTES);
    const oversize = encodeTaskResponse(jsonValueWithSize(MAX_HTTP_TASK_BODY_BYTES + 1));
    assert.equal(oversize.status, 500);
    assert.ok(oversize.body.length < MAX_HTTP_TASK_BODY_BYTES);
    assert.equal(JSON.parse(oversize.body.toString()).error.code, "response_too_large");
  });
});

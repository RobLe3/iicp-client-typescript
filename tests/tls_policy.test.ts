import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { IicpClient } from "../src/client.js";
import { IicpError } from "../src/errors.js";

// SDK-05 configuration validation only: no discovery, HTTP request or TLS handshake.
describe("TLS certificate policy", () => {
  it("accepts the default certificate-verifying configuration", () => {
    assert.doesNotThrow(() => new IicpClient());
  });

  it("accepts explicit certificate verification", () => {
    assert.doesNotThrow(() => new IicpClient({ tls_verify: true }));
  });

  it("rejects disabled certificate verification with SDK-05 before any request", () => {
    const warning = mock.method(console, "warn", () => undefined);
    try {
      assert.throws(
        () => new IicpClient({ tls_verify: false }),
        (error: unknown) => error instanceof IicpError
          && error.code === "SDK-05"
          && error.component === "sdk",
      );
      assert.equal(warning.mock.callCount(), 0);
    } finally {
      warning.mock.restore();
    }
  });
});

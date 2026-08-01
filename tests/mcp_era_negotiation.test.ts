import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  MODERN_MCP_REVISION,
  buildModernMcpRequest,
  evaluateMcpEra,
  validateModernMcpResponse,
} from "../src/mcp_negotiation.js";

describe("MCP era negotiation", () => {
  it("matches the shared content-free fixture", () => {
    const fixture = JSON.parse(readFileSync(new URL("../parity/mcp-era-negotiation-v0.json", import.meta.url), "utf8")) as { cases: Array<{ id: string; input: Record<string, unknown>; expected: Record<string, unknown> }> };
    for (const testCase of fixture.cases) assert.deepEqual(evaluateMcpEra(testCase.input), testCase.expected, testCase.id);
  });

  it("builds bounded modern metadata and binds server identity", () => {
    const request = buildModernMcpRequest({ requestId: 7, method: "tools/call", name: "format_json", params: { name: "format_json", arguments: {} }, extensions: ["tasks"] });
    assert.equal(request.headers["MCP-Protocol-Version"], MODERN_MCP_REVISION);
    assert.equal(request.headers["Mcp-Method"], request.body["method"]);
    assert.equal(JSON.stringify(request.body).includes("dispatch_ticket"), false);
    validateModernMcpResponse({ _meta: { protocolVersion: MODERN_MCP_REVISION, server: { name: "local-mcp" } } }, "local-mcp");
    assert.throws(() => validateModernMcpResponse({ _meta: { protocolVersion: MODERN_MCP_REVISION, server: { name: "other" } } }, "local-mcp"), /server_identity_mismatch/);
  });
});

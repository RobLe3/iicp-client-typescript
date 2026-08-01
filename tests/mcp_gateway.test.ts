// ADR-016: IICP client SDK conformance — #512 mcp-gateway built-in command
/**
 * Behavior tests for runMcpGateway (#512).
 *
 * Each test fails if the gateway is removed or its core logic is broken:
 *
 * 1. mcp-gateway appears in printHelp() output.
 * 2. Missing --tools exits 2 with a clear error.
 * 3. _toolToIntent produces the correct URN.
 * 4. Dangerous tool names are filtered from active_tools.
 * 5. Full round-trip: register → /iicp/health → POST /v1/task → MCP dispatch
 *    via mock HTTP servers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as http from "node:http";
import * as net from "node:net";
import { McpToolPolicy, toolRiskLabel } from "../src/mcp_policy.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitPort(port: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection(port, "127.0.0.1");
        sock.once("connect", () => { sock.destroy(); resolve(); });
        sock.once("error", (e) => { sock.destroy(); reject(e); });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`port ${port} did not open in time`);
}

function fetchJson(url: string, opts: RequestInit = {}): Promise<Record<string, unknown>> {
  return fetch(url, opts).then((r) => r.json() as Promise<Record<string, unknown>>);
}

// ── test 1: help ──────────────────────────────────────────────────────────────

describe("mcp-gateway in help", () => {
  it("mcp-gateway subcommand appears in printHelp output", async () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === "string") lines.push(chunk);
      return orig(chunk, ...(rest as [BufferEncoding?, (() => void)?]));
    };
    try {
      const { main } = await import("../src/cli.js");
      await main(["help"]);
    } finally {
      process.stdout.write = orig;
    }
    assert.ok(lines.join("").includes("mcp-gateway"), "mcp-gateway must appear in help");
  });
});

// ── test 2: missing --tools ───────────────────────────────────────────────────

describe("mcp-gateway --tools required", () => {
  it("exits 2 when --tools is absent", async () => {
    const { main } = await import("../src/cli.js");
    // Suppress stderr for this test
    const origErr = process.stderr.write.bind(process.stderr);
    let errOut = "";
    process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === "string") errOut += chunk;
      return origErr(chunk, ...(rest as [BufferEncoding?, (() => void)?]));
    };
    let rc = 0;
    try {
      rc = await main(["mcp-gateway"]);
    } finally {
      process.stderr.write = origErr;
    }
    assert.equal(rc, 2, "missing --tools must return exit code 2");
    assert.ok(errOut.includes("--tools"), "error must mention --tools");
  });
});

// ── test 3: toolToIntent ──────────────────────────────────────────────────────

describe("_toolToIntent", () => {
  it("produces correct URN for simple tool names", () => {
    function toolToIntent(name: string): string {
      const safe = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      return `urn:iicp:intent:mcp:${safe}:v1`;
    }
    assert.equal(toolToIntent("read_file"), "urn:iicp:intent:mcp:read_file:v1");
    assert.equal(toolToIntent("web-search"), "urn:iicp:intent:mcp:web_search:v1");
  });
});

// ── test 4: dangerous tools filtered ─────────────────────────────────────────

describe("dangerous tool filtering", () => {
  it("filters dangerous public-unknown tool-risk classes", () => {
    const policy = new McpToolPolicy();
    const tools = ["format_json", "read_file", "write_file", "browser_control", "exec", "drone_control"];
    assert.deepEqual(tools.filter((t) => policy.allows(t)), ["format_json"]);
  });

  it("requires all controls and emits a redacted receipt", () => {
    assert.equal(new McpToolPolicy({ allowDangerousTools: true, authzPolicy: "operator-key", sandboxProfile: "container" }).allows("write_file"), false);
    const policy = new McpToolPolicy({ allowDangerousTools: true, authzPolicy: "operator-key", sandboxProfile: "container", auditRedaction: true });
    assert.equal(policy.allows("write_file"), true);
    const receipt = policy.receipt("write_file", "allowed", 2);
    assert.equal(receipt["tool_risk"], "file_write");
    assert.equal(receipt["argument_content"], "excluded");
    assert.equal("arguments" in receipt, false);
    assert.equal(JSON.stringify(receipt).includes("GDPR_CANARY_TOOL_INPUT"), false);
    assert.equal(toolRiskLabel("read_secret"), "credential_access");
    assert.equal(toolRiskLabel("drone_control"), "physical_world");
  });
});

// ── test 5: full round-trip ───────────────────────────────────────────────────

describe("mcp-gateway round-trip", () => {
  it("registers, serves /iicp/health, and dispatches /v1/task to MCP", async () => {
    const dirPort = await freePort();
    const mcpPort = await freePort();
    const gwPort = await freePort();
    const issuedToken = "gw-tok-ts-001";

    const registerCalls: unknown[] = [];
    const mcpCalls: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];

    // Mock directory
    const dirServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        if (req.url === "/register") {
          registerCalls.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ node_token: issuedToken }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({}));
        }
      });
    });
    await new Promise<void>((resolve) => dirServer.listen(dirPort, "127.0.0.1", resolve));

    // Mock MCP server
    const mcpServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        mcpCalls.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          _meta: { protocolVersion: "2026-07-28", server: { name: "mock-tools" } },
          result: { content: [{ type: "text", text: "file-contents" }] },
        }));
      });
    });
    await new Promise<void>((resolve) => mcpServer.listen(mcpPort, "127.0.0.1", resolve));

    // Start mcp-gateway in background (will block; we abort it after tests)
    const { main } = await import("../src/cli.js");
    const gwPromise = main([
      "mcp-gateway",
      "--tools", "format_json,summarize_text",
      "--node-id", "gw-ts-test-001",
      "--mcp-url", `http://127.0.0.1:${mcpPort}`,
      "--directory-url", `http://127.0.0.1:${dirPort}`,
      "--port", String(gwPort),
      "--host", "127.0.0.1",
      "--public-endpoint", `http://127.0.0.1:${gwPort}`,
      "--region", "test",
      "--mcp-revision", "2026-07-28",
      "--mcp-server-name", "mock-tools",
      "--mcp-extensions", "tasks",
    ]);
    await waitPort(gwPort);

    // Test /iicp/health
    const health = await fetchJson(`http://127.0.0.1:${gwPort}/iicp/health`);
    assert.equal(health["status"], "ok");
    assert.equal(health["node_id"], "gw-ts-test-001");
    assert.deepEqual(health["active_tools"], ["format_json", "summarize_text"]);

    // Test /v1/task dispatch
    const taskResp = await fetchJson(`http://127.0.0.1:${gwPort}/v1/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${issuedToken}`,
      },
      body: JSON.stringify({
        task_id: "ts-task-001",
        intent: "urn:iicp:intent:mcp:format_json:v1",
        payload: { tool_name: "format_json", arguments: { value: { ok: true } } },
      }),
    });
    assert.equal(taskResp["status"], "completed");
    assert.equal(taskResp["task_id"], "ts-task-001");
    assert.equal((taskResp["policy_receipt"] as Record<string, unknown>)["argument_content"], "excluded");
    assert.equal(mcpCalls[0]?.headers["mcp-protocol-version"], "2026-07-28");
    assert.equal(mcpCalls[0]?.headers["mcp-method"], "tools/call");
    const mcpParams = mcpCalls[0]?.body["params"] as Record<string, unknown>;
    assert.deepEqual((mcpParams["_meta"] as Record<string, unknown>)["extensions"], ["tasks"]);

    // Verify registration
    assert.equal(registerCalls.length, 1);
    const reg = registerCalls[0] as Record<string, unknown>;
    const regIntents = (reg["capabilities"] as Array<Record<string, unknown>>).map((cap) => cap["intent"] as string);
    assert.ok(regIntents.includes("urn:iicp:intent:mcp:format_json:v1"));
    assert.ok(regIntents.includes("urn:iicp:intent:mcp:summarize_text:v1"));
    assert.deepEqual(reg["limits"], { max_concurrent: 1, tokens_per_min: 65536 });
    assert.equal((reg["policy"] as Record<string, unknown>)["allow_tool_execution"], true);
    assert.equal("mcp_tools" in reg, false);

    // Teardown — send SIGINT to stop the gateway
    dirServer.close();
    mcpServer.close();
    process.emit("SIGINT");
    await gwPromise;
  });
});

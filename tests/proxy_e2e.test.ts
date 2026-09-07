// SPDX-License-Identifier: Apache-2.0
// End-to-end function test for `iicp-node proxy` (ADR-050, maintainer req).
// Launches the REAL proxy CLI process against a mock directory + mock node and drives
// a real HTTP request through each compat surface, asserting the full path incl.
// Server: iicp-proxy. Complements the in-process fixture conformance. #482 / WQ-074.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function mockCxKey() {
  const { publicKey } = generateKeyPairSync("x25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { algorithm: "X25519", encoding: "base64url", key: x, key_id: "cx-proxy-e2e" };
}

function startMock(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const cxPublicKey = mockCxKey();
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      const port = (server.address() as AddressInfo).port;
      if (req.method === "GET" && path === "/api/v1/discover") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          nodes: [{
            node_id: "mock-node-1",
            endpoint: `http://127.0.0.1:${port}`,
            region: "test",
            score: 1.0,
            available: true,
            cx_public_key: cxPublicKey,
          }],
          count: 1,
          query_ms: 1,
        }));
      } else if (req.method === "POST" && path === "/v1/task") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            task_id: "t-e2e",
            status: "success",
            result: { choices: [{ message: { role: "assistant", content: "E2E reply" } }], usage: {} },
          }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

async function waitReady(base: string, tries = 80): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(base + "/status");
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe("proxy E2E (real iicp-node proxy process)", () => {
  it("routes all three surfaces through the live process with Server: iicp-proxy", { timeout: 60000 }, async () => {
    const { server, port: mockPort } = await startMock();
    // pick a proxy port via an ephemeral bind, then release it
    const probe = await startMock();
    const proxyPort = probe.port;
    await new Promise<void>((r) => probe.server.close(() => r()));

    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "proxy", "--port", String(proxyPort)],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          IICP_DIRECTORY_URL: `http://127.0.0.1:${mockPort}/api`,
          IICP_PROXY_ALLOW_LOOPBACK_NODES: "1",
          IICP_NODE_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const base = `http://127.0.0.1:${proxyPort}`;
    try {
      assert.ok(await waitReady(base), "proxy did not become ready");
      const msgs = [{ role: "user", content: "hi" }];

      const oai = await fetch(base + "/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "iicp", messages: msgs }),
      });
      assert.equal(oai.status, 200);
      assert.equal(oai.headers.get("server"), "iicp-proxy");
      assert.equal(oai.headers.get("x-iicp-generated-by-ai"), "true");
      assert.equal((await oai.json()).choices[0].message.content, "E2E reply");

      const oll = await fetch(base + "/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "iicp", stream: false, messages: msgs }),
      });
      assert.equal(oll.status, 200);
      assert.equal(oll.headers.get("server"), "iicp-proxy");
      assert.equal(oll.headers.get("x-iicp-generated-by-ai"), "true");
      assert.equal((await oll.json()).message.content, "E2E reply");

      const ant = await fetch(base + "/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "iicp", max_tokens: 32, messages: msgs }),
      });
      assert.equal(ant.status, 200);
      assert.equal(ant.headers.get("server"), "iicp-proxy");
      assert.equal(ant.headers.get("x-iicp-generated-by-ai"), "true");
      assert.equal((await ant.json()).content[0].text, "E2E reply");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

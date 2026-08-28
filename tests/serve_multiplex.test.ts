// SPDX-License-Identifier: Apache-2.0
/**
 * The native TCP draft is mounted only after an explicit endpoint opt-in.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { IicpNode, deriveNativeEndpoint } from "../src/node.js";
import type { NodeConfig } from "../src/node.js";
import { IicpTcpClient } from "../src/iicp_tcp.js";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function waitPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    const attempt = (): void => {
      const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => setTimeout(attempt, 50));
    };
    attempt();
  });
}

function httpGet(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.on("data", () => undefined);
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("#457 single-port HTTP + native transport multiplexer", () => {
  let cleanup: (() => void) | undefined;
  let port: number;

  const cfg: NodeConfig = {
    nodeId: "mux-node",
    endpoint: "http://test.local",
    intent: "urn:iicp:intent:llm:chat:v1",
    region: "test-region",
    model: "test-model",
    maxConcurrent: 4,
    transportEndpoint: "iicp://127.0.0.1:9484",
  };

  before(async () => {
    port = await freePort();
    const node = new IicpNode(cfg);
    // One echo handler shared by both planes. nodeToken omitted → no heartbeat/register.
    cleanup = node.serve(
      async (task) => ({ result: { echo: (task as { payload?: unknown }).payload ?? null } }),
      { host: "127.0.0.1", port },
    );
    await waitPort(port);
  });

  after(() => cleanup?.());

  it("answers HTTP /iicp/health on the port", async () => {
    assert.equal(await httpGet(port, "/iicp/health"), 200);
  });

  it("answers a native IICP CALL on the SAME port", async () => {
    const client = new IicpTcpClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
    await client.connect();
    await client.handshake();
    const result = await client.call("urn:iicp:intent:llm:chat:v1", {
      messages: [{ role: "user", content: "hi" }],
    });
    await client.disconnect();
    // A RESPONSE came back over the multiplexed port → native plane is live alongside HTTP.
    assert.ok(result && typeof result === "object", "native CALL returned a RESPONSE result");
  });

  it("derives transport_endpoint from the HTTP endpoint (same host:port, iicp scheme)", () => {
    assert.equal(deriveNativeEndpoint("http://203.0.113.5:9484"), "iicp://203.0.113.5:9484");
    assert.equal(deriveNativeEndpoint("https://node.example:9484"), null);
    assert.equal(deriveNativeEndpoint("not-a-url"), null);
  });

  it("does not mount native TCP without an explicit transport endpoint", async () => {
    const httpOnlyPort = await freePort();
    const httpOnlyNode = new IicpNode({
      nodeId: "http-only-node",
      endpoint: "http://test.local",
      intent: "urn:iicp:intent:llm:chat:v1",
      region: "test-region",
      model: "test-model",
      maxConcurrent: 4,
    });
    const stop = httpOnlyNode.serve(async () => ({ result: { ok: true } }), {
      host: "127.0.0.1",
      port: httpOnlyPort,
    });
    try {
      await waitPort(httpOnlyPort);
      const client = new IicpTcpClient({ host: "127.0.0.1", port: httpOnlyPort, timeoutMs: 1000 });
      await client.connect();
      await assert.rejects(client.handshake());
      await client.disconnect();
    } finally {
      stop();
    }
  });
});

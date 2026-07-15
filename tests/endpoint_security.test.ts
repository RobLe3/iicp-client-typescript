import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { addressAllowed, hostnameAllowed, postJsonPinned, resolveEndpoint } from "../src/endpoint_security.js";

describe("endpoint security", () => {
  it("covers mapped and private address classes", () => {
    assert.equal(addressAllowed("93.184.216.34"), true);
    assert.equal(addressAllowed("127.0.0.1"), false);
    assert.equal(addressAllowed("169.254.169.254"), false);
    assert.equal(addressAllowed("::ffff:127.0.0.1"), false);
    assert.equal(addressAllowed("fd00::1"), false);
    assert.equal(addressAllowed("10.0.0.5", true), true);
  });

  it("blocks local host names", () => {
    assert.equal(hostnameAllowed("provider.example.com"), true);
    assert.equal(hostnameAllowed("localhost"), false);
    assert.equal(hostnameAllowed("provider.internal"), false);
    assert.equal(hostnameAllowed("ollama"), false);
  });

  it("handles literal addresses without DNS", async () => {
    const endpoint = await resolveEndpoint("https://93.184.216.34/v1");
    assert.deepEqual(endpoint.addresses, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("refuses literal metadata addresses", async () => {
    await assert.rejects(resolveEndpoint("http://169.254.169.254/latest"), /prohibited address/);
  });

  it("matches the shared endpoint-security fixture", () => {
    const fixture = JSON.parse(readFileSync(new URL("fixtures/endpoint-security-v1.json", import.meta.url), "utf8")) as {
      address_vectors: Array<{ id: string; addresses: string[]; allow_private: boolean; allowed: boolean }>;
      hostname_vectors: Array<{ id: string; host: string; allowed: boolean }>;
    };
    for (const vector of fixture.address_vectors) {
      assert.equal(vector.addresses.every((address) => addressAllowed(address, vector.allow_private)), vector.allowed, vector.id);
    }
    for (const vector of fixture.hostname_vectors) {
      assert.equal(hostnameAllowed(vector.host), vector.allowed, vector.id);
    }
  });

  it("pins a validated local connection only under explicit private opt-in", async () => {
    const previous = process.env.IICP_PROXY_ALLOW_LOOPBACK_NODES;
    process.env.IICP_PROXY_ALLOW_LOOPBACK_NODES = "1";
    const server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(307, { Location: "/result" }).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const response = await postJsonPinned(
        `http://127.0.0.1:${address.port}/redirect`,
        { ping: true },
        { "Content-Type": "application/json" },
        2_000,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.text), { ok: true });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previous === undefined) delete process.env.IICP_PROXY_ALLOW_LOOPBACK_NODES;
      else process.env.IICP_PROXY_ALLOW_LOOPBACK_NODES = previous;
    }
  });

  it("refuses cross-origin redirects before forwarding credentials", async () => {
    const previous = process.env.IICP_PROXY_ALLOW_LOOPBACK_NODES;
    process.env.IICP_PROXY_ALLOW_LOOPBACK_NODES = "1";
    const server = createServer((_req, res) => {
      res.writeHead(307, { Location: "http://localhost:9/steal" }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await assert.rejects(
        postJsonPinned(`http://127.0.0.1:${address.port}/`, {}, { Authorization: "Bearer secret" }, 2_000),
        /cross-origin provider redirect/,
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previous === undefined) delete process.env.IICP_PROXY_ALLOW_LOOPBACK_NODES;
      else process.env.IICP_PROXY_ALLOW_LOOPBACK_NODES = previous;
    }
  });
});

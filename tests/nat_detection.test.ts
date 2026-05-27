/**
 * Unit tests for nat_detection — ADR-041 tier-0 + tier-1 detection.
 *
 * UPnP-IGD discovery isn't reachable in CI; tier-1 paths are exercised by
 * temporarily monkey-patching the `tryUpnpMapping` export. Other helpers
 * (looksRoutable, probeExternalIp, detectCgnat, tier-0 fall-through) are
 * tested directly.
 */

import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as nat from "../src/nat_detection.js";
import * as dns from "node:dns";

// ── looksRoutable ────────────────────────────────────────────────────────────

describe("looksRoutable", () => {
  it("accepts public DNS hostnames", () => {
    assert.ok(nat.looksRoutable("http://node.example.com:8080"));
  });
  it("accepts public IPv4 (non-documentation)", () => {
    assert.ok(nat.looksRoutable("http://8.8.8.8:8080"));
    assert.ok(nat.looksRoutable("http://1.1.1.1:443"));
  });
  it("rejects localhost / 127.0.0.1 / ::1", () => {
    assert.ok(!nat.looksRoutable("http://localhost:8080"));
    assert.ok(!nat.looksRoutable("http://127.0.0.1:8080"));
    assert.ok(!nat.looksRoutable("http://[::1]:8080"));
  });
  it("rejects RFC1918 private ranges", () => {
    assert.ok(!nat.looksRoutable("http://192.168.1.1:8080"));
    assert.ok(!nat.looksRoutable("http://10.0.0.5:8080"));
    assert.ok(!nat.looksRoutable("http://172.20.0.5:8080"));
  });
  it("rejects link-local 169.254.x.x", () => {
    assert.ok(!nat.looksRoutable("http://169.254.5.5:8080"));
  });
  it("rejects RFC 5737 documentation ranges", () => {
    assert.ok(!nat.looksRoutable("http://203.0.113.5:8080"));
    assert.ok(!nat.looksRoutable("http://192.0.2.5:8080"));
  });
  it("rejects CGNAT 100.64/10", () => {
    assert.ok(!nat.looksRoutable("http://100.65.0.1:8080"));
  });
  it("rejects reserved suffixes", () => {
    assert.ok(!nat.looksRoutable("http://node.local:8080"));
    assert.ok(!nat.looksRoutable("http://node.test:8080"));
    assert.ok(!nat.looksRoutable("http://service.internal:8080"));
    assert.ok(!nat.looksRoutable("http://node.example:8080"));
  });
  it("rejects bare hostnames (Docker service names)", () => {
    assert.ok(!nat.looksRoutable("http://adapter-llama:8080"));
  });
  it("rejects garbage URLs", () => {
    assert.ok(!nat.looksRoutable("not-a-url"));
  });
});

// ── detectCgnat ──────────────────────────────────────────────────────────────

describe("detectCgnat", () => {
  let originalReverse: typeof dns.promises.reverse;
  beforeEach(() => {
    originalReverse = dns.promises.reverse;
  });
  afterEach(() => {
    (dns.promises as { reverse: typeof originalReverse }).reverse = originalReverse;
  });

  it("warns when hostname contains 'cgn'", async () => {
    (dns.promises as { reverse: (ip: string) => Promise<string[]> }).reverse = async () => ["cgn-89-1-216-20.nc.de"];
    const w = await nat.detectCgnat("89.1.216.20");
    assert.ok(w);
    assert.match(w!, /CGNAT/);
  });
  it("warns when hostname contains 'cgnat'", async () => {
    (dns.promises as { reverse: (ip: string) => Promise<string[]> }).reverse = async () => ["cgnat-pool.example.com"];
    assert.ok(await nat.detectCgnat("100.65.0.1"));
  });
  it("returns null for normal hostnames", async () => {
    (dns.promises as { reverse: (ip: string) => Promise<string[]> }).reverse = async () => ["node1.example.com"];
    assert.equal(await nat.detectCgnat("8.8.8.5"), null);
  });
  it("returns null when reverse-DNS fails", async () => {
    (dns.promises as { reverse: (ip: string) => Promise<string[]> }).reverse = async () => {
      throw new Error("no reverse DNS");
    };
    assert.equal(await nat.detectCgnat("8.8.8.5"), null);
  });
});

// ── probeExternalIp ──────────────────────────────────────────────────────────

describe("probeExternalIp", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchText(body: string, status = 200): void {
    globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
  }

  it("returns public IPv4 from plain-text body", async () => {
    mockFetchText("8.8.8.5\n");
    assert.equal(await nat.probeExternalIp("https://api.ipify.test"), "8.8.8.5");
  });
  it("rejects RFC1918", async () => {
    mockFetchText("192.168.1.1");
    assert.equal(await nat.probeExternalIp("https://api.ipify.test"), null);
  });
  it("rejects loopback", async () => {
    mockFetchText("127.0.0.1");
    assert.equal(await nat.probeExternalIp("https://api.ipify.test"), null);
  });
  it("rejects CGNAT 100.64.x.x", async () => {
    mockFetchText("100.64.5.5");
    assert.equal(await nat.probeExternalIp("https://api.ipify.test"), null);
  });
  it("returns null on HTTP error", async () => {
    mockFetchText("", 500);
    assert.equal(await nat.probeExternalIp("https://api.ipify.test"), null);
  });
  it("handles JSON response shape", async () => {
    mockFetchText('{"ip": "8.8.8.5"}');
    assert.equal(await nat.probeExternalIp("https://api.ipify.test"), "8.8.8.5");
  });
});

// ── detectNat tier 0 ─────────────────────────────────────────────────────────

describe("detectNat tier 0", () => {
  it("accepts routable operatorPublicEndpoint as tier 0", async () => {
    const p = await nat.detectNat({
      bindHost: "0.0.0.0",
      bindPort: 8080,
      operatorPublicEndpoint: "http://node.example.com:8080",
    });
    assert.equal(p.tier, 0);
    assert.equal(p.transportMethod, "direct");
    assert.equal(p.publicEndpoint, "http://node.example.com:8080");
    assert.ok(p.isReachable());
  });

  it("falls through to tier 1 when operator endpoint is non-routable", async () => {
    // tier 1 fails because nat-upnp isn't installed in CI → tier 4.
    // detectV6: false isolates the v4 path — ADR-043 §10 IPv6 fallback
    // (iter-1468) would otherwise upgrade this to tier-1 on any host with
    // a working IPv6 GUA.
    const p = await nat.detectNat({
      bindHost: "0.0.0.0",
      bindPort: 8080,
      operatorPublicEndpoint: "http://localhost:8080",
      detectV6: false,
    });
    assert.equal(p.tier, 4);
    assert.equal(p.transportMethod, "unreachable");
    assert.ok(p.detectionLog.some((line) => line.includes("non-routable")));
  });

  it("runs tier 1 when no operator endpoint provided", async () => {
    const p = await nat.detectNat({ bindHost: "0.0.0.0", bindPort: 8080, detectV6: false });
    assert.equal(p.tier, 4); // nat-upnp not installed in CI
    assert.ok(p.operatorGuidance);
  });
});

// Reachability escalation order (tunnel-FIRST, relay = last resort; maintainer 2026-06-13).
// Guards the reorder — the serve flow consumes planReachability so the tested order is the used order.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { directTunnelFallbackReason, planReachability, relayWorkerFallbackAllowed } from "../src/cli.js";

describe("planReachability", () => {
  it("tunnel-first for tier-≥3 when tunnel enabled", () => {
    assert.deepEqual(planReachability(3, false, true), ["tunnel", "relay", "gossip"]);
    assert.deepEqual(planReachability(4, false, true), ["tunnel", "relay", "gossip"]);
  });
  it("relay-first under --no-tunnel", () => {
    assert.deepEqual(planReachability(3, false, false), ["relay", "gossip"]);
  });
  it("no escalation for tier<3 or a configured relay", () => {
    assert.deepEqual(planReachability(0, false, true), []);
    assert.deepEqual(planReachability(2, false, true), []);
    assert.deepEqual(planReachability(3, true, true), []);
  });
});

describe("directTunnelFallbackReason", () => {
  it("preserves verified direct public endpoints", () => {
    assert.equal(
      directTunnelFallbackReason("http://203.0.113.10:9484", { tier: 0, transportMethod: "direct" }),
      null,
    );
  });
  it("flags local/private and unverified IPv6 direct endpoints", () => {
    assert.equal(directTunnelFallbackReason("http://localhost:9484"), "local/private endpoint");
    assert.equal(
      directTunnelFallbackReason("http://[2a0a:a543::1]:9484"),
      "IPv6 direct endpoint has no verified inbound pinhole",
    );
    assert.equal(
      directTunnelFallbackReason("http://[2a0a:a543::1]:9484", {
        tier: 1,
        transportMethod: "direct",
        ipv6: { pinholeActive: true },
      }),
      null,
    );
  });
});

describe("relayWorkerFallbackAllowed", () => {
  it("keeps relay-capable nodes from becoming relay workers when public fallback fails", () => {
    assert.equal(relayWorkerFallbackAllowed(false), true);
    assert.equal(relayWorkerFallbackAllowed(undefined), true);
    assert.equal(relayWorkerFallbackAllowed(true), false);
  });
});

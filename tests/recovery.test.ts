import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRecovery, nodeRegistryPrefix, routeNeedsPromotionFromRegistryJson } from "../src/recovery.js";

describe("recovery helpers", () => {
  it("uses eight-character public prefixes for UUID nodes", () => {
    assert.equal(nodeRegistryPrefix("b30aee67-9089-4337-806e-b560428cf97a"), "b30aee67");
    assert.equal(nodeRegistryPrefix("relay-eu-e50fc7f9"), "relay-eu-e50fc7f9");
  });

  it("reregisters before supervised restart on directory absence", () => {
    assert.deepEqual(
      classifyRecovery({
        localHealthOk: true,
        publicAvailable: true,
        directoryPresence: "absent",
        consecutiveFailures: 1,
        graceChecks: 3,
      }),
      { state: "directory_absent", action: "reregister" },
    );
    assert.deepEqual(
      classifyRecovery({
        localHealthOk: true,
        publicAvailable: true,
        directoryPresence: "absent",
        consecutiveFailures: 3,
        graceChecks: 3,
      }),
      { state: "route_mismatch", action: "restart_self" },
    );
  });

  it("waits through public-route recovery before restart", () => {
    assert.deepEqual(
      classifyRecovery({
        localHealthOk: true,
        publicAvailable: false,
        directoryPresence: "absent",
        consecutiveFailures: 1,
        graceChecks: 3,
      }),
      { state: "limited_reach", action: "wait_cooldown" },
    );
    assert.deepEqual(
      classifyRecovery({
        localHealthOk: true,
        publicAvailable: false,
        directoryPresence: "absent",
        consecutiveFailures: 3,
        graceChecks: 3,
      }),
      { state: "restart_recommended", action: "restart_self" },
    );
  });

  it("flags direct IPv6 self-attested routes for promotion", () => {
    assert.equal(routeNeedsPromotionFromRegistryJson({
      routing_hint: "http_ipv6",
      route_evidence: "self_attested",
      browser_usable: false,
      status_summary: { state: "direct_unverified" },
    }), true);
    assert.equal(routeNeedsPromotionFromRegistryJson({
      node: {
        routing_hint: "http_ipv6",
        route_evidence: "directory_observed",
        browser_usable: false,
        status_summary: { state: "ready" },
      },
    }), false);
  });

  it("uses limited-reach restart path for route promotion", () => {
    assert.deepEqual(
      classifyRecovery({
        localHealthOk: true,
        publicAvailable: false,
        directoryPresence: "present",
        consecutiveFailures: 1,
        graceChecks: 3,
      }),
      { state: "limited_reach", action: "wait_cooldown" },
    );
    assert.deepEqual(
      classifyRecovery({
        localHealthOk: true,
        publicAvailable: false,
        directoryPresence: "present",
        consecutiveFailures: 3,
        graceChecks: 3,
      }),
      { state: "restart_recommended", action: "restart_self" },
    );
  });
});

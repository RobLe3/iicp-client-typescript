// Reachability escalation order (tunnel-FIRST, relay = last resort; maintainer 2026-06-13).
// Guards the reorder — the serve flow consumes planReachability so the tested order is the used order.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planReachability } from "../src/cli.js";

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

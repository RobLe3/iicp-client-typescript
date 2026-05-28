// ADR-016: IICP client SDK conformance
/** Unit tests for the mesh PeerManager: merge, prune, relay, HMAC verify
 * (parity Block F). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PeerManager } from "../src/peer_manager.js";
import { signBody } from "../src/pricing.js";

function pm(token = ""): PeerManager {
  const m = new PeerManager("https://dir.example/api", token);
  // mergePeers skips ownId; tests use peers != "self" so ownId can stay "".
  return m;
}

describe("PeerManager merge", () => {
  it("adds new peers", () => {
    const m = pm();
    const added = m.mergePeers([
      { node_id: "a", endpoint: "http://a" },
      { node_id: "b", endpoint: "http://b" },
    ]);
    assert.equal(added, 2);
    assert.deepEqual(m.getPeers().map((p) => p.node_id).sort(), ["a", "b"]);
  });

  it("dedups on re-merge", () => {
    const m = pm();
    m.mergePeers([{ node_id: "a", endpoint: "http://a" }]);
    const added = m.mergePeers([{ node_id: "a", endpoint: "http://a2" }]);
    assert.equal(added, 0);
    assert.equal(m.getPeers().length, 1);
  });
});

describe("PeerManager prune + relay", () => {
  it("prunes stale peers", () => {
    const m = pm();
    m.mergePeers([{ node_id: "a", endpoint: "http://a" }]);
    // Force last_contact into the past via the public view.
    m.getPeers()[0].last_contact = 0;
    assert.equal(m.prune(), 1);
    assert.equal(m.getPeers().length, 0);
  });

  it("resolves relay targets", () => {
    const m = pm();
    m.mergePeers([{ node_id: "a", endpoint: "http://a" }]);
    assert.equal(m.relayTarget("a")?.endpoint, "http://a");
    assert.equal(m.relayTarget("missing"), undefined);
  });
});

describe("PeerManager verifyExchange", () => {
  it("no token accepts", () => {
    assert.equal(pm("").verifyExchange("{}", null), true);
  });
  it("valid signature accepted", () => {
    const m = pm("secret");
    const body = JSON.stringify({ known_peers: [] });
    assert.equal(m.verifyExchange(body, signBody(body, "secret")), true);
  });
  it("invalid signature rejected", () => {
    const m = pm("secret");
    const body = JSON.stringify({ known_peers: [] });
    assert.equal(m.verifyExchange(body, "deadbeef"), false);
    assert.equal(m.verifyExchange(body, undefined), false);
  });
});

// ── R3: relay election (#341) ────────────────────────────────────────────────

function pmWithRelays(): PeerManager {
  const m = new PeerManager("https://dir.example/api", "", { relayCapable: true, relayAcceptPort: 9485 });
  m.mergePeers([
    { node_id: "relay-a", endpoint: "http://relay-a:8020", relay_capable: true, relay_accept_port: 9485, relay_load: 0.2 },
    { node_id: "relay-b", endpoint: "http://relay-b:8020", relay_capable: true, relay_accept_port: 9486, relay_load: 0.1 },
    { node_id: "non-relay", endpoint: "http://nr:8020", relay_capable: false },
  ]);
  return m;
}

describe("PeerManager relay election (R3)", () => {
  it("electRelay returns a relay-capable candidate", async () => {
    const m = pmWithRelays();
    const elected = await m.electRelay("worker-001");
    assert.ok(elected, "should elect a relay");
    assert.equal(elected.relay_capable, true);
  });

  it("electRelay prefers lower load", async () => {
    const m = pmWithRelays();
    const elected = await m.electRelay("worker-001");
    // relay-b load=0.1 < relay-a load=0.2 → relay-b always wins
    assert.equal(elected?.node_id, "relay-b");
  });

  it("electRelay is deterministic for same workerId", async () => {
    const m = pmWithRelays();
    const e1 = await m.electRelay("worker-xyz");
    const e2 = await m.electRelay("worker-xyz");
    assert.ok(e1 && e2);
    assert.equal(e1.node_id, e2.node_id);
  });

  it("electRelay derives _relayHost and _relayPort", async () => {
    const m = pmWithRelays();
    const elected = await m.electRelay("worker-001");
    assert.ok(elected);
    assert.equal(typeof elected._relayHost, "string");
    assert.equal(typeof elected._relayPort, "number");
    assert.ok(elected._relayHost.length > 0);
  });

  it("electRelay returns null when no relay-capable peers", async () => {
    const m = new PeerManager("https://dir.example/api");
    m.mergePeers([{ node_id: "nr", endpoint: "http://nr:8020", relay_capable: false }]);
    const elected = await m.electRelay("worker");
    assert.equal(elected, null);
  });

  it("getRelayCandidates excludes non-relay peers", () => {
    const m = pmWithRelays();
    const ids = m.getRelayCandidates().map((p) => p.node_id);
    assert.ok(!ids.includes("non-relay"));
    assert.ok(ids.includes("relay-a") && ids.includes("relay-b"));
  });

  it("mergePeers stores relay fields", () => {
    const m = new PeerManager("https://dir.example/api");
    m.mergePeers([{ node_id: "r", endpoint: "http://r:8020", relay_capable: true, relay_accept_port: 9485 }]);
    const peer = m.relayTarget("r");
    assert.ok(peer);
    assert.equal(peer.relay_capable, true);
    assert.equal(peer.relay_accept_port, 9485);
  });
});

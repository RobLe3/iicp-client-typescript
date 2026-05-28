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

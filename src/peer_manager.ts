// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 2 mesh layer — peer discovery, gossip, and relay support (parity Block F, #340).
 *
 * Port of iicp-adapter `network/peer_manager.py` + `handlers/{peers,relay}.py` (ADR-009,
 * ADR-022). Bootstraps an initial peer set from the directory, gossips a random known peer
 * every 30s with an HMAC-SHA256-signed exchange (reusing the pricing HMAC key), prunes
 * peers idle for 90s, and resolves relay targets for POST /v1/relay forwarding.
 */

import { signBody } from "./pricing.js";

const GOSSIP_INTERVAL_MS = 30_000;
const PEER_EXPIRY_MS = 90_000;
const BOOTSTRAP_LIMIT = 5;

export interface PeerInfo {
  node_id: string;
  endpoint: string;
  region: string;
  last_seen: string;
  last_contact: number; // ms epoch
}

export class PeerManager {
  private readonly directoryUrl: string;
  private readonly nodeToken: string;
  private peers = new Map<string, PeerInfo>();
  private ownId = "";
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(directoryUrl: string, nodeToken = "") {
    this.directoryUrl = directoryUrl.replace(/\/$/, "");
    this.nodeToken = nodeToken;
  }

  getPeers(): PeerInfo[] {
    return [...this.peers.values()];
  }

  relayTarget(nodeId: string): PeerInfo | undefined {
    return this.peers.get(nodeId);
  }

  /** Merge incoming peer entries. Returns the count of newly added peers. */
  mergePeers(incoming: Array<Partial<PeerInfo>>): number {
    const now = Date.now();
    let added = 0;
    for (const p of incoming) {
      const nid = p.node_id;
      if (!nid || nid === this.ownId) continue;
      if (!this.peers.has(nid)) added++;
      this.peers.set(nid, {
        node_id: nid,
        endpoint: p.endpoint ?? "",
        region: p.region ?? "",
        last_seen: p.last_seen ?? "",
        last_contact: now,
      });
    }
    return added;
  }

  /** Drop peers not contacted within the expiry window. Returns count pruned. */
  prune(): number {
    const cutoff = Date.now() - PEER_EXPIRY_MS;
    let pruned = 0;
    for (const [nid, p] of this.peers) {
      if (p.last_contact < cutoff) {
        this.peers.delete(nid);
        pruned++;
      }
    }
    return pruned;
  }

  /** Verify an inbound /v1/peers HMAC signature. No token configured → accept. */
  verifyExchange(body: string, signature: string | undefined | null): boolean {
    if (!this.nodeToken) return true;
    if (!signature) return false;
    return signBody(body, this.nodeToken) === signature;
  }

  async start(nodeId: string): Promise<void> {
    this.ownId = nodeId;
    await this.bootstrap();
    this.timer = setInterval(() => {
      void this.gossipRound();
    }, GOSSIP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async gossipRound(): Promise<void> {
    const peers = this.getPeers();
    if (peers.length === 0) {
      await this.bootstrap();
      return;
    }
    const target = peers[Math.floor(Math.random() * peers.length)];
    await this.exchange(target);
    this.prune();
  }

  private async bootstrap(): Promise<void> {
    try {
      const url = `${this.directoryUrl}/v1/bootstrap?limit=${BOOTSTRAP_LIMIT}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const body = (await resp.json()) as { peers?: Array<Partial<PeerInfo>> };
        this.mergePeers(body.peers ?? []);
      }
    } catch {
      /* directory unreachable — keep persisted/known peers */
    }
  }

  private async exchange(target: PeerInfo): Promise<void> {
    const body = JSON.stringify({ known_peers: [...this.peers.keys()] });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.nodeToken) headers["X-IICP-Signature"] = signBody(body, this.nodeToken);
    try {
      const resp = await fetch(`${target.endpoint.replace(/\/$/, "")}/v1/peers`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { peers?: Array<Partial<PeerInfo>> };
        this.mergePeers(data.peers ?? []);
        const t = this.peers.get(target.node_id);
        if (t) t.last_contact = Date.now();
      }
    } catch {
      const t = this.peers.get(target.node_id);
      if (t) t.last_contact = 0;
    }
  }
}

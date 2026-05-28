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
  /** R3: relay election fields — advertised in gossip exchange */
  relay_capable?: boolean;
  relay_accept_port?: number;
  relay_load?: number;
}

export class PeerManager {
  private readonly directoryUrl: string;
  private readonly nodeToken: string;
  private peers = new Map<string, PeerInfo>();
  private ownId = "";
  private ownEndpoint = "";
  private readonly ownRelayCapable: boolean;
  private readonly ownRelayAcceptPort: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    directoryUrl: string,
    nodeToken = "",
    opts: { relayCapable?: boolean; relayAcceptPort?: number } = {},
  ) {
    this.directoryUrl = directoryUrl.replace(/\/$/, "");
    this.nodeToken = nodeToken;
    this.ownRelayCapable = opts.relayCapable ?? false;
    this.ownRelayAcceptPort = opts.relayAcceptPort ?? 9485;
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
        relay_capable: p.relay_capable ?? false,
        relay_accept_port: p.relay_accept_port ?? 9485,
        relay_load: p.relay_load ?? 0,
      });
    }
    return added;
  }

  /** R3: return relay-capable peers, for relay election. */
  getRelayCandidates(): PeerInfo[] {
    return [...this.peers.values()].filter((p) => p.relay_capable && p.endpoint);
  }

  /** R3: deterministic relay election — rank by load, tiebreak by SHA-256 hash. */
  async electRelay(workerId: string): Promise<(PeerInfo & { _relayHost: string; _relayPort: number }) | null> {
    const { createHash } = await import("node:crypto");
    const candidates = this.getRelayCandidates();
    if (candidates.length === 0) return null;
    const scored = candidates.map((p) => {
      const load = p.relay_load ?? 0;
      const hash = createHash("sha256").update(`${workerId}:${p.node_id}`).digest("hex");
      return { p, score: [load, hash] as [number, string] };
    });
    scored.sort((a, b) => {
      if (a.score[0] !== b.score[0]) return a.score[0] - b.score[0];
      return a.score[1] < b.score[1] ? -1 : 1;
    });
    const elected = scored[0].p;
    const url = new URL(elected.endpoint.startsWith("http") ? elected.endpoint : `http://${elected.endpoint}`);
    return {
      ...elected,
      _relayHost: url.hostname,
      _relayPort: elected.relay_accept_port ?? 9485,
    };
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

  async start(nodeId: string, ownEndpoint = ""): Promise<void> {
    this.ownId = nodeId;
    this.ownEndpoint = ownEndpoint;
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
    // R3: send full peer objects + own relay entry so recipients can elect us as a relay.
    const peers = [...this.peers.values()];
    const knownPeers: Array<Partial<PeerInfo>> = [...peers];
    if (this.ownId) {
      knownPeers.push({
        node_id: this.ownId,
        endpoint: this.ownEndpoint,
        relay_capable: this.ownRelayCapable,
        relay_accept_port: this.ownRelayAcceptPort,
        relay_load: 0,
      });
    }
    const body = JSON.stringify({ known_peers: knownPeers });
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

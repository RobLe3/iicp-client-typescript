// SPDX-License-Identifier: Apache-2.0
/** Directory-signed relay bind ticket helpers (#510 / DIR-RELAY-03). */
import { createPublicKey, verify as edVerify } from "node:crypto";

const DOMAIN = "iicp:relay-bind-ticket:v1\n";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface RelayBindTicketClaims {
  v: number;
  typ: "relay-bind-ticket";
  jti: string;
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
}

export class RelayBindTicketReplayCache {
  private readonly seen = new Map<string, number>();

  consume(claims: RelayBindTicketClaims, nowSec = Math.floor(Date.now() / 1000)): boolean {
    for (const [jti, exp] of this.seen) {
      if (exp <= nowSec) this.seen.delete(jti);
    }
    if (this.seen.has(claims.jti)) return false;
    this.seen.set(claims.jti, claims.exp);
    return true;
  }
}

const relayBindReplayCache = new RelayBindTicketReplayCache();

export function consumeRelayBindTicket(claims: RelayBindTicketClaims, nowSec?: number): boolean {
  return relayBindReplayCache.consume(claims, nowSec);
}

function b64pad(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return b + "=".repeat((4 - (b.length % 4)) % 4);
}

function publicKeyFromRawHex(hex: string): ReturnType<typeof createPublicKey> {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) throw new Error("relay bind ticket public key must be 32-byte hex");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function verifyRelayBindTicket(
  token: string,
  publicKeyHex: string,
  workerId: string,
  relayAudience = "*",
  nowSec = Math.floor(Date.now() / 1000),
): RelayBindTicketClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2 || parts[1].length !== 128) return null;
  const [b64Payload, sigHex] = parts;
  let payload: RelayBindTicketClaims;
  try {
    const sig = Buffer.from(sigHex, "hex");
    const key = publicKeyFromRawHex(publicKeyHex);
    if (!edVerify(null, Buffer.from(DOMAIN + b64Payload), key, sig)) return null;
    payload = JSON.parse(Buffer.from(b64pad(b64Payload), "base64").toString()) as RelayBindTicketClaims;
  } catch {
    return null;
  }
  if (payload.typ !== "relay-bind-ticket") return null;
  if (!/^[0-9a-f]{32}$/.test(payload.jti)) return null;
  if (payload.sub !== workerId) return null;
  if (payload.exp <= nowSec) return null;
  if (payload.aud !== "*" && payload.aud !== relayAudience) return null;
  return payload;
}

export async function fetchRelayBindTicket(opts: {
  directoryUrl: string;
  nodeToken: string;
  workerId: string;
  relayNodeId?: string;
}): Promise<string | undefined> {
  const url = `${opts.directoryUrl.replace(/\/$/, "")}/v1/relay/ticket`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.nodeToken}`,
      "X-Node-Id": opts.workerId,
    },
    body: JSON.stringify(opts.relayNodeId ? { relay_node_id: opts.relayNodeId } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return undefined;
  const data = await resp.json() as { ticket?: string };
  return data.ticket;
}

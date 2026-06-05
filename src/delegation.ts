// SPDX-License-Identifier: Apache-2.0
/**
 * ADR-045 Phase A — operator→node delegation (#407 / #2).
 *
 * A fleet operator holds an ed25519 keypair and issues a compact,
 * offline-verifiable token asserting `node:<id>` is operated by
 * `<operator_pubkey>` until `<not_after>`. The node attaches it at REGISTER;
 * any federated directory verifies it locally (no phone-home). Proven in #406.
 *
 * Uses the built-in `node:crypto` ed25519 (no new dependency). The CANONICAL
 * signing bytes MUST be byte-identical to the PHP directory verifier
 * (`OperatorDelegationVerifier::canonicalBytes`) and the Python signer — pinned
 * by a cross-language known-answer test (KAT). A mismatch silently breaks all
 * verification.
 */

import { createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";

/** SPKI DER prefix for an ed25519 public key (12 bytes); + 32 raw key bytes = 44. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Delegation {
  node_id: string;
  operator_pub: string;
  not_after: number;
  sig: string;
}

/**
 * Exact bytes the operator signs / the directory verifies. Field order is
 * alphabetical (node_id < not_after < operator_pub); JSON.stringify preserves
 * insertion order, yielding the spec/PHP byte form. Do NOT reorder.
 */
export function canonicalBytes(nodeId: string, operatorPubB64: string, notAfter: number): Buffer {
  return Buffer.from(
    JSON.stringify({ node_id: nodeId, not_after: notAfter, operator_pub: operatorPubB64 }),
    "utf8",
  );
}

/**
 * #460 — exact bytes the operator signs to rename their public `display_name`.
 * Field order is alphabetical (display_name < operator_pub < ts); JSON.stringify
 * preserves insertion order, yielding the PHP/Rust byte form. MUST be byte-identical
 * to `OperatorController::canonicalBytes` (PHP) and every other SDK signer. Do NOT reorder.
 */
export function canonicalRenameBytes(displayName: string, operatorPubB64: string, ts: number): Buffer {
  return Buffer.from(
    JSON.stringify({ display_name: displayName, operator_pub: operatorPubB64, ts }),
    "utf8",
  );
}

/**
 * #460 — operator signs a display_name rename; returns base64 of the ed25519 signature.
 * Only the operator key-holder can produce this, so the directory authenticates the
 * mutation by the signature alone (no node token).
 */
export function signRename(
  privateKey: KeyObject,
  displayName: string,
  operatorPubB64Val: string,
  ts: number,
): string {
  return sign(null, canonicalRenameBytes(displayName, operatorPubB64Val, ts), privateKey).toString(
    "base64",
  );
}

/** Base64 of the operator's raw 32-byte ed25519 public key (as the directory stores). */
export function operatorPubB64(privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

/** Operator (offline) signs a delegation for one node. Short TTL = revocation baseline (OPEN-3 C). */
export function issueDelegation(privateKey: KeyObject, nodeId: string, ttlSeconds = 3600): Delegation {
  const pub = operatorPubB64(privateKey);
  const notAfter = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = sign(null, canonicalBytes(nodeId, pub, notAfter), privateKey);
  return { node_id: nodeId, operator_pub: pub, not_after: notAfter, sig: sig.toString("base64") };
}

/**
 * Local self-consistency check (signature + node binding + expiry). The
 * DIRECTORY is the authority on operator trust; this lets a node sanity-check
 * its own token before sending. Returns true only if all checks pass.
 */
export function verifyDelegation(token: Delegation, claimedNodeId: string, now?: number): boolean {
  const ts = now ?? Math.floor(Date.now() / 1000);
  try {
    if (token.node_id !== claimedNodeId) return false;
    if (ts >= token.not_after) return false;
    const raw = Buffer.from(token.operator_pub, "base64");
    if (raw.length !== 32) return false;
    const pub = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      canonicalBytes(token.node_id, token.operator_pub, token.not_after),
      pub,
      Buffer.from(token.sig, "base64"),
    );
  } catch {
    return false;
  }
}

/** Convenience for tests/tools: generate an operator ed25519 keypair. */
export function generateOperatorKey(): KeyObject {
  return generateKeyPairSync("ed25519").privateKey;
}

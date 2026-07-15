import { createPublicKey, verify } from "node:crypto";

export const DISPATCH_TICKET_V2_PROFILE = "dispatch_ticket_v2";
const DOMAIN = Buffer.from("IICP-DISPATCH-TICKET-V2\0", "utf8");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface DispatchTrustKey {
  key_id: string;
  public_key_b64url: string;
  state: "active" | "retiring" | "revoked";
  valid_from: number;
  valid_until: number;
  allowed_profiles?: string[];
  issuers?: string[];
  audiences?: string[];
}

export interface DispatchTrustBundle {
  bundle_version: number;
  keys: DispatchTrustKey[];
  issuer?: string;
  valid_from?: number;
  valid_until?: number;
}

export interface DispatchTicketBindings {
  issuer: string;
  provider_id: string;
  intent: string;
  constraints_digest: string;
  audience?: string;
}

export interface DispatchTrustDecision {
  accepted: boolean;
  code: string;
  anchored: boolean;
  key_id?: string;
}

export class LocalDispatchReplayCache {
  private readonly seen = new Map<string, number>();

  contains(jti: string, now: number): boolean {
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
    return this.seen.has(jti);
  }

  remember(jti: string, expiresAt: number): void {
    this.seen.set(jti, expiresAt);
  }
}

export function canonicalTicketClaims(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTicketClaims).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalTicketClaims(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function decision(code: string, keyId?: string, accepted = false): DispatchTrustDecision {
  return { accepted, code, anchored: accepted, ...(keyId ? { key_id: keyId } : {}) };
}

export function verifyDispatchTicketV2(
  claims: Record<string, Json>,
  signatureB64url: string,
  bundle: DispatchTrustBundle,
  bindings: DispatchTicketBindings,
  options: { now: number; minimumBundleVersion?: number; replayCache?: LocalDispatchReplayCache },
): DispatchTrustDecision {
  const minimum = options.minimumBundleVersion ?? 0;
  if (!Number.isSafeInteger(bundle.bundle_version) || bundle.bundle_version < minimum) return decision("reject_bundle_rollback");
  if (bundle.valid_from !== undefined && options.now < bundle.valid_from) return decision("reject_bundle_not_yet_valid");
  if (bundle.valid_until !== undefined && options.now > bundle.valid_until) return decision("reject_bundle_expired");
  if (claims.profile !== DISPATCH_TICKET_V2_PROFILE) return decision("reject_required_profile_downgrade");
  const keyId = typeof claims.key_id === "string" ? claims.key_id : undefined;
  const key = keyId ? bundle.keys.find((candidate) => candidate.key_id === keyId) : undefined;
  if (!key) return decision("reject_unknown_key", keyId);
  if (key.state === "revoked") return decision("reject_key_revoked", keyId);
  if (options.now < key.valid_from || options.now > key.valid_until) return decision("reject_key_expired", keyId);
  if (!(key.allowed_profiles ?? [DISPATCH_TICKET_V2_PROFILE]).includes(DISPATCH_TICKET_V2_PROFILE)) return decision("reject_profile_not_allowed", keyId);
  if (key.issuers?.length && !key.issuers.includes(String(claims.issuer))) return decision("reject_issuer", keyId);
  if (key.audiences?.length && !key.audiences.includes(String(claims.audience))) return decision("reject_audience", keyId);
  const expected: Record<string, string> = {
    issuer: bindings.issuer,
    provider_id: bindings.provider_id,
    intent: bindings.intent,
    constraints_digest: bindings.constraints_digest,
  };
  if (Object.entries(expected).some(([name, value]) => claims[name] !== value)) return decision("reject_claim_mismatch", keyId);
  if (bindings.audience !== undefined && claims.audience !== bindings.audience) return decision("reject_claim_mismatch", keyId);
  const expiresAt = claims.expires_at;
  const jti = claims.jti;
  if (!Number.isSafeInteger(expiresAt) || Number(expiresAt) <= options.now || typeof jti !== "string" || !jti) return decision("reject_claim_mismatch", keyId);
  try {
    const raw = Buffer.from(key.public_key_b64url, "base64url");
    if (raw.length !== 32) return decision("reject_signature", keyId);
    const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    const message = Buffer.concat([DOMAIN, Buffer.from(canonicalTicketClaims(claims), "utf8")]);
    if (!verify(null, message, publicKey, Buffer.from(signatureB64url, "base64url"))) return decision("reject_signature", keyId);
  } catch {
    return decision("reject_signature", keyId);
  }
  if (options.replayCache?.contains(jti, options.now)) return decision("reject_local_replay", keyId);
  options.replayCache?.remember(jti, Number(expiresAt));
  return decision("accept_anchored", keyId, true);
}

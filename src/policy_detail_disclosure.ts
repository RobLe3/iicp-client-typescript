/** Pre-normative provider-side policy-detail authorization and redaction. */
import { createPublicKey, verify as edVerify } from "node:crypto";

const CONSUMER_TOKEN_DOMAIN = "iicp:consumer-token:v1\n";
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

export const POLICY_DETAIL_FIELDS = [
  "retention_intervals",
  "subprocessor_references",
  "approval_evidence_references",
  "operational_evidence_references",
] as const;

export interface PolicyDetailDisclosureDecision {
  status: number;
  reason: string;
  body?: Record<string, unknown>;
}

export function verifyPolicyDetailConsumerToken(
  token: string,
  publicKeyHex: string,
  targetNodeId: string,
  intent: string,
  nowSec: number,
): { status: "valid" | "invalid" | "expired"; claims?: Record<string, unknown> } {
  const parts = token.split(".");
  if (parts.length !== 2 || parts[1].length !== 128) return { status: "invalid" };
  try {
    const rawKey = Buffer.from(publicKeyHex, "hex");
    if (rawKey.length !== 32) return { status: "invalid" };
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, rawKey]), format: "der", type: "spki" });
    if (!edVerify(null, Buffer.from(CONSUMER_TOKEN_DOMAIN + parts[0]), key, Buffer.from(parts[1], "hex")))
      return { status: "invalid" };
    const claims = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()) as Record<string, unknown>;
    if (claims.v !== 1 || claims.aud !== targetNodeId || claims.intent !== intent || typeof claims.sub !== "string")
      return { status: "invalid" };
    if (typeof claims.exp !== "number" || claims.exp <= nowSec) return { status: "expired", claims };
    return { status: "valid", claims };
  } catch {
    return { status: "invalid" };
  }
}

/**
 * `consumer_auth` must be supplied by a cryptographic trust adapter. It is not
 * a request-body claim and this helper intentionally does not parse raw tokens.
 */
export function evaluatePolicyDetailDisclosure(context: Record<string, unknown>): PolicyDetailDisclosureDecision {
  const auth = context.consumer_auth;
  if (auth === "missing") return { status: 401, reason: "consumer_auth_required" };
  if (auth !== "valid" && auth !== "expired") return { status: 401, reason: "consumer_auth_invalid" };
  if (auth === "expired") return { status: 401, reason: "consumer_auth_expired" };
  if (context.disclosure_allowed !== true) return { status: 403, reason: "disclosure_forbidden" };

  const binding = typeof context.provider_node_id === "string" && context.provider_node_id.length > 0
    && context.provider_node_id === context.consumer_target_node_id
    && context.provider_node_id === context.ticket_target_node_id
    && typeof context.consumer_intent === "string" && context.consumer_intent.length > 0
    && context.consumer_intent === context.ticket_intent
    && typeof context.manifest_sha256 === "string" && context.manifest_sha256.length > 0
    && context.manifest_sha256 === context.ticket_manifest_sha256;
  if (!binding) return { status: 404, reason: "resource_concealed" };

  const source = context.details && typeof context.details === "object"
    ? context.details as Record<string, unknown>
    : {};
  const details: Record<string, unknown> = {};
  for (const field of POLICY_DETAIL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) details[field] = source[field];
  }
  return {
    status: 200,
    reason: "compatible",
    body: {
      profile: "urn:iicp:profile:policy-detail-disclosure:v0",
      manifest_sha256: context.manifest_sha256,
      details,
      claim_status: "provider_declared",
    },
  };
}

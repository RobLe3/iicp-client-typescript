/**
 * Remote-routing policy gates for prompt dispatch (#585).
 *
 * These checks run after prompt-free directory discovery and before a prompt is
 * sent to any remote executor.
 */

import type { Node, RoutingPolicy, RoutingProfile } from "./types.js";

type EffectiveRoutingPolicy = Required<Omit<RoutingPolicy, "required_manifest_identity_level">> & {
  required_manifest_identity_level?: RoutingPolicy["required_manifest_identity_level"];
};

export const ROUTING_POLICY_REFUSAL_CODE = "IICP-POLICY-ROUTING";

export interface RoutingPolicyDecision {
  eligible: Node[];
  rejectedReasons: string[];
  skippedKeyless: number;
}

const EU_REGION_PREFIXES = ["eu", "eea"];

export function resolvedRoutingPolicy(policy?: RoutingPolicy): EffectiveRoutingPolicy {
  let profile = normalizeProfile(policy?.profile ?? "standard");
  const defaults = profileDefaults(profile);
  if (!defaults) profile = "standard";
  const d = defaults ?? profileDefaults("standard")!;
  return {
    profile,
    allowed_regions: policy?.allowed_regions ?? d.allowed_regions,
    require_encryption: policy?.require_encryption ?? d.require_encryption,
    require_policy_manifest: policy?.require_policy_manifest ?? d.require_policy_manifest,
    require_no_payload_retention: policy?.require_no_payload_retention ?? d.require_no_payload_retention,
    allow_remote_executor: policy?.allow_remote_executor ?? d.allow_remote_executor,
    known_operator_only: policy?.known_operator_only ?? false,
    required_manifest_identity_level: policy?.required_manifest_identity_level ?? d.required_manifest_identity_level,
  };
}

export function filterNodesForRoutingPolicy(
  nodes: Node[],
  policy?: RoutingPolicy,
  opts?: { allowPlaintextDebug?: boolean },
): RoutingPolicyDecision {
  const effective = resolvedRoutingPolicy(policy);
  const eligible: Node[] = [];
  const rejectedReasons: string[] = [];
  let skippedKeyless = 0;

  for (const node of nodes) {
    const reason = nodeRejectionReason(node, effective, opts?.allowPlaintextDebug === true);
    if (reason) {
      rejectedReasons.push(reason);
      if (reason === "missing_encryption_key") skippedKeyless += 1;
      continue;
    }
    eligible.push(node);
  }
  return { eligible, rejectedReasons, skippedKeyless };
}

export function routingPolicyRefusalMessage(
  intent: string,
  decision: RoutingPolicyDecision,
  policy?: RoutingPolicy,
): string {
  const effective = resolvedRoutingPolicy(policy);
  return (
    `Routing policy '${effective.profile}' refused all discovered nodes for '${intent}' ` +
    `before prompt dispatch; no prompt was sent. Reasons: ${summarize(decision.rejectedReasons)}. ` +
    "Remote nodes can read prompts they execute; use local/browser mode for sensitive data " +
    "or relax the policy explicitly."
  );
}

function normalizeProfile(profile: string): RoutingProfile {
  return profile.replace(/-/g, "_").toLowerCase() as RoutingProfile;
}

function profileDefaults(profile: string): EffectiveRoutingPolicy | null {
  const base = {
    allowed_regions: [] as string[],
    require_encryption: true,
    require_policy_manifest: false,
    require_no_payload_retention: false,
    allow_remote_executor: true,
    known_operator_only: false,
    required_manifest_identity_level: undefined as string | undefined,
  };
  switch (profile) {
    case "standard":
      return { ...base, profile };
    case "sensitive":
      return { ...base, profile, allow_remote_executor: false };
    case "eu_restricted":
      return { ...base, profile, allowed_regions: EU_REGION_PREFIXES };
    case "strict_policy":
      return {
        ...base,
        profile,
        require_policy_manifest: true,
        require_no_payload_retention: true,
      };
    case "debug_override":
      return { ...base, profile, require_encryption: false };
    default:
      return null;
  }
}

function nodeRejectionReason(
  node: Node,
  policy: EffectiveRoutingPolicy,
  allowPlaintextDebug: boolean,
): string | null {
  if (policy.allow_remote_executor === false) return "remote_executor_disabled";
  if (policy.allowed_regions.length > 0 && !regionAllowed(node.region, policy.allowed_regions)) {
    return "region_not_allowed";
  }
  if (policy.require_encryption && !node.cx_public_key && !allowPlaintextDebug) {
    return "missing_encryption_key";
  }
  const manifest = node.node_policy_manifest && typeof node.node_policy_manifest === "object"
    ? node.node_policy_manifest
    : undefined;
  if (policy.require_policy_manifest && !manifest) return "missing_policy_manifest";
  if (policy.profile === "strict_policy" && !manifestSignedVerified(manifest)) {
    return "policy_manifest_not_signed";
  }
  if (policy.require_no_payload_retention && !declaresNoPayloadRetention(manifest)) {
    return "payload_retention_not_none";
  }
  const requiredLevel = policy.required_manifest_identity_level ?? (policy.known_operator_only ? "known_operator" : undefined);
  if (requiredLevel) return manifestIdentityRejectionReason(manifest, requiredLevel);
  return null;
}

function manifestSignedVerified(manifest?: Record<string, unknown> | null): boolean {
  const verification = manifest?.verification;
  return (
    (typeof verification === "object" &&
      verification !== null &&
      (verification as Record<string, unknown>).status === "signed_valid") ||
    manifest?.evidence === "signed_verified"
  );
}

const MANIFEST_IDENTITY_RANK: Record<string, number> = {
  self_attested: 0,
  signed_valid: 1,
  operator_bound: 2,
  known_operator: 3,
  rotated: -1,
  revoked: -1,
};

function manifestIdentityRejectionReason(manifest: Record<string, unknown> | undefined, requiredLevel: string): string | null {
  const required = ["signed_valid", "operator_bound", "known_operator"].includes(requiredLevel)
    ? requiredLevel
    : "known_operator";
  const level = typeof manifest?.manifest_identity_level === "string" ? manifest.manifest_identity_level : undefined;
  if (!level) return "missing_manifest_identity";
  if (level === "revoked" || level === "rotated") return "policy_manifest_revoked_or_rotated";
  if ((MANIFEST_IDENTITY_RANK[level] ?? -1) < MANIFEST_IDENTITY_RANK[required]) {
    return "manifest_identity_level_too_low";
  }
  return null;
}

function regionAllowed(region: string, allowed: string[]): boolean {
  const value = (region ?? "").trim().toLowerCase();
  return allowed.some((raw) => {
    const item = (raw ?? "").trim().toLowerCase();
    if (!item) return false;
    if (value === item || value.startsWith(`${item}-`)) return true;
    return item === "eea" && value.startsWith("eu-");
  });
}

function declaresNoPayloadRetention(manifest?: Record<string, unknown> | null): boolean {
  const retention = manifest?.retention;
  return (
    typeof retention === "object" &&
    retention !== null &&
    (retention as Record<string, unknown>).task_payload === "none"
  );
}

function summarize(reasons: string[]): string {
  if (reasons.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()].sort().map(([reason, count]) => `${reason}=${count}`).join(", ");
}

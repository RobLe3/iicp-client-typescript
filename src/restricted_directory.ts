import { IicpError } from "./errors.js";
import type { RestrictedDirectoryContext, RestrictedEligibility, SecretRef } from "./types.js";

export const RESTRICTED_DIRECTORY_PROFILE_ID = "urn:iicp:profile:restricted-trust-domain:v1";
const SCHEMA = "iicp.restricted-trust-domain.directory-decision.v0";

function refused(message: string): never {
  throw new IicpError(message, "restricted_directory_decision_refused", { component: "directory" });
}

export function resolveSecret(reference: SecretRef): string {
  const value = reference.kind === "environment"
    ? process.env[reference.name]
    : reference.resolve();
  if (typeof value !== "string" || !value.trim()) refused("restricted directory membership credential is unavailable");
  return value;
}

export function validateRestrictedContext(context: RestrictedDirectoryContext): void {
  if (!context.domain_id.trim() || !context.authority_id.trim() || !context.subject_id.trim()
      || !["node", "client", "directory"].includes(context.subject_kind)
      || !Number.isSafeInteger(context.minimum_membership_generation)
      || context.minimum_membership_generation < 1) refused("restricted directory context is incomplete");
  resolveSecret(context.membership_credential);
}

export function restrictedHeaders(context: RestrictedDirectoryContext): Record<string, string> {
  return { "X-IICP-Membership": resolveSecret(context.membership_credential), "X-IICP-Subject-Id": context.subject_id };
}

export function validateRestrictedDecision(body: Record<string, unknown>, context: RestrictedDirectoryContext, operation: string): RestrictedEligibility {
  const raw = body.restricted_domain_decision;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refused("restricted directory decision is missing or malformed");
  const decision = raw as Record<string, unknown>;
  const expected = ["authority_id", "decision", "domain_id", "membership_expires_at", "membership_generation", "operation", "profile", "schema", "subject_kind"];
  if (Object.keys(decision).sort().join(",") !== expected.join(",")) refused("restricted directory decision is malformed");
  const generation = decision.membership_generation;
  const expiry = decision.membership_expires_at;
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(expiry)
      || decision.schema !== SCHEMA || decision.profile !== RESTRICTED_DIRECTORY_PROFILE_ID
      || decision.decision !== "eligible" || decision.operation !== operation
      || decision.domain_id !== context.domain_id || decision.authority_id !== context.authority_id
      || decision.subject_kind !== context.subject_kind
      || (generation as number) < context.minimum_membership_generation
      || (expiry as number) <= Math.floor(Date.now() / 1000)) refused("restricted directory decision does not match the request context");
  return { domain_id: context.domain_id, authority_id: context.authority_id, membership_generation: generation as number, membership_expires_at: expiry as number };
}

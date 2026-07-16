/** Opt-in evaluator for pre-normative policy operational evidence. */
export interface PolicyEvidenceDecision { eligible: boolean; reason: string }
export type PolicyEvidenceRecord = Record<string, unknown>;

const KNOWN = new Set(["retention_control", "subprocessor_disclosure", "approval_event"]);
const reject = (reason: string): PolicyEvidenceDecision => ({ eligible: false, reason });
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : [];

export function evaluatePolicyOperationalEvidence(
  requirement: PolicyEvidenceRecord,
  context: PolicyEvidenceRecord,
  evaluatedAt: string,
): PolicyEvidenceDecision {
  const required = strings(requirement.required_evidence);
  if (required.some((kind) => !KNOWN.has(kind))) return reject("unsupported_evidence_requirement");
  if (requirement.manifest_sha256 !== context.manifest_sha256) return reject("manifest_digest_mismatch");
  const evidence = Array.isArray(context.evidence)
    ? context.evidence.filter((item): item is PolicyEvidenceRecord => Boolean(item) && typeof item === "object")
    : [];
  for (const kind of required) {
    const matches = evidence.filter((item) => item.type === kind);
    if (!matches.length) return reject("evidence_missing");
    const verified = matches.filter((item) => item.verified === true);
    if (!verified.length) return reject("evidence_unauthenticated");
    if (!verified.some((item) => typeof item.expires_at === "string" && item.expires_at > evaluatedAt)) return reject("evidence_expired");
  }
  return { eligible: true, reason: "compatible" };
}

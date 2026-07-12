/** Additive evaluator for the fixture-gated pre-normative profile draft. */
export type ProfileCompatibilityDecision = { eligible: boolean; reason: string };
type Profile = Record<string, unknown>;
type Extension = { uri?: string; required?: boolean; experimental?: boolean; review_expires_at_s?: number };

export function evaluatePreNormativeProfile(
  request: Profile, provider: Profile, aliases: Array<{ from?: string; to?: string }> = [], nowS = 0,
): ProfileCompatibilityDecision {
  if (request.policy === "deny") return { eligible: false, reason: "policy_refusal" };
  const binding = request.mapping_kind;
  if (binding !== undefined && binding !== "a2a_skill" && binding !== "mcp_tool") return { eligible: false, reason: "unsupported_binding" };
  const aliasMap = new Map(aliases.map((item) => [item.from, item.to]));
  const requestedIntent = aliasMap.get(request.intent as string) ?? request.intent;
  const providerIntent = aliasMap.get(provider.intent as string) ?? provider.intent;
  if (requestedIntent !== providerIntent) return { eligible: false, reason: "intent_mismatch" };
  if (request.schema_digest && provider.schema_digest !== request.schema_digest) return { eligible: false, reason: "schema_digest_mismatch" };
  const supported = new Set(((provider.extensions as Extension[] | undefined) ?? []).map((item) => item.uri));
  for (const extension of ((request.extensions as Extension[] | undefined) ?? [])) {
    if (!extension.required) continue;
    if (extension.experimental && (extension.review_expires_at_s ?? 0) <= nowS) return { eligible: false, reason: "experimental_extension_expired" };
    if (!supported.has(extension.uri)) return { eligible: false, reason: "required_extension_missing" };
  }
  return { eligible: true, reason: "compatible" };
}

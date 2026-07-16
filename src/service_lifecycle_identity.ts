/** Production-identity projection policy for opt-in lifecycle operations. */
const ALLOWED_AUDIT = new Set(["event_id","task_ref","principal_ref_digest","credential_key_id","revocation_epoch","operation","outcome","reason_code","occurred_at"]);

export function evaluateLifecycleIdentity(input: Record<string, unknown>, retentionSeconds=604800): string {
  if (input.kind === "audit_retention") return Number(input.age_seconds) > retentionSeconds ? "audit_record_pruned" : "audit_record_retained";
  if (input.kind === "audit_redaction") {
    const audit = input.audit && typeof input.audit === "object" ? Object.keys(input.audit) : [];
    return audit.every(field => ALLOWED_AUDIT.has(field)) ? "audit_record_allowed" : "reject_before_write";
  }
  if (input.profile_requested !== true && input.surface === "ordinary_task") return "legacy_open_mesh_unchanged";
  if (input.credential_status !== "valid") return "unauthenticated";
  if (Number(input.credential_revocation_epoch ?? 0) < Number(input.minimum_revocation_epoch ?? 0)) return "unauthenticated";
  const operation = String(input.operation ?? "");
  const scopes = new Set(Array.isArray(input.scope) ? input.scope : []);
  if (operation === "submit") return scopes.has("submit") ? "allowed_bind_owner" : "forbidden";
  if (input.principal_ref_digest !== input.task_owner_ref_digest) {
    if (input.operator_override === true && scopes.has(`operator:${operation}`)) return "allowed_operator_override";
    return "concealed_task";
  }
  return scopes.has(operation) ? "allowed" : "forbidden";
}

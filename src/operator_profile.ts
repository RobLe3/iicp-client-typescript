export interface ManagedOperatorInput {
  mode: string;
  authentication_configured: boolean;
  identity_storage_protected: boolean;
  auto_update_requested: boolean;
  update_authenticated: boolean;
  rollback_verified: boolean;
  upnp_requested: boolean;
  tunnel_requested: boolean;
  upnp_approved: boolean;
  tunnel_approved: boolean;
}

export interface ManagedOperatorDecision { accepted: boolean; reason: string }

export function evaluateManagedOperator(value: ManagedOperatorInput): ManagedOperatorDecision {
  if (value.mode === "convenience") return { accepted: true, reason: "convenience_mode" };
  if (value.mode !== "managed") return { accepted: false, reason: "invalid_operator_profile" };
  const checks: Array<[boolean, string]> = [
    [value.authentication_configured, "authentication_required"],
    [value.identity_storage_protected, "protected_identity_storage_required"],
    [!value.auto_update_requested || value.update_authenticated, "authenticated_update_required"],
    [!value.auto_update_requested || value.rollback_verified, "rollback_required"],
    [!value.upnp_requested || value.upnp_approved, "upnp_approval_required"],
    [!value.tunnel_requested || value.tunnel_approved, "tunnel_approval_required"],
  ];
  for (const [accepted, reason] of checks) if (!accepted) return { accepted: false, reason };
  return { accepted: true, reason: "managed_requirements_met" };
}

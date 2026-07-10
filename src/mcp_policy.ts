// SPDX-License-Identifier: Apache-2.0
/** Fail-closed MCP tool-risk policy shared by the built-in gateway (#601). */

export const TOOL_RISK_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  shell_exec: ["bash", "shell", "exec", "run_command", "command", "eval", "python_exec"],
  data_read: ["read_document", "query_database", "list_resource", "dataset_read", "record_lookup"],
  file_read: ["read_file", "list_dir", "cat", "open_file", "file_read", "list_files"],
  file_write: ["write_file", "delete_file", "remove_file", "edit_file", "save_file", "mkdir", "rmdir"],
  network_fetch: ["fetch", "crawl", "http", "web_request", "search_web", "url"],
  browser_control: ["browser", "computer_use", "click", "type", "screenshot", "navigate"],
  credential_access: ["secret", "credential", "token", "ssh_key", "wallet", "password"],
  system_control: ["systemctl", "launchctl", "service_restart", "install_package", "firewall", "reboot", "shutdown"],
  physical_world: ["robot", "drone", "actuator", "iot_control", "medical_device", "industrial_control"],
  regulated_decision: ["credit_score", "hire", "employment", "benefit_eligibility", "diagnose", "triage_patient"],
};

const SAFE_SANDBOX_PROFILES = new Set(["1", "true", "strict", "container", "sandbox"]);

export function toolRiskLabel(toolName: string): string {
  const safe = toolName.toLowerCase().replace(/[^a-z0-9_:-]/g, "_");
  for (const [label, needles] of Object.entries(TOOL_RISK_KEYWORDS)) {
    if (needles.some((needle) => safe === needle || safe.includes(needle))) return label;
  }
  return "benign_read";
}

export interface McpToolPolicyConfig {
  allowDangerousTools?: boolean;
  authzPolicy?: string;
  sandboxProfile?: string;
  auditRedaction?: boolean;
}

export class McpToolPolicy {
  readonly allowDangerousTools: boolean;
  readonly authzPolicy: string;
  readonly sandboxProfile: string;
  readonly auditRedaction: boolean;

  constructor(cfg: McpToolPolicyConfig = {}) {
    this.allowDangerousTools = cfg.allowDangerousTools ?? false;
    this.authzPolicy = (cfg.authzPolicy ?? "").trim();
    this.sandboxProfile = (cfg.sandboxProfile ?? "").trim();
    this.auditRedaction = cfg.auditRedaction ?? false;
  }

  get dangerousReady(): boolean {
    return this.allowDangerousTools && this.authzPolicy.length > 0
      && SAFE_SANDBOX_PROFILES.has(this.sandboxProfile.toLowerCase()) && this.auditRedaction;
  }

  allows(toolName: string): boolean {
    return toolRiskLabel(toolName) === "benign_read" || this.dangerousReady;
  }

  receipt(toolName: string, decision: string, argumentCount = 0): Record<string, unknown> {
    return {
      tool_name: toolName.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 96),
      tool_risk: toolRiskLabel(toolName),
      decision,
      authz_policy: this.authzPolicy || null,
      sandbox_profile: this.sandboxProfile || null,
      audit_redacted: this.auditRedaction,
      argument_count: Math.max(0, Math.trunc(argumentCount)),
      argument_content: "excluded",
    };
  }
}

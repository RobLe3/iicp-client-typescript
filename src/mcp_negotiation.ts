// SPDX-License-Identifier: Apache-2.0
/** MCP protocol-era negotiation and stateless request helpers. */

export const LEGACY_MCP_REVISION = "2025-11-25" as const;
export const MODERN_MCP_REVISION = "2026-07-28" as const;
export const SUPPORTED_MCP_REVISIONS = [LEGACY_MCP_REVISION, MODERN_MCP_REVISION] as const;
const SUPPORTED_EXTENSIONS = new Set(["tasks", "skills", "apps"]);

export class McpNegotiationError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

export function evaluateMcpEra(input: Record<string, unknown>): Record<string, unknown> {
  if (input["downstream_credential_source"] === "caller") return { accepted: false, reason: "credential_passthrough_prohibited" };
  if (input["server_identity_matches_selected_endpoint"] === false) return { accepted: false, reason: "server_identity_mismatch" };
  if (input["modern_request_failed"] && !input["legacy_authentication_available"]) return { accepted: false, reason: "unauthenticated_downgrade" };
  const extension = input["extension"];
  if (typeof extension === "string" && !SUPPORTED_EXTENSIONS.has(extension)) return { accepted: false, reason: "unsupported_extension" };
  const offered = input["offered_revision"];
  if (offered === MODERN_MCP_REVISION) {
    if (input["protocol_header_present"] === false) return { accepted: false, reason: "missing_protocol_version" };
    if (input["method_header_matches"] === false || input["name_header_matches"] === false) return { accepted: false, reason: "header_body_mismatch" };
    if (input["reserved_meta_valid"] === false) return { accepted: false, reason: "malformed_reserved_metadata" };
    const peer = Array.isArray(input["peer_supported_revisions"]) ? input["peer_supported_revisions"] as unknown[] : [];
    if (peer.length === 0 || peer.includes(MODERN_MCP_REVISION)) {
      return input["request_state_explicit"]
        ? { accepted: true, state_source: "request" }
        : { accepted: true, era: "modern", session_mode: "stateless" };
    }
    if (peer.includes(LEGACY_MCP_REVISION) && input["legacy_revision_explicitly_offered"] && input["security_requirements_preserved"])
      return { accepted: true, era: "legacy", reason: "explicit_mutual_downgrade" };
    return { accepted: false, reason: "unsupported_revision" };
  }
  if (offered === LEGACY_MCP_REVISION) {
    const peer = Array.isArray(input["peer_supported_revisions"]) ? input["peer_supported_revisions"] as unknown[] : [];
    if (peer.length === 0 || peer.includes(LEGACY_MCP_REVISION)) return { accepted: true, era: "legacy", session_mode: "negotiated" };
  }
  return { accepted: false, reason: "unsupported_revision" };
}

export function buildModernMcpRequest(input: {
  requestId: number; method: string; name: string; params: Record<string, unknown>;
  clientName?: string; extensions?: string[]; requestState?: Record<string, unknown>;
}): { headers: Record<string, string>; body: Record<string, unknown> } {
  const extensions = input.extensions ?? [];
  if (extensions.some((extension) => !SUPPORTED_EXTENSIONS.has(extension))) throw new McpNegotiationError("unsupported_extension");
  const meta: Record<string, unknown> = {
    protocolVersion: MODERN_MCP_REVISION,
    client: { name: input.clientName ?? "iicp-gateway" },
  };
  if (extensions.length) meta["extensions"] = extensions;
  if (input.requestState) meta["requestState"] = input.requestState;
  return {
    headers: { "MCP-Protocol-Version": MODERN_MCP_REVISION, "Mcp-Method": input.method, "Mcp-Name": input.name },
    body: { jsonrpc: "2.0", id: input.requestId, method: input.method, params: { ...input.params, _meta: meta } },
  };
}

export function validateModernMcpResponse(data: Record<string, unknown>, expectedServerName: string): void {
  const meta = data["_meta"] as Record<string, unknown> | undefined;
  if (!meta || meta["protocolVersion"] !== MODERN_MCP_REVISION) throw new McpNegotiationError("malformed_reserved_metadata");
  const server = meta["server"] as Record<string, unknown> | undefined;
  if (!server || server["name"] !== expectedServerName) throw new McpNegotiationError("server_identity_mismatch");
}

// SPDX-License-Identifier: Apache-2.0
/** Deterministic provider-node recovery helpers. */

export const RECOVERY_EXIT_CODE = 76;
export const DEFAULT_RECOVERY_GRACE_CHECKS = 3;
export const DEFAULT_RECOVERY_CHECK_EVERY_HEARTBEATS = 2;

export type RecoveryState =
  | "healthy"
  | "local_unhealthy"
  | "backend_attention"
  | "route_mismatch"
  | "tunnel_cooling_down"
  | "directory_absent"
  | "limited_reach"
  | "restart_recommended"
  | "unknown";

export type RecoveryAction =
  | "none"
  | "reregister"
  | "wait_cooldown"
  | "mark_unavailable"
  | "restart_self"
  | "operator_endpoint_needed"
  | "backend_attention";

export type DirectoryPresence = "present" | "absent" | "unknown";

export interface RegistryRouteStatus {
  presence: DirectoryPresence;
  routeNeedsPromotion: boolean;
}

export function nodeRegistryPrefix(nodeId: string): string {
  const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(nodeId);
  return isUuid ? nodeId.slice(0, 8) : nodeId;
}

export function envGraceChecks(): number {
  const parsed = Number.parseInt(process.env.IICP_RECOVERY_GRACE_CHECKS ?? `${DEFAULT_RECOVERY_GRACE_CHECKS}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RECOVERY_GRACE_CHECKS;
}

export function envCheckEveryHeartbeats(): number {
  const parsed = Number.parseInt(process.env.IICP_RECOVERY_CHECK_EVERY_HEARTBEATS ?? `${DEFAULT_RECOVERY_CHECK_EVERY_HEARTBEATS}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RECOVERY_CHECK_EVERY_HEARTBEATS;
}

export function supervisedRecoveryEnabled(): boolean {
  const supervised = ["1", "true", "yes"].includes((process.env.IICP_SUPERVISED ?? "").trim().toLowerCase());
  const disabled = ["0", "false", "no", "off"].includes((process.env.IICP_RECOVERY_SUPERVISED_EXIT ?? "").trim().toLowerCase());
  return supervised && !disabled;
}

export function classifyRecovery(opts: {
  localHealthOk: boolean;
  publicAvailable: boolean;
  directoryPresence: DirectoryPresence;
  consecutiveFailures: number;
  graceChecks: number;
  backendAttention?: boolean;
}): { state: RecoveryState; action: RecoveryAction } {
  if (!opts.localHealthOk) return { state: "local_unhealthy", action: "restart_self" };
  if (opts.backendAttention) return { state: "backend_attention", action: "backend_attention" };
  if (!opts.publicAvailable) {
    if (opts.consecutiveFailures >= opts.graceChecks) return { state: "restart_recommended", action: "restart_self" };
    return { state: "limited_reach", action: "wait_cooldown" };
  }
  if (opts.directoryPresence === "present") return { state: "healthy", action: "none" };
  if (opts.directoryPresence === "absent") {
    if (opts.consecutiveFailures >= opts.graceChecks) return { state: "route_mismatch", action: "restart_self" };
    return { state: "directory_absent", action: "reregister" };
  }
  return { state: "unknown", action: "none" };
}

/** A relay counts only after its worker session has completed a bind handshake. */
export function effectivePublicRouteAvailable(opts: {
  runtimeAvailable: boolean;
  routeNeedsPromotion: boolean;
  relayBound: boolean;
}): boolean {
  return opts.runtimeAvailable && (opts.relayBound || !opts.routeNeedsPromotion);
}

export async function registryNodePresence(
  directoryUrl: string,
  nodeId: string,
  timeoutMs = 5_000,
): Promise<DirectoryPresence> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${directoryUrl.replace(/\/+$/, "")}/v1/registry/nodes/${nodeRegistryPrefix(nodeId)}`, {
      signal: controller.signal,
    });
    if (resp.ok) return "present";
    if (resp.status === 404) return "absent";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

export function routeNeedsPromotionFromRegistryJson(data: unknown): boolean {
  const root = isRecord(data) && isRecord(data.node) ? data.node : data;
  if (!isRecord(root)) return false;
  const summary = isRecord(root.status_summary) ? root.status_summary : {};

  if (summary.state === "direct_unverified") return true;

  const routeEvidence =
    typeof root.route_evidence === "string"
      ? root.route_evidence
      : typeof summary.evidence_source === "string"
        ? summary.evidence_source
        : undefined;
  const routingHint =
    typeof root.routing_hint === "string"
      ? root.routing_hint
      : typeof summary.routing_hint === "string"
        ? summary.routing_hint
        : undefined;
  const browserUsable =
    typeof root.browser_usable === "boolean"
      ? root.browser_usable
      : typeof summary.browser_usable === "boolean"
        ? summary.browser_usable
        : undefined;

  return routingHint === "http_ipv6" && routeEvidence !== "directory_observed" && browserUsable !== true;
}

export async function registryRouteStatus(
  directoryUrl: string,
  nodeId: string,
  timeoutMs = 5_000,
): Promise<RegistryRouteStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${directoryUrl.replace(/\/+$/, "")}/v1/registry/nodes/${nodeRegistryPrefix(nodeId)}`, {
      signal: controller.signal,
    });
    if (resp.ok) {
      let data: unknown = {};
      try {
        data = await resp.json();
      } catch {
        data = {};
      }
      return { presence: "present", routeNeedsPromotion: routeNeedsPromotionFromRegistryJson(data) };
    }
    if (resp.status === 404) return { presence: "absent", routeNeedsPromotion: false };
    return { presence: "unknown", routeNeedsPromotion: false };
  } catch {
    return { presence: "unknown", routeNeedsPromotion: false };
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

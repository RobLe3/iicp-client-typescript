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

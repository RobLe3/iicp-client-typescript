// SPDX-License-Identifier: Apache-2.0
/**
 * Trust auditor — cross-node declaration consistency check (parity Block E, #340).
 *
 * Port of iicp-adapter `services/trust_auditor.py` (#118). Discovers active peers via the
 * directory, probes each peer's `/iicp/health`, and verifies the directory-registered
 * models actually appear in the peer's live health response. Missing models are a
 * "declaration divergence" reported to `/v1/audit-report`.
 *
 * Opt-in background capability (call `runAuditPass` on a timer); not in the request hot
 * path. The pure `modelsDiverge` helper is the unit-testable core.
 */

const DISCOVER_INTENT = "urn:iicp:intent:llm:chat:v1";
const PROBE_TIMEOUT_MS = 5000;
const DISCOVER_TIMEOUT_MS = 8000;
const AUDIT_REPORT_TIMEOUT_MS = 5000;

/** Registered models absent from the peer's health response (empty == consistent). */
export function modelsDiverge(registered: string[], health: string[]): string[] {
  const h = new Set(health);
  return registered.filter((m) => !h.has(m));
}

export interface NodeAuditResult {
  node_id: string;
  endpoint: string;
  passed: boolean;
  health_reachable: boolean;
  declared_models_match: boolean;
  registered_models: string[];
  health_models: string[];
  latency_ms: number | null;
  detail: string;
}

export interface AuditReport {
  run_at: string;
  nodes_probed: number;
  nodes_passed: number;
  nodes_failed: number;
  results: NodeAuditResult[];
}

interface DiscoveredNode {
  node_id?: string;
  endpoint?: string;
  operator_url?: string;
  models?: string[];
}

async function discoverPeers(directoryUrl: string, ownNodeId: string): Promise<DiscoveredNode[]> {
  try {
    const url = `${directoryUrl.replace(/\/$/, "")}/v1/discover?intent=${encodeURIComponent(DISCOVER_INTENT)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS) });
    if (!resp.ok) return [];
    const body = (await resp.json()) as { nodes?: DiscoveredNode[] };
    return (body.nodes ?? []).filter((n) => n.node_id !== ownNodeId);
  } catch {
    return [];
  }
}

async function probeNode(node: DiscoveredNode): Promise<NodeAuditResult> {
  const nodeId = node.node_id ?? "unknown";
  const endpoint = node.operator_url ?? node.endpoint ?? "";
  const registered = node.models ?? [];
  const base: NodeAuditResult = {
    node_id: nodeId,
    endpoint,
    passed: false,
    health_reachable: false,
    declared_models_match: false,
    registered_models: registered,
    health_models: [],
    latency_ms: null,
    detail: "",
  };
  if (!endpoint) return { ...base, detail: "no endpoint" };

  const t0 = Date.now();
  try {
    const resp = await fetch(`${endpoint.replace(/\/$/, "")}/iicp/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latency = Date.now() - t0;
    if (!resp.ok) return { ...base, latency_ms: latency, detail: `HTTP ${resp.status}` };
    const health = (await resp.json()) as { models?: string[] };
    const healthModels = health.models ?? [];
    const missing = modelsDiverge(registered, healthModels);
    const ok = missing.length === 0;
    return {
      ...base,
      health_reachable: true,
      declared_models_match: ok,
      passed: ok,
      health_models: healthModels,
      latency_ms: latency,
      detail: ok ? "OK" : `registered ${JSON.stringify(missing)} absent from health`,
    };
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return { ...base, latency_ms: Date.now() - t0, detail: `connection error: ${msg}` };
  }
}

async function reportDivergence(
  directoryUrl: string,
  ownNodeId: string,
  nodeToken: string,
  targetNodeId: string
): Promise<void> {
  if (!ownNodeId || !nodeToken) return;
  try {
    await fetch(`${directoryUrl.replace(/\/$/, "")}/v1/audit-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({
        node_id: ownNodeId,
        target_node_id: targetNodeId,
        finding: "declaration_divergence",
      }),
      signal: AbortSignal.timeout(AUDIT_REPORT_TIMEOUT_MS),
    });
  } catch {
    /* best-effort */
  }
}

/** Discover peers, probe each concurrently, report divergences. One pass. */
export async function runAuditPass(
  directoryUrl: string,
  ownNodeId: string,
  nodeToken = ""
): Promise<AuditReport> {
  const nodes = await discoverPeers(directoryUrl, ownNodeId);
  const runAt = new Date().toISOString();
  if (nodes.length === 0) {
    return { run_at: runAt, nodes_probed: 0, nodes_passed: 0, nodes_failed: 0, results: [] };
  }
  const results = await Promise.all(nodes.map(probeNode));
  for (const r of results) {
    if (r.health_reachable && !r.declared_models_match) {
      await reportDivergence(directoryUrl, ownNodeId, nodeToken, r.node_id);
    }
  }
  return {
    run_at: runAt,
    nodes_probed: results.length,
    nodes_passed: results.filter((r) => r.passed).length,
    nodes_failed: results.filter((r) => !r.passed).length,
    results,
  };
}

// SPDX-License-Identifier: Apache-2.0
/**
 * Self-conformance probes — operator-side health verification.
 *
 * TypeScript port of iicp-client-python's conformance.py (iter-1435).
 * Tier 2 Item 4 of the iicp-adapter → iicp-client migration (#340).
 *
 * Operators run these periodically (or in their /health endpoint) to confirm
 * their hybrid node is fully conformant without depending on the external
 * REACH daemon. Four probes mirror the adapter set:
 *
 *   CONF-REG-01    — node_id + node_token set
 *   CONF-HEALTH-01 — local /iicp/health returns 200 with required schema
 *   CONF-REACH-01  — directory /v1/probe confirms internet reachability
 *   CONF-DISC-01   — own node_id appears in /v1/discover NODELIST
 */

const REQUIRED_HEALTH_FIELDS = new Set(["status", "node_id", "region", "load", "models"]);
const NON_ROUTABLE = ["localhost", "127.0.0.1", "::1", "example.com", "0.0.0.0"];
const DISCOVER_INTENT = "urn:iicp:intent:llm:chat:v1";

export interface ProbeResult {
  testId: string;
  passed: boolean;
  message: string;
  latencyMs: number | null;
}

export interface ConformanceReport {
  passCount: number;
  failCount: number;
  lastRunAt: string;
  tests: ProbeResult[];
}

interface NodeLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _cfg: any;
  // Optional stash for the token; set by runConformanceChecks when caller passes nodeToken.
  _lastToken?: string;
}

// ── Individual probes ────────────────────────────────────────────────────

async function checkRegistered(node: NodeLike): Promise<ProbeResult> {
  const nodeId: string = node._cfg?.nodeId ?? "";
  const token: string = node._lastToken ?? "";
  if (nodeId && token) {
    const short = nodeId.length > 8 ? `${nodeId.slice(0, 8)}…` : nodeId;
    return { testId: "CONF-REG-01", passed: true, message: `Registered (${short})`, latencyMs: null };
  }
  if (nodeId) {
    return {
      testId: "CONF-REG-01",
      passed: true,
      message: `node_id set (${nodeId.slice(0, 8)}…); token not tracked by SDK`,
      latencyMs: null,
    };
  }
  return {
    testId: "CONF-REG-01",
    passed: false,
    message: "node_id empty — register() not yet called",
    latencyMs: null,
  };
}

async function checkHealthSchema(localPort: number): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const resp = await fetch(`http://127.0.0.1:${localPort}/iicp/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const latencyMs = Date.now() - t0;
    if (!resp.ok) {
      return {
        testId: "CONF-HEALTH-01",
        passed: false,
        message: `HTTP ${resp.status}`,
        latencyMs,
      };
    }
    const body = (await resp.json()) as Record<string, unknown>;
    const missing = [...REQUIRED_HEALTH_FIELDS].filter((k) => !(k in body));
    if (missing.length) {
      return {
        testId: "CONF-HEALTH-01",
        passed: false,
        message: `Missing fields: ${JSON.stringify(missing.sort())}`,
        latencyMs,
      };
    }
    return {
      testId: "CONF-HEALTH-01",
      passed: true,
      message: `OK (${latencyMs.toFixed(0)}ms)`,
      latencyMs,
    };
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return { testId: "CONF-HEALTH-01", passed: false, message: `Error: ${msg}`, latencyMs: null };
  }
}

function parseHostPort(endpoint: string): { host: string; port: number } {
  let withoutScheme = endpoint;
  for (const scheme of ["https://", "http://"]) {
    if (endpoint.startsWith(scheme)) {
      withoutScheme = endpoint.slice(scheme.length);
      break;
    }
  }
  const authority = withoutScheme.split("/")[0];
  if (authority.includes(":")) {
    const idx = authority.lastIndexOf(":");
    const host = authority.slice(0, idx);
    const portStr = authority.slice(idx + 1);
    const port = parseInt(portStr, 10);
    return { host, port: Number.isFinite(port) ? port : 443 };
  }
  return {
    host: authority,
    port: endpoint.startsWith("https://") ? 443 : 80,
  };
}

function directoryBase(directoryUrl: string): string {
  const trimmed = directoryUrl.replace(/\/$/, "");
  // The SDK convention bakes /api into directoryUrl; the adapter uses just
  // the host with /api/v1/* paths. Support both.
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

async function checkReachability(node: NodeLike): Promise<ProbeResult> {
  const cfg = node._cfg;
  const endpoint: string = (cfg.endpoint ?? "").replace(/\/$/, "");
  if (!endpoint || NON_ROUTABLE.some((p) => endpoint.includes(p))) {
    return {
      testId: "CONF-REACH-01",
      passed: false,
      message:
        "endpoint is non-routable — external check skipped; see https://iicp.network/docs/port-forwarding",
      latencyMs: null,
    };
  }

  const { host, port } = parseHostPort(endpoint);
  const probeUrl = `${directoryBase(cfg.directoryUrl)}/v1/probe?host=${encodeURIComponent(host)}&port=${port}`;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch(probeUrl, { signal: ctrl.signal });
    clearTimeout(t);
    const latencyMs = Date.now() - t0;
    if (!resp.ok) {
      return {
        testId: "CONF-REACH-01",
        passed: false,
        message: `HTTP ${resp.status}`,
        latencyMs,
      };
    }
    const body = (await resp.json()) as { reachable?: boolean; error?: string };
    if (body.reachable) {
      return {
        testId: "CONF-REACH-01",
        passed: true,
        message: `Reachable (${latencyMs.toFixed(0)}ms)`,
        latencyMs,
      };
    }
    return {
      testId: "CONF-REACH-01",
      passed: false,
      message: String(body.error ?? "not reachable"),
      latencyMs,
    };
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return {
      testId: "CONF-REACH-01",
      passed: false,
      message: `Probe unavailable: ${msg}`,
      latencyMs: null,
    };
  }
}

async function checkDiscoverSelf(node: NodeLike): Promise<ProbeResult> {
  const cfg = node._cfg;
  const nodeId: string = cfg.nodeId ?? "";
  if (!nodeId) {
    return {
      testId: "CONF-DISC-01",
      passed: false,
      message: "No node_id — register() not yet called",
      latencyMs: null,
    };
  }
  const discoverUrl = `${directoryBase(cfg.directoryUrl)}/v1/discover?intent=${encodeURIComponent(DISCOVER_INTENT)}`;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(discoverUrl, { signal: ctrl.signal });
    clearTimeout(t);
    const latencyMs = Date.now() - t0;
    if (!resp.ok) {
      return {
        testId: "CONF-DISC-01",
        passed: false,
        message: `HTTP ${resp.status}`,
        latencyMs,
      };
    }
    const body = (await resp.json()) as { nodes?: Array<{ node_id?: string }> };
    const nodes: Array<{ node_id?: string }> = body.nodes ?? [];
    if (nodes.some((n) => n.node_id === nodeId)) {
      return {
        testId: "CONF-DISC-01",
        passed: true,
        message: `Found in NODELIST (${nodes.length} nodes)`,
        latencyMs,
      };
    }
    return {
      testId: "CONF-DISC-01",
      passed: false,
      message: `node_id absent from NODELIST (got ${nodes.length} nodes)`,
      latencyMs,
    };
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return {
      testId: "CONF-DISC-01",
      passed: false,
      message: `Discover error: ${msg}`,
      latencyMs: null,
    };
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Run the four conformance probes concurrently and return a report.
 * Pass `nodeToken` to make CONF-REG-01 verify the token in addition to node_id.
 */
export async function runConformanceChecks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: any,
  localPort: number = 8080,
  opts: { nodeToken?: string } = {}
): Promise<ConformanceReport> {
  if (opts.nodeToken !== undefined) {
    (node as NodeLike)._lastToken = opts.nodeToken;
  }
  const results = await Promise.all([
    checkRegistered(node),
    checkHealthSchema(localPort),
    checkReachability(node),
    checkDiscoverSelf(node),
  ]);
  return {
    passCount: results.filter((r) => r.passed).length,
    failCount: results.filter((r) => !r.passed).length,
    lastRunAt: new Date().toISOString(),
    tests: results,
  };
}

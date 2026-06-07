// SPDX-License-Identifier: Apache-2.0
/**
 * CIP consumer dispatch gates (S.12 §2.2) — TS port of iicp_client.proxy.cip
 * (gates.py + dispatch.py). Decides LOCAL / REMOTE / ERROR for a cooperative-inference
 * request and surfaces the two structured errors the proxy maps to HTTP status:
 *   CIPInsufficientCredits → IICP-E036 → 402
 *   CIPNoEligibleWorkers   → IICP-E022 → 503
 *
 * Faithful to the Python reference (full-parity, #482b). The gateway pure-consumer path
 * passes no local node_list, so Gate 4 (local-first loopback preference) is skipped.
 */

const VALID_CIP_POLICIES = new Set(["best_of_n", "majority_vote", "map_reduce"]);
const REALTIME_QOS = new Set(["realtime"]);

export type CipStrategy = "local-first" | "remote-first" | "balanced";

export interface CipConfig {
  enabled: boolean;
  strategy: CipStrategy;
  maxCreditsPerTask: number;
  sessionCreditBudget: number | null;
  sendSensitivePrompts: boolean;
  trustedPeers: string[];
  minReputation: number;
}

export class CIPInsufficientCredits extends Error {
  readonly code: string;
  constructor(code = "IICP-E036") {
    super(`CIP insufficient credits (${code})`);
    this.name = "CIPInsufficientCredits";
    this.code = code;
  }
}

export class CIPNoEligibleWorkers extends Error {
  readonly code: string;
  constructor(code = "IICP-E022") {
    super(`CIP no eligible workers (${code})`);
    this.name = "CIPNoEligibleWorkers";
    this.code = code;
  }
}

export type DispatchResult = "local" | "remote" | "error";
export interface DispatchDecision {
  result: DispatchResult;
  errorCode?: string;
  cipSessionKey?: string;
}

/** Parse-time validation of cip.policy / cip.replicas / cip.quorum (S.12 §5.2). */
export function validateCipRequestFields(body: Record<string, unknown>): string | null {
  const cip = body.cip;
  if (cip === null || typeof cip !== "object" || Array.isArray(cip)) return null;
  const c = cip as Record<string, unknown>;

  const policy = c.policy;
  if (policy !== undefined && policy !== null && !VALID_CIP_POLICIES.has(String(policy))) return "IICP-E028";

  const replicas = c.replicas;
  if (replicas !== undefined && replicas !== null) {
    if (!Number.isInteger(replicas) || (replicas as number) < 1 || (replicas as number) > 10) return "IICP-E028";
    if (policy === "majority_vote" && (replicas as number) % 2 === 0) return "IICP-E025";
  }

  const quorum = c.quorum;
  if (quorum !== undefined && quorum !== null) {
    if (!Number.isInteger(quorum) || (quorum as number) < 1) return "IICP-E028";
    const effReplicas = Number.isInteger(replicas) ? (replicas as number) : 1;
    if ((quorum as number) > effReplicas) return "IICP-E028";
  }
  return null;
}

function blockedRemote(config: CipConfig, errorCode: string): DispatchDecision {
  // local-first runs locally (graceful); other strategies surface the structured error.
  if (config.strategy === "local-first") return { result: "local" };
  return { result: "error", errorCode };
}

export interface DecideDispatchArgs {
  estimatedCredits: number;
  sensitivity?: string | null;
  eligibleWorkers: string[];
  config: CipConfig;
  replicas?: number;
  consumerBalance?: number | null;
  sessionSpent?: number;
}

/** Evaluate the §2.2 normative gates → dispatch decision (port of gates.decide_dispatch). */
export function decideDispatch(args: DecideDispatchArgs): DispatchDecision {
  const { estimatedCredits, sensitivity, eligibleWorkers, config } = args;
  const replicas = args.replicas ?? 1;
  const consumerBalance = args.consumerBalance ?? null;
  const sessionSpent = args.sessionSpent ?? 0;

  // Gate 1 — not enabled → local.
  if (!config.enabled) return { result: "local" };

  // Gates 2a–2c — affordability.
  if (estimatedCredits > config.maxCreditsPerTask) return { result: "local" };
  if (config.sessionCreditBudget !== null && sessionSpent + estimatedCredits > config.sessionCreditBudget) {
    return { result: "local" };
  }
  if (consumerBalance !== null && estimatedCredits > consumerBalance) {
    return blockedRemote(config, "IICP-E036");
  }

  // Gate 3 — sensitivity opt-in.
  if (sensitivity === "high" && !config.sendSensitivePrompts) return { result: "local" };

  // Gate 4 (local-first loopback preference) is skipped — the proxy is a pure consumer.

  // Gate 5/6 — eligible worker count must satisfy the replica requirement.
  if (eligibleWorkers.length < Math.max(replicas, 1)) {
    if (config.strategy === "local-first") return { result: "local" };
    return { result: "error", errorCode: "IICP-E022" };
  }

  return { result: "remote", cipSessionKey: `cip-sess-${args.estimatedCredits}-${Math.random().toString(36).slice(2, 10)}` };
}

/** Build the cip envelope object for a CALL body from a REMOTE decision (CIP-CALL-01). */
export function buildCipEnvelope(decision: DispatchDecision, parentTaskId: string): Record<string, string> | null {
  if (decision.result !== "remote" || !decision.cipSessionKey) return null;
  return { cip_role: "worker", cip_session_key: decision.cipSessionKey, cip_parent_task_id: parentTaskId };
}

interface CipNode {
  node_id?: string;
  allow_remote_inference?: boolean;
  reputation_score?: number;
}

/**
 * Evaluate CIP consumer gates and build the dispatch envelope (port of
 * dispatch.compute_cip_envelope). Returns null for LOCAL/disabled/invalid; throws
 * CIPInsufficientCredits (E036) / CIPNoEligibleWorkers (E022) for the blocking errors.
 */
export function computeCipEnvelope(
  nodes: CipNode[],
  body: Record<string, unknown>,
  config: CipConfig | null,
  taskId: string,
  qos?: string | null,
  consumerBalance?: number | null,
): Record<string, string> | null {
  if (!config || !config.enabled || (qos != null && REALTIME_QOS.has(qos))) return null;
  if (validateCipRequestFields(body) !== null) return null; // invalid cip fields → local fallback

  let eligible = nodes
    .filter((n) => n.allow_remote_inference && n.node_id && (n.reputation_score ?? 0) >= config.minReputation)
    .map((n) => n.node_id as string);
  if (config.trustedPeers.length > 0) {
    const trusted = new Set(config.trustedPeers);
    eligible = eligible.filter((id) => trusted.has(id));
  }

  const cip = body.cip as Record<string, unknown> | undefined;
  const replicas = cip && typeof cip === "object" ? Number(cip.replicas ?? 1) : 1;

  const decision = decideDispatch({
    estimatedCredits: 1.0,
    sensitivity: (body.sensitivity as string | undefined) ?? null,
    eligibleWorkers: eligible,
    config,
    replicas,
    consumerBalance: consumerBalance ?? null,
  });

  if (decision.result === "error" && decision.errorCode === "IICP-E036") throw new CIPInsufficientCredits(decision.errorCode);
  if (decision.result === "error" && decision.errorCode === "IICP-E022") throw new CIPNoEligibleWorkers(decision.errorCode);
  return buildCipEnvelope(decision, taskId);
}

/** Load CIP config from IICP_PROXY_CIP_* env (enabled defaults OFF — §2.2 ¶1). */
export function cipConfigFromEnv(): CipConfig {
  const env = process.env;
  const truthy = (v: string | undefined) => ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());
  const strat = (env.IICP_PROXY_CIP_STRATEGY ?? "local-first").trim() as CipStrategy;
  return {
    enabled: truthy(env.IICP_PROXY_CIP_ENABLED),
    strategy: ["local-first", "remote-first", "balanced"].includes(strat) ? strat : "local-first",
    maxCreditsPerTask: Number(env.IICP_PROXY_CIP_MAX_CREDITS_PER_TASK ?? 10) || 10,
    sessionCreditBudget: env.IICP_PROXY_CIP_SESSION_CREDIT_BUDGET ? Number(env.IICP_PROXY_CIP_SESSION_CREDIT_BUDGET) : null,
    sendSensitivePrompts: truthy(env.IICP_PROXY_CIP_SEND_SENSITIVE_PROMPTS),
    trustedPeers: (env.IICP_PROXY_CIP_TRUSTED_PEERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    minReputation: Number(env.IICP_PROXY_CIP_MIN_REPUTATION ?? 0) || 0,
  };
}

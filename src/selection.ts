/** Client-local candidate selection helpers. */
import { createHash } from "node:crypto";

import type { Node, TaskRequest } from "./types.js";

export const CANDIDATE_EVIDENCE_SCHEMA_V0 = "iicp-candidate-evidence-v0" as const;
export type RankerMode = "normal" | "exploration";

export interface CandidateEvidenceV0 {
  readonly schema_version: typeof CANDIDATE_EVIDENCE_SCHEMA_V0;
  readonly candidate_ref: string;
  readonly models: readonly string[];
  readonly directory_score: number;
  readonly load: number;
  readonly health_label?: string;
  readonly directory_observed_reachable?: boolean | null;
}

export interface RankerRequest {
  readonly request_ref: string;
  readonly intent: string;
  /** Remains in process; the SDK never serializes or transmits it automatically. */
  readonly request: Readonly<TaskRequest>;
}

export interface RankerDecision {
  readonly candidate_ref: string;
  readonly policy_id: string;
  readonly mode: RankerMode;
}

export interface CandidateRanker {
  rank(
    request: RankerRequest,
    candidates: readonly CandidateEvidenceV0[],
  ): RankerDecision | undefined | Promise<RankerDecision | undefined>;
}

export interface AppliedRanker {
  readonly candidates: Node[];
  readonly decision?: RankerDecision;
}

function opaqueRef(domain: "candidate" | "request", value: string): string {
  return createHash("sha256").update(`iicp:${domain}:v0\n${value}`).digest("hex");
}

function candidateEvidenceV0(node: Node): CandidateEvidenceV0 {
  return Object.freeze({
    schema_version: CANDIDATE_EVIDENCE_SCHEMA_V0,
    candidate_ref: opaqueRef("candidate", node.node_id),
    models: Object.freeze([...(node.models ?? [])]),
    directory_score: node.score,
    load: node.load ?? 0,
    health_label: node.health_label,
    directory_observed_reachable: node.directory_observed_reachable,
  });
}

function validatePolicyId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error("candidate ranker policy_id must be 1-64 ASCII letters, digits, '.', '_' or '-'");
  }
}

export async function applyCandidateRanker(
  ranker: CandidateRanker,
  request: TaskRequest,
  taskId: string,
  eligible: Node[],
  builtInOrder: Node[],
  limit: number,
): Promise<AppliedRanker> {
  const evidence = Object.freeze(eligible.map(candidateEvidenceV0));
  const context: RankerRequest = Object.freeze({
    request_ref: opaqueRef("request", taskId),
    intent: request.intent,
    request,
  });
  const decision = await ranker.rank(context, evidence);
  if (decision === undefined) return { candidates: builtInOrder };
  if (!decision || typeof decision.candidate_ref !== "string" || typeof decision.policy_id !== "string") {
    throw new Error("candidate ranker returned an invalid decision");
  }
  validatePolicyId(decision.policy_id);
  if (decision.mode !== "normal" && decision.mode !== "exploration") {
    throw new Error("candidate ranker mode must be normal or exploration");
  }
  const selectedIndex = evidence.findIndex((candidate) => candidate.candidate_ref === decision.candidate_ref);
  if (selectedIndex < 0) {
    throw new Error("candidate ranker selected a reference outside the eligible candidate set");
  }
  const selected = eligible[selectedIndex];
  const candidates = [selected, ...builtInOrder.filter((candidate) => candidate.node_id !== selected.node_id)].slice(0, limit);
  return { candidates, decision };
}

export function rankerReceiptProfile(decision: RankerDecision, selectedCandidateIndex: number): string {
  const mode = selectedCandidateIndex === 0 ? decision.mode : "fallback";
  return `external_ranker/${decision.policy_id}/${mode}`;
}

/** Opt-in, deterministic-testable `iicp.selection.v1` candidate ordering. */
export type SelectableNode = { node_id: string; score: number; load?: number };
export function weightedV1Order<T extends SelectableNode>(nodes: T[], maxRetries: number, randomValue: number, topK = 3): T[] {
  if (nodes.length <= 1) return nodes.slice(0, maxRetries);
  const pool = nodes.slice(0, Math.max(1, Math.min(nodes.length, topK)));
  const weights = pool.map((node) => Math.max(node.score, 0.01) / (1 + Math.max(0, Math.min(node.load ?? 0, 1))));
  let remaining = Math.max(0, Math.min(randomValue, 0.999999999)) * weights.reduce((sum, weight) => sum + weight, 0);
  let chosen = pool[pool.length - 1];
  for (let i = 0; i < pool.length; i++) { remaining -= weights[i]; if (remaining <= 0) { chosen = pool[i]; break; } }
  return [chosen, ...nodes.slice(0, maxRetries).filter((node) => node.node_id !== chosen.node_id)].slice(0, maxRetries);
}

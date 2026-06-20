/** IICP TypeScript SDK — type definitions (ADR-016 §1) */

export interface ClientConfig {
  /** Directory URL base (with /api suffix). Default: https://iicp.network/api */
  directory_url: string;
  /** Request timeout in ms. Max 120 000 (SDK-04). Default: 30 000 */
  timeout_ms: number;
  /** Preferred region for node selection. */
  region?: string;
  /** Bearer token for authenticated routes. */
  api_token?: string;
  /** Verify TLS certificates. Default: true */
  tls_verify: boolean;
  /** IICP-CX S.16: encrypt task payloads when node advertises cx_public_key. Default: false */
  use_confidentiality?: boolean;
  /** ε-greedy exploration probability for provider selection (R4). Default: 0.05. Override: IICP_ROUTING_EPSILON */
  routing_epsilon?: number;
  /** Phase 2 (#496): caller's JWT from directory registration, used to acquire consumer tokens. */
  node_token?: string;
}

export interface TaskConstraints {
  region?: string;
  qos?: string;
  timeout_ms?: number;
  min_reputation?: number;
}

export interface TaskAuth {
  token: string;
  mode?: "bearer" | "node";
}

export interface TaskMetrics {
  latency_ms?: number;
  tokens_used?: number;
  node_id?: string;
}

export interface TaskRequest {
  /** Intent URN — must match urn:iicp:intent:* (SDK-02) */
  intent: string;
  payload: Record<string, unknown>;
  constraints?: TaskConstraints;
  auth?: TaskAuth;
  task_id?: string;
  /** #488 — querying node identity for self-query neutrality at the directory. */
  source_node_id?: string;
}

export interface TaskResponse {
  task_id: string;
  result: unknown;
  status: string;
  metrics?: TaskMetrics;
}

export interface DiscoverOptions {
  limit?: number;
  region?: string;
  qos?: string;
  min_reputation?: number;
}

export interface CxPublicKey {
  algorithm: string;
  encoding?: string;
  key: string;
  key_id: string;
}

export interface Node {
  node_id: string;
  endpoint: string;
  score: number;
  available: boolean;
  region: string;
  latency_estimate_ms?: number;
  reputation_score?: number;
  // ADR-044 composed health label + ADR-043 8-category network exposure.
  // Optional: present only when the directory is on v1.10.0+.
  health_label?: string;
  exposure_mode?: string;
  // IICP-CX S.16 §3.1 — X25519 public key for E2E payload confidentiality.
  cx_public_key?: CxPublicKey;
  // #397 — transport protocols the node speaks (e.g. ["https","iicp-native"]).
  transport?: string[];
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatResponse {
  id: string;
  choices: ChatChoice[];
  usage?: ChatUsage;
  node_id?: string;
}

export interface ChatOptions {
  intent?: string;
  region?: string;
  timeout_ms?: number;
  min_reputation?: number;
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

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
  /** Selection strategy. Default: epsilon. `weighted_v1` is opt-in. Override: IICP_ROUTING_STRATEGY */
  routing_strategy?: "deterministic" | "epsilon" | "softmax_top_k" | "weighted_v1";
  /** Candidate pool for softmax_top_k. Default: 3. Override: IICP_ROUTING_TOP_K */
  routing_top_k?: number;
  /** Softmax temperature for softmax_top_k. Default: 0.04. Override: IICP_ROUTING_SOFTMAX_TAU */
  routing_softmax_tau?: number;
  /** Phase 2 (#496): caller's JWT from directory registration, used to acquire consumer tokens. */
  node_token?: string;
  /** Directory-issued consumer identity policy. Default: optional. */
  consumer_auth_mode?: "optional" | "required" | "disabled";
  /** Phase 6 (#585): default client-side policy evaluated before remote prompt dispatch. */
  routing_policy?: RoutingPolicy;
  /** Route endpoint migration mode. Default: auto. */
  route_discovery_mode?: "auto" | "ticketed" | "legacy";
  /** Optional profile request used by legacy discovery before task dispatch. */
  profile_request?: ProfileRequest;
}

export interface TaskConstraints {
  region?: string;
  qos?: string;
  timeout_ms?: number;
  min_reputation?: number;
  model?: string;
}

/** Prompt-free criteria used only for provider discovery and selection. */
export interface RouteConstraints {
  region?: string;
  qos?: string;
  model?: string;
  min_reputation?: number;
  browser_usable_only?: boolean;
  profile_request?: ProfileRequest;
  limit?: number;
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
  route_constraints?: RouteConstraints;
  auth?: TaskAuth;
  task_id?: string;
  /** #488 — querying node identity for self-query neutrality at the directory. */
  source_node_id?: string;
  /** Phase 6 (#585): optional per-request remote-routing policy override. */
  routing_policy?: RoutingPolicy;
}

export interface TaskResponse {
  task_id: string;
  result: unknown;
  status: string;
  metrics?: TaskMetrics;
  generated_by_ai?: boolean;
  dispatch_ticket_id_prefix?: string;
  routing_receipt?: RoutingReceipt;
}

/** Local-only metadata; task content, endpoints and tokens are excluded. */
export interface RoutingReceipt {
  receipt_version: "iicp-routing-receipt-v1";
  selection_profile: string;
  eligible_candidate_count: number;
  selected_node_id_prefix: string;
  profile_negotiation?: ProfileNegotiation;
  redaction: "prompt_response_endpoint_token_excluded";
}

export interface DiscoverOptions {
  limit?: number;
  region?: string;
  qos?: string;
  min_reputation?: number;
  model?: string;
  /** Browser-like consumers: keep only HTTPS/loopback endpoints. Native default: false. */
  browser_usable_only?: boolean;
  /** Optional additive pre-normative directory profile negotiation. */
  profile_request?: ProfileRequest;
}

export interface ProfileRequest {
  profile_id: string;
  profile_version: string;
  profile_fixture_sha256: string;
  required?: boolean;
}

export interface ProfileNegotiation {
  requested: boolean;
  status?: "compatible" | "unsupported";
  reason?: "compatible" | "unsupported_pre_normative_profile";
  dispatch_allowed?: boolean;
}

export interface DiscoveryResult {
  nodes: Node[];
  profile_negotiation?: ProfileNegotiation;
  diversity_evidence?: Record<string, unknown>;
}

export interface CxPublicKey {
  algorithm: string;
  encoding?: string;
  key: string;
  key_id: string;
  features?: string[];
}

export interface NodePolicyManifest {
  version?: string | null;
  jurisdiction?: string | null;
  policy_url?: string | null;
  contact_url?: string | null;
  remote_executor_can_read_prompt?: boolean;
  training_use?: "none" | "opt_in" | "provider_defined" | string;
  retention?: Record<string, unknown>;
  subprocessors?: string[];
  unsupported_intents?: string[];
  signed_statement?: string | null;
  manifest_identity_level?: "self_attested" | "signed_valid" | "operator_bound" | "known_operator" | "rotated" | "revoked" | string | null;
  verification?: {
    status?: "self_attested" | "signed_valid" | "signed_invalid" | "signed_expired" | "signed_revoked" | string;
    algorithm?: string | null;
    key_id?: string | null;
    signed_at?: string | null;
    expires_at?: string | null;
    canonical_sha256?: string | null;
    public_key_sha256?: string | null;
    error?: string | null;
  };
  evidence?: string;
  [key: string]: unknown;
}

export interface Node {
  node_id: string;
  endpoint: string;
  score: number;
  load?: number;
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
  // Additive routing-signal split from directory v1.10.50+.
  directory_observed_reachable?: boolean | null;
  route_evidence?: string;
  routing_hint?: string;
  browser_usable?: boolean;
  latency_evidence?: Record<string, unknown>;
  health_reasons?: Array<Record<string, unknown>>;
  trust_progress?: Record<string, unknown>;
  sdk_release?: Record<string, unknown>;
  /** Phase-1 compliance: public, self-attested node policy manifest. */
  node_policy_manifest?: NodePolicyManifest | null;
  dispatch_ticket_id_prefix?: string;
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
  generated_by_ai?: boolean;
}

export interface ChatOptions {
  intent?: string;
  region?: string;
  timeout_ms?: number;
  min_reputation?: number;
  qos?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  routing_policy?: RoutingPolicy;
  browser_usable_only?: boolean;
  profile_request?: ProfileRequest;
  route_constraints?: RouteConstraints;
}

export type RoutingProfile =
  | "standard"
  | "sensitive"
  | "eu_restricted"
  | "strict_policy"
  | "debug_override";

export type RequiredManifestIdentityLevel = "signed_valid" | "operator_bound" | "known_operator";

export interface RoutingPolicy {
  profile?: RoutingProfile | string;
  allowed_regions?: string[];
  require_encryption?: boolean;
  require_policy_manifest?: boolean;
  require_no_payload_retention?: boolean;
  allow_remote_executor?: boolean;
  known_operator_only?: boolean;
  required_manifest_identity_level?: RequiredManifestIdentityLevel | string;
}

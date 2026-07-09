/**
 * IicpClient — primary entrypoint for the IICP TypeScript SDK (ADR-016 §1).
 * Implements SDK-01..SDK-06 conformance rules.
 */

import { randomUUID } from "node:crypto";

import { encryptPayload } from "./confidentiality.js";
import { IicpError } from "./errors.js";
import { ensureIntentAllowed } from "./policy.js";
import {
  ROUTING_POLICY_REFUSAL_CODE,
  filterNodesForRoutingPolicy,
  resolvedRoutingPolicy,
  routingPolicyRefusalMessage,
} from "./routing_policy.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ClientConfig,
  DiscoverOptions,
  Node,
  TaskRequest,
  TaskResponse,
} from "./types.js";

const INTENT_RE = /^urn:iicp:intent:[a-z0-9_:/-]+$/;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

class LegacyDiscoveryRequired extends Error {}

/** SSRF guard: return true only if url is safe to use as a node endpoint (#388). */
function _isSsrfSafe(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  // Dev/test escape hatch (default OFF): allow loopback/private node endpoints so a
  // node + proxy can run on one host (local mesh) and for E2E tests. NEVER enable in
  // production — it re-opens the SSRF surface this guard exists to close.
  if (["1", "true", "yes"].includes((process.env.IICP_PROXY_ALLOW_LOOPBACK_NODES ?? "").trim().toLowerCase())) {
    return true;
  }
  if (["localhost", "0.0.0.0", "::1", "::"].includes(host)) return false;
  const blockedSuffixes = [".local", ".internal", ".lan", ".test", ".invalid", ".localhost"];
  if (blockedSuffixes.some((s) => host.endsWith(s))) return false;
  // IPv6 address — URL.hostname strips brackets, leaving e.g. "2a0a:a543::1"
  if (host.includes(":")) {
    // Block link-local (fe80:) and unique-local (fc00::/7)
    if (/^(fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i.test(host)) return false;
    return true; // global unicast IPv6 — safe
  }
  if (!host.includes(".")) return false; // bare Docker service name
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Match) {
    const [a, b, c, d] = ipv4Match.slice(1).map(Number);
    if (a === 10) return false;                                      // RFC1918 10/8
    if (a === 172 && b >= 16 && b <= 31) return false;              // RFC1918 172.16/12
    if (a === 192 && b === 168) return false;                       // RFC1918 192.168/16
    if (a === 127) return false;                                     // loopback
    if (a === 169 && b === 254) return false;                       // link-local / metadata
    if (a === 100 && b >= 64 && b <= 127) return false;            // CGNAT
    if (a === 0) return false;                                      // this-network
    void c; void d;
  }
  return true;
}

function _cxPlaintextFallbackAllowed(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.IICP_CX_ALLOW_PLAINTEXT ?? "").trim().toLowerCase());
}

function _nodeShortId(nodeId: string): string {
  return nodeId.slice(0, 8);
}

function _isBrowserUsableEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const DEFAULT_EPSILON = 0.05;
const DEFAULT_ROUTING_TOP_K = 3;
const DEFAULT_ROUTING_SOFTMAX_TAU = 0.04;

const DEFAULT_CONFIG: ClientConfig = {
  directory_url: "https://iicp.network/api",
  timeout_ms: DEFAULT_TIMEOUT_MS,
  tls_verify: true,
  routing_epsilon: DEFAULT_EPSILON,
  routing_strategy: "epsilon",
  routing_top_k: DEFAULT_ROUTING_TOP_K,
  routing_softmax_tau: DEFAULT_ROUTING_SOFTMAX_TAU,
  route_discovery_mode: "auto",
};

const CONSUMER_TOKEN_EXPIRY_BUFFER_S = 30;

export class IicpClient {
  private readonly cfg: ClientConfig;
  /** Cache: `${nodeToken}|${targetNodeId}|${intent}` → [token, expUnix] */
  private readonly _ctCache = new Map<string, [string, number]>();

  constructor(config?: Partial<ClientConfig>) {
    const merged: ClientConfig = { ...DEFAULT_CONFIG, ...config };
    if (merged.tls_verify === false) {
      console.warn(
        "[iicp-client] tls_verify: false has no effect — TLS certificate verification " +
          "cannot be disabled via this config field. Use NODE_TLS_REJECT_UNAUTHORIZED=0 " +
          "in the environment if you need to disable cert verification for local testing.",
      );
    }
    // SDK-04: reject oversized timeouts at construction time
    if (merged.timeout_ms > MAX_TIMEOUT_MS) {
      throw new IicpError(
        `timeout_ms must be ≤ ${MAX_TIMEOUT_MS}; got ${merged.timeout_ms}`,
        "SDK-04",
      );
    }
    // IICP_ROUTING_EPSILON overrides config; clamp to [0.0, 1.0]
    const envEps = process.env["IICP_ROUTING_EPSILON"];
    if (envEps !== undefined) {
      const parsed = parseFloat(envEps);
      if (!isNaN(parsed)) {
        merged.routing_epsilon = Math.max(0, Math.min(1, parsed));
      }
    }
    const envStrategy = process.env["IICP_ROUTING_STRATEGY"];
    if (envStrategy === "deterministic" || envStrategy === "epsilon" || envStrategy === "softmax_top_k") {
      merged.routing_strategy = envStrategy;
    }
    const envTopK = process.env["IICP_ROUTING_TOP_K"];
    if (envTopK !== undefined) {
      const parsed = parseInt(envTopK, 10);
      if (!isNaN(parsed)) merged.routing_top_k = Math.max(1, parsed);
    }
    const envTau = process.env["IICP_ROUTING_SOFTMAX_TAU"];
    if (envTau !== undefined) {
      const parsed = parseFloat(envTau);
      if (!isNaN(parsed)) merged.routing_softmax_tau = Math.max(0.001, parsed);
    }
    if (merged.routing_epsilon === undefined) merged.routing_epsilon = DEFAULT_EPSILON;
    if (merged.routing_strategy === undefined) merged.routing_strategy = "epsilon";
    if (merged.routing_top_k === undefined) merged.routing_top_k = DEFAULT_ROUTING_TOP_K;
    if (merged.routing_softmax_tau === undefined) merged.routing_softmax_tau = DEFAULT_ROUTING_SOFTMAX_TAU;
    const envRouteMode = process.env["IICP_ROUTE_DISCOVERY_MODE"];
    if (config?.route_discovery_mode === undefined && (envRouteMode === "auto" || envRouteMode === "ticketed" || envRouteMode === "legacy")) {
      merged.route_discovery_mode = envRouteMode;
    }
    if (!merged.route_discovery_mode) merged.route_discovery_mode = "auto";
    this.cfg = merged;
  }


  private _selectCandidates(nodes: Node[], maxRetries: number): Node[] {
    const strategy = this.cfg.routing_strategy ?? "epsilon";
    if (strategy === "deterministic" || nodes.length <= 1) return nodes.slice(0, maxRetries);
    if (strategy === "softmax_top_k") {
      const topK = Math.max(1, Math.min(nodes.length, this.cfg.routing_top_k ?? DEFAULT_ROUTING_TOP_K));
      const pool = nodes.slice(0, topK);
      const tau = Math.max(0.001, this.cfg.routing_softmax_tau ?? DEFAULT_ROUTING_SOFTMAX_TAU);
      const maxScore = Math.max(...pool.map((n) => n.score));
      const weights = pool.map((n) => Math.exp((n.score - maxScore) / tau));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      let chosen = pool[0];
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i];
        if (r <= 0) { chosen = pool[i]; break; }
      }
      return [chosen, ...nodes.slice(0, maxRetries).filter((n) => n.node_id !== chosen.node_id)].slice(0, maxRetries);
    }
    const epsilon = this.cfg.routing_epsilon ?? DEFAULT_EPSILON;
    if (Math.random() < epsilon) {
      const exploreNode = nodes[Math.floor(Math.random() * nodes.length)];
      return [exploreNode, ...nodes.slice(0, maxRetries).filter((n) => n.node_id !== exploreNode.node_id)].slice(0, maxRetries);
    }
    return nodes.slice(0, maxRetries);
  }

  // ------------------------------------------------------------------
  // Public async API
  // ------------------------------------------------------------------

  private _nodeFromRoute(raw: Record<string, unknown>, ticketIdPrefix?: string): Node | undefined {
    const endpoint = String(raw.endpoint ?? "");
    const nodeId = String(raw.node_id ?? "");
    if (!nodeId || !_isSsrfSafe(endpoint)) return undefined;
    const rawCx = (raw.cx_public_key ?? raw.public_key) as Record<string, string> | undefined;
    return {
      node_id: nodeId,
      endpoint,
      score: Number(raw.score ?? 0),
      available: Boolean(raw.available ?? true),
      region: String(raw.region ?? ""),
      latency_estimate_ms: raw.latency_estimate_ms as number | undefined,
      reputation_score: raw.reputation_score as number | undefined,
      health_label: raw.health_label as string | undefined,
      exposure_mode: raw.exposure_mode as string | undefined,
      cx_public_key: rawCx && rawCx.algorithm && rawCx.key && rawCx.key_id
        ? { algorithm: rawCx.algorithm, encoding: rawCx.encoding, key: rawCx.key, key_id: rawCx.key_id }
        : undefined,
      transport: Array.isArray(raw.transport) ? raw.transport.map(String) : undefined,
      directory_observed_reachable: typeof raw.directory_observed_reachable === "boolean"
        ? raw.directory_observed_reachable
        : raw.directory_observed_reachable === null ? null : undefined,
      route_evidence: typeof raw.route_evidence === "string" ? raw.route_evidence : undefined,
      routing_hint: typeof raw.routing_hint === "string" ? raw.routing_hint : undefined,
      browser_usable: typeof raw.browser_usable === "boolean" ? raw.browser_usable : undefined,
      node_policy_manifest: raw.node_policy_manifest && typeof raw.node_policy_manifest === "object"
        ? raw.node_policy_manifest as Record<string, unknown>
        : raw.node_policy_manifest === null ? null : undefined,
      dispatch_ticket_id_prefix: ticketIdPrefix,
    };
  }

  private async _ticketedCandidates(intent: string, opts: DiscoverOptions, traceparent: string): Promise<Node[]> {
    const url = `${this.cfg.directory_url.replace(/\/$/, "")}/v1/dispatch/ticket`;
    const base: Record<string, unknown> = { intent, limit: Math.min(opts.limit ?? 10, 50) };
    const region = opts.region ?? this.cfg.region;
    if (region) base.region = region;
    if (opts.qos) base.qos = opts.qos;
    if (opts.min_reputation !== undefined) base.min_reputation = opts.min_reputation;
    const excluded: string[] = [];
    const candidates: Node[] = [];

    for (let i = 0; i < MAX_RETRIES; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", traceparent },
          body: JSON.stringify({ ...base, exclude_node_id_prefixes: excluded }),
          signal: controller.signal,
        });
      } catch (cause) {
        throw new IicpError("Ticketed dispatch network error", "IICP-DISPATCH-TICKET-NETWORK", { component: "directory", cause });
      } finally {
        clearTimeout(timer);
      }
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const error = data.error as Record<string, unknown> | undefined;
      const errorCode = typeof error?.code === "string" ? error.code : undefined;
      if (response.status === 201) {
        const route = data.route as Record<string, unknown> | undefined;
        const node = route ? this._nodeFromRoute({ ...route, node_id: data.node_id ?? route.node_id }, String(data.ticket_id_prefix ?? "")) : undefined;
        if (!node) throw new IicpError("Directory returned malformed ticketed route material", "IICP-DISPATCH-TICKET-MALFORMED", { component: "directory" });
        candidates.push(node);
        excluded.push(node.node_id.slice(0, 8));
        continue;
      }
      if (response.status === 404 && errorCode === "no_route_available") break;
      if ([404, 405, 501].includes(response.status) || (response.status === 503 && errorCode === "not_configured")) {
        throw new LegacyDiscoveryRequired();
      }
      throw new IicpError(
        `Ticketed dispatch refused (${errorCode ?? response.status})`,
        `IICP-DISPATCH-TICKET-${response.status}`,
        { status_code: response.status, component: "directory" },
      );
    }
    return candidates;
  }

  /** Discover nodes capable of handling the given intent. */
  async discover(intent: string, opts?: DiscoverOptions, traceparent?: string): Promise<Node[]> {
    const o = opts ?? {};
    const params = new URLSearchParams();
    params.set("intent", intent);
    params.set("limit", String(Math.min(o.limit ?? 10, 50)));
    const region = o.region ?? this.cfg.region;
    if (region) params.set("region", region);
    if (o.qos) params.set("qos", o.qos);
    if (o.min_reputation !== undefined)
      params.set("min_reputation", String(o.min_reputation));

    const data = await this._get(
      `${this.cfg.directory_url.replace(/\/$/, "")}/v1/discover?${params}`,
      5_000,
      traceparent,
    );
    const raw: unknown[] = (data as { nodes?: unknown[] }).nodes ?? [];
    const nodes: Node[] = [];
    for (const n of raw) {
      const rawNode = n as Record<string, unknown>;
      const node = this._nodeFromRoute(rawNode);
      if (!node) {
        console.warn(
          `[iicp-client] SSRF guard: skipping node ${String(rawNode.node_id ?? "?").slice(0, 8)} — endpoint ${String(rawNode.endpoint ?? "")} is not publicly routable`,
        );
        continue;
      }
      if (o.browser_usable_only && !(node.browser_usable ?? _isBrowserUsableEndpoint(node.endpoint))) {
        continue;
      }
      nodes.push(node);
    }
    return nodes;
  }

  /**
   * Discover → select best node → submit task.
   * Retries up to MAX_RETRIES on transient errors (SDK-01).
   */
  async submit(req: TaskRequest): Promise<TaskResponse> {
    this._validateIntent(req.intent);
    const tp = _traceparent(); // SDK-06: shared trace across discover + submit
    const discoverOpts: DiscoverOptions = {
      region: req.constraints?.region ?? this.cfg.region,
      min_reputation: req.constraints?.min_reputation,
    };
    let nodes: Node[];
    if (this.cfg.route_discovery_mode === "legacy") {
      nodes = await this.discover(req.intent, discoverOpts, tp);
    } else {
      try {
        nodes = await this._ticketedCandidates(req.intent, discoverOpts, tp);
      } catch (err) {
        if (!(err instanceof LegacyDiscoveryRequired)) throw err;
        if (this.cfg.route_discovery_mode === "ticketed") {
          throw new IicpError("Directory does not support ticketed dispatch", "IICP-DISPATCH-TICKET-UNAVAILABLE", { component: "directory" });
        }
        nodes = await this.discover(req.intent, discoverOpts, tp);
      }
    }

    if (nodes.length === 0) {
      throw new IicpError(
        `No nodes available for intent: ${req.intent}`,
        "SDK-03",
        { component: "directory" },
      );
    }

    const taskId = req.task_id ?? randomUUID();
    const routingPolicy = req.routing_policy ?? this.cfg.routing_policy;
    const effectivePolicy = resolvedRoutingPolicy(routingPolicy);
    const allowPlaintext = _cxPlaintextFallbackAllowed() || effectivePolicy.require_encryption === false;
    const decision = filterNodesForRoutingPolicy(nodes, effectivePolicy, { allowPlaintextDebug: allowPlaintext });
    for (const node of nodes) {
      if (node.cx_public_key || allowPlaintext) continue;
      console.warn(
        `IICP-CX: skipping keyless node ${_nodeShortId(node.node_id)} — refusing plaintext by default ` +
          "(set IICP_CX_ALLOW_PLAINTEXT=1 or routing_profile=debug_override only for transitional debugging).",
      );
    }
    if (decision.eligible.length === 0 && decision.skippedKeyless > 0 && decision.rejectedReasons.length === decision.skippedKeyless) {
      throw new IicpError(
        `IICP-CX confidentiality required: ${decision.skippedKeyless} discovered node(s) advertised no encryption key; refusing plaintext fallback`,
        "IICP-CX-REQUIRED",
        { component: "sdk" },
      );
    }
    if (decision.eligible.length === 0) {
      throw new IicpError(
        routingPolicyRefusalMessage(req.intent, decision, effectivePolicy),
        ROUTING_POLICY_REFUSAL_CODE,
        { component: "sdk" },
      );
    }
    const candidates = this._selectCandidates(decision.eligible, MAX_RETRIES);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (req.auth?.token) {
      headers["Authorization"] = `Bearer ${req.auth.token}`;
    } else if (this.cfg.api_token) {
      headers["Authorization"] = `Bearer ${this.cfg.api_token}`;
    }

    let lastErr: IicpError | undefined;
    for (const node of candidates) {
      // Phase 2 (#496): acquire directory-issued consumer token when caller has directory identity.
      const nodeHeaders = { ...headers };
      const ct = await this._acquireConsumerToken(node.node_id, req.intent);
      if (ct) {
        nodeHeaders["X-IICP-Consumer-Token"] = ct;
      }

      // IICP-CX S.16: encryption is mandatory by default. Always encrypt when
      // the node advertises a cx_public_key. Plaintext fallback is refused unless
      // the caller explicitly sets IICP_CX_ALLOW_PLAINTEXT=1 for transitional debugging.
      const body: Record<string, unknown> = {
        task_id: taskId,
        intent: req.intent,
        constraints: req.constraints ?? {},
      };
      if (node.cx_public_key) {
        body["iicp_conf"] = encryptPayload(req.payload, node.cx_public_key, taskId, req.intent);
      } else {
        console.warn(
          `IICP-CX: node ${node.node_id} advertises no encryption key — sending UNENCRYPTED ` +
            "only because IICP_CX_ALLOW_PLAINTEXT=1 is set.",
        );
        body["payload"] = req.payload;
      }
      // #488 — forward requester identity for self-query neutrality at the directory.
      if (req.source_node_id) body["source_node_id"] = req.source_node_id;

      let nodeConnected = true;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const data = await this._post(
            `${node.endpoint}/v1/task`,
            body,
            req.constraints?.timeout_ms ?? this.cfg.timeout_ms,
            nodeHeaders,
            tp,
          );
          return {
            task_id: taskId,
            result: (data as Record<string, unknown>).result,
            status: String((data as Record<string, unknown>).status ?? "ok"),
            metrics: (data as Record<string, unknown>).metrics as
              | TaskResponse["metrics"]
              | undefined,
            generated_by_ai: true,
            dispatch_ticket_id_prefix: node.dispatch_ticket_id_prefix,
          };
        } catch (err) {
          if (err instanceof IicpError) {
            lastErr = err;
            // Connection error → skip to next node immediately
            if (!err.status_code) { nodeConnected = false; break; }
            if (TRANSIENT_STATUSES.has(err.status_code)) {
              await _sleep(200 * 2 ** attempt);
              continue; // retry same node on 5xx
            }
          }
          throw err; // non-retryable
        }
      }
      if (!nodeConnected) continue; // unreachable node, try next
    }
    throw lastErr!;
  }

  /**
   * Discover → select best LLM node → submit chat task via /v1/task (SDK-01/02).
   * Uses submit() internally so the full discover→select→retry pipeline applies.
   */
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    const o = opts ?? {};
    const intent = o.intent ?? "urn:iicp:intent:llm:chat:v1";

    const resp = await this.submit({
      intent,
      payload: {
        messages,
        ...(o.model ? { model: o.model } : {}),
        ...(o.max_tokens !== undefined ? { max_tokens: o.max_tokens } : {}),
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      },
      constraints: {
        timeout_ms: o.timeout_ms ?? this.cfg.timeout_ms,
        ...(o.region ? { region: o.region } : {}),
        ...(o.min_reputation !== undefined ? { min_reputation: o.min_reputation } : {}),
      },
      routing_policy: o.routing_policy,
    });

    const result = (resp.result ?? {}) as Record<string, unknown>;
    const rawChoices = (result.choices as unknown[]) ?? [];
    const choices = rawChoices.map((c, i) => {
      const ch = c as Record<string, unknown>;
      const msg = ch.message as Record<string, string> | undefined;
      return {
        index: i,
        message: {
          role: (msg?.role as ChatMessage["role"]) ?? "assistant",
          content: msg?.content ?? "",
        },
        finish_reason: String(ch.finish_reason ?? "stop"),
      };
    });

    const rawUsage = result.usage as Record<string, number> | undefined;
    const usage = rawUsage
      ? {
          prompt_tokens: rawUsage.prompt_tokens ?? 0,
          completion_tokens: rawUsage.completion_tokens ?? 0,
          total_tokens: rawUsage.total_tokens ?? 0,
        }
      : undefined;
    return {
      id: resp.task_id,
      choices,
      usage,
      node_id: String(result.node_id ?? ""),
      generated_by_ai: true,
    };
  }

  // ------------------------------------------------------------------
  // Consumer token acquisition (#496)
  // ------------------------------------------------------------------

  /**
   * Acquire a directory-issued consumer token for calling targetNodeId.
   * Caches by (nodeToken, targetNodeId, intent); refreshes when < 30s remain.
   * Returns null on any failure (callers fall back gracefully).
   */
  private async _acquireConsumerToken(
    targetNodeId: string,
    intent: string,
    timeoutMs = 5000,
  ): Promise<string | null> {
    const nodeToken = this.cfg.node_token;
    if (!nodeToken) return null;
    const cacheKey = `${nodeToken}|${targetNodeId}|${intent}`;
    const cached = this._ctCache.get(cacheKey);
    if (cached) {
      const [tok, exp] = cached;
      if (Date.now() / 1000 + CONSUMER_TOKEN_EXPIRY_BUFFER_S < exp) return tok;
    }
    const url = `${this.cfg.directory_url.replace(/\/api\/?$/, "").replace(/\/$/, "")}/api/v1/consumer-token`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${nodeToken}`,
        },
        body: JSON.stringify({ target_node_id: targetNodeId, intent }),
        signal: controller.signal,
      });
      if (res.status === 201) {
        const data = (await res.json()) as Record<string, unknown>;
        const token = String(data.token ?? "");
        const exp = Number(data.expires_at ?? 0);
        if (token) {
          this._ctCache.set(cacheKey, [token, exp]);
          return token;
        }
      }
    } catch {
      // best-effort; caller proceeds without consumer token
    } finally {
      clearTimeout(timer);
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private _validateIntent(intent: string): void {
    if (!INTENT_RE.test(intent)) {
      throw new IicpError(
        `Invalid intent URN: "${intent}" — must match urn:iicp:intent:*`,
        "SDK-02",
      );
    }
    ensureIntentAllowed(intent);
  }

  private async _get(url: string, timeoutMs: number, traceparent?: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", traceparent: traceparent ?? _traceparent() },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new IicpError(
          `GET ${url} returned ${res.status}: ${body.slice(0, 200)}`,
          "SDK-05",
          { status_code: res.status, component: "directory" },
        );
      }
      return (await res.json()) as unknown;
    } catch (err) {
      if (err instanceof IicpError) throw err;
      if ((err as { name?: string }).name === "AbortError") {
        throw new IicpError(
          `Request timed out after ${timeoutMs}ms`,
          "SDK-01",
          { component: "directory" },
        );
      }
      throw new IicpError(
        `Network error: ${(err as Error).message}`,
        "SDK-05",
        { cause: err, component: "directory" },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async _post(
    url: string,
    body: unknown,
    timeoutMs: number,
    extraHeaders?: Record<string, string>,
    traceparent?: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          traceparent: traceparent ?? _traceparent(),
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let code = "SDK-05";
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) code = j.error;
        } catch { /* ignore */ }
        throw new IicpError(
          `POST ${url} returned ${res.status}: ${text.slice(0, 200)}`,
          code,
          { status_code: res.status, component: "adapter" },
        );
      }
      return (await res.json()) as unknown;
    } catch (err) {
      if (err instanceof IicpError) throw err;
      if ((err as { name?: string }).name === "AbortError") {
        throw new IicpError(
          `Request timed out after ${timeoutMs}ms`,
          "SDK-01",
          { component: "adapter" },
        );
      }
      throw new IicpError(
        `Network error: ${(err as Error).message}`,
        "SDK-05",
        { cause: err, component: "adapter" },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a W3C traceparent header value (SDK-06). */
function _traceparent(): string {
  const traceId = randomUUID().replace(/-/g, "");
  const parentId = randomUUID().replace(/-/g, "").slice(0, 16);
  return `00-${traceId}-${parentId}-01`;
}

/**
 * IicpClient — primary entrypoint for the IICP TypeScript SDK (ADR-016 §1).
 * Implements SDK-01..SDK-06 conformance rules.
 */

import { randomUUID } from "node:crypto";

import { IicpError } from "./errors.js";
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
import { encryptPayload } from "./confidentiality.js";

const INTENT_RE = /^urn:iicp:intent:[a-z0-9_:/-]+$/;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

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

const DEFAULT_EPSILON = 0.05;

const DEFAULT_CONFIG: ClientConfig = {
  directory_url: "https://iicp.network/api",
  timeout_ms: DEFAULT_TIMEOUT_MS,
  tls_verify: true,
  routing_epsilon: DEFAULT_EPSILON,
};

export class IicpClient {
  private readonly cfg: ClientConfig;

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
    if (merged.routing_epsilon === undefined) merged.routing_epsilon = DEFAULT_EPSILON;
    this.cfg = merged;
  }

  // ------------------------------------------------------------------
  // Public async API
  // ------------------------------------------------------------------

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
      const node = n as Record<string, unknown>;
      const endpoint = String(node.endpoint ?? "");
      if (!_isSsrfSafe(endpoint)) {
        console.warn(
          `[iicp-client] SSRF guard: skipping node ${String(node.node_id ?? "?").slice(0, 8)} — endpoint ${endpoint} is not publicly routable`,
        );
        continue;
      }
      const rawCx = node.cx_public_key as Record<string, string> | undefined;
      nodes.push({
        node_id: String(node.node_id),
        endpoint,
        score: Number(node.score ?? 0),
        available: Boolean(node.available ?? true),
        region: String(node.region ?? ""),
        latency_estimate_ms: node.latency_estimate_ms as number | undefined,
        reputation_score: node.reputation_score as number | undefined,
        health_label: node.health_label as string | undefined,
        exposure_mode: node.exposure_mode as string | undefined,
        cx_public_key:
          rawCx && typeof rawCx === "object" && rawCx.algorithm && rawCx.key && rawCx.key_id
            ? { algorithm: rawCx.algorithm, key: rawCx.key, key_id: rawCx.key_id }
            : undefined,
        // #397 — transport protocols (http/https/iicp-native) when the directory emits them.
        transport: Array.isArray(node.transport)
          ? (node.transport as unknown[]).map(String)
          : undefined,
      });
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
    const nodes = await this.discover(req.intent, {
      region: req.constraints?.region ?? this.cfg.region,
      // Do not filter by qos — qos is a task execution hint, not a node capability
      // filter. Most nodes don't declare qos support; directory returns 0 nodes.
      min_reputation: req.constraints?.min_reputation,
    }, tp);

    if (nodes.length === 0) {
      throw new IicpError(
        `No nodes available for intent: ${req.intent}`,
        "SDK-03",
        { component: "directory" },
      );
    }

    const taskId = req.task_id ?? randomUUID();
    // ε-greedy provider selection (R4): with probability ε pick a random node
    // from the full discovered set; otherwise use the directory-sorted top pick.
    let candidates: typeof nodes;
    const epsilon = this.cfg.routing_epsilon ?? DEFAULT_EPSILON;
    if (nodes.length > 1 && Math.random() < epsilon) {
      const exploreIdx = Math.floor(Math.random() * nodes.length);
      const exploreNode = nodes[exploreIdx];
      candidates = [exploreNode, ...nodes.slice(0, MAX_RETRIES).filter((n) => n.node_id !== exploreNode.node_id)].slice(0, MAX_RETRIES);
    } else {
      candidates = nodes.slice(0, MAX_RETRIES);
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (req.auth?.token) {
      headers["Authorization"] = `Bearer ${req.auth.token}`;
    } else if (this.cfg.api_token) {
      headers["Authorization"] = `Bearer ${this.cfg.api_token}`;
    }

    let lastErr: IicpError | undefined;
    for (const node of candidates) {
      // IICP-CX S.16 §5: build body per node (cx_public_key may differ)
      const shouldEncrypt = this.cfg.use_confidentiality === true && node.cx_public_key != null;
      const body: Record<string, unknown> = {
        task_id: taskId,
        intent: req.intent,
        constraints: req.constraints ?? {},
      };
      if (shouldEncrypt && node.cx_public_key) {
        body["iicp_conf"] = encryptPayload(req.payload, node.cx_public_key, taskId, req.intent);
      } else {
        body["payload"] = req.payload;
      }

      let nodeConnected = true;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const data = await this._post(
            `${node.endpoint}/v1/task`,
            body,
            req.constraints?.timeout_ms ?? this.cfg.timeout_ms,
            headers,
            tp,
          );
          return {
            task_id: taskId,
            result: (data as Record<string, unknown>).result,
            status: String((data as Record<string, unknown>).status ?? "ok"),
            metrics: (data as Record<string, unknown>).metrics as
              | TaskResponse["metrics"]
              | undefined,
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
    };
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

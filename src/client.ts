/**
 * IicpClient — primary entrypoint for the IICP TypeScript SDK (ADR-016 §1).
 * Implements SDK-01..SDK-06 conformance rules.
 */

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

const INTENT_RE = /^urn:iicp:intent:[a-z0-9_:/-]+$/;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

const DEFAULT_CONFIG: ClientConfig = {
  directory_url: "https://iicp.network",
  timeout_ms: DEFAULT_TIMEOUT_MS,
  tls_verify: true,
};

export class IicpClient {
  private readonly cfg: ClientConfig;

  constructor(config?: Partial<ClientConfig>) {
    const merged: ClientConfig = { ...DEFAULT_CONFIG, ...config };
    // SDK-04: reject oversized timeouts at construction time
    if (merged.timeout_ms > MAX_TIMEOUT_MS) {
      throw new IicpError(
        `timeout_ms must be ≤ ${MAX_TIMEOUT_MS}; got ${merged.timeout_ms}`,
        "SDK-04",
      );
    }
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
      `${this.cfg.directory_url}/api/v1/discover?${params}`,
      5_000,
      traceparent,
    );
    const raw: unknown[] = (data as { nodes?: unknown[] }).nodes ?? [];
    return raw.map((n) => {
      const node = n as Record<string, unknown>;
      return {
        node_id: String(node.node_id),
        endpoint: String(node.endpoint ?? ""),
        score: Number(node.score ?? 0),
        available: Boolean(node.available ?? true),
        region: String(node.region ?? ""),
        latency_estimate_ms: node.latency_estimate_ms as number | undefined,
        reputation_score: node.reputation_score as number | undefined,
      };
    });
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
      qos: req.constraints?.qos,
      min_reputation: req.constraints?.min_reputation,
    }, tp);

    if (nodes.length === 0) {
      throw new IicpError(
        `No nodes available for intent: ${req.intent}`,
        "SDK-03",
        { component: "directory" },
      );
    }

    const node = nodes[0];
    const taskId = req.task_id ?? crypto.randomUUID();
    const body = {
      task_id: taskId,
      intent: req.intent,
      payload: req.payload,
      constraints: req.constraints ?? {},
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (req.auth?.token) {
      headers["Authorization"] = `Bearer ${req.auth.token}`;
    } else if (this.cfg.api_token) {
      headers["Authorization"] = `Bearer ${this.cfg.api_token}`;
    }

    let lastErr: IicpError | undefined;
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
        if (
          err instanceof IicpError &&
          err.status_code !== undefined &&
          TRANSIENT_STATUSES.has(err.status_code)
        ) {
          lastErr = err;
          // SDK-01: exponential back-off on transient errors
          await _sleep(200 * 2 ** attempt);
          continue;
        }
        throw err;
      }
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
    return {
      id: resp.task_id,
      choices,
      usage: rawUsage,
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
  const traceId = crypto.randomUUID().replace(/-/g, "");
  const parentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `00-${traceId}-${parentId}-01`;
}

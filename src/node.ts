// SPDX-License-Identifier: Apache-2.0
/**
 * IICP provider node — registration, heartbeats, and task serving.
 *
 * Endpoints served by `IicpNode.serve()`:
 *   POST /v1/task      — task handler (IICP-E021 concurrency gate,
 *                         IICP-E011 nonce replay, W3C traceparent)
 *   GET  /iicp/health  — liveness / capacity (always 200)
 *   GET  /metrics      — Prometheus text (503 if prom-client absent)
 */

import * as http from "node:http";

const DEFAULT_DIRECTORY = "https://iicp.network/api";
const HEARTBEAT_INTERVAL_MS = 30_000;
const NONCE_TTL_MS = 300_000;

// Use `any` for prom-client types — it's an optional peer dep and may not be installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PromLib = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PromCounter = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PromHistogram = any;

export interface NodeConfig {
  nodeId: string;
  endpoint: string;
  intent: string;
  model?: string;
  region?: string;
  capabilities?: string[];
  directoryUrl?: string;
  timeoutMs?: number;
  /** Maximum concurrent tasks; excess → 429 IICP-E021. Default: 4. */
  maxConcurrent?: number;
}

export interface ServeOptions {
  host?: string;
  port?: number;
  nodeToken?: string;
}

export type TaskHandler = (task: Record<string, unknown>) => Promise<Record<string, unknown>>;

// ── IicpNode ──────────────────────────────────────────────────────────────────

export class IicpNode {
  private readonly _cfg: Required<Omit<NodeConfig, "model" | "region" | "capabilities">> & {
    model: string | undefined;
    region: string | undefined;
    capabilities: string[];
  };

  private _activeTasks = 0;
  private _nonces = new Map<string, number>(); // nonce → expiry timestamp (ms)
  private _prom: PromLib | null = null;
  private _tasksCounter: PromCounter | null = null;
  private _latencyHistogram: PromHistogram | null = null;
  private _tokensCounter: PromCounter | null = null;
  private _promLoaded = false;

  constructor(config: NodeConfig) {
    this._cfg = {
      nodeId: config.nodeId,
      endpoint: config.endpoint,
      intent: config.intent,
      model: config.model,
      region: config.region,
      capabilities: config.capabilities ?? [],
      directoryUrl: config.directoryUrl ?? DEFAULT_DIRECTORY,
      timeoutMs: config.timeoutMs ?? 5_000,
      maxConcurrent: config.maxConcurrent ?? 4,
    };
  }

  // ── Directory operations ───────────────────────────────────────────────────

  async register(): Promise<string> {
    const body: Record<string, unknown> = {
      node_id: this._cfg.nodeId,
      endpoint: this._cfg.endpoint,
      intent: this._cfg.intent,
    };
    if (this._cfg.model) body.model = this._cfg.model;
    if (this._cfg.region) body.region = this._cfg.region;
    if (this._cfg.capabilities.length) body.capabilities = this._cfg.capabilities;

    const resp = await fetch(
      `${this._cfg.directoryUrl.replace(/\/$/, "")}/v1/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this._cfg.timeoutMs),
      }
    );
    if (!resp.ok) throw new Error(`Registration failed: ${resp.status}`);
    const data = (await resp.json()) as Record<string, unknown>;
    const token = (data.node_token ?? data.token) as string | undefined;
    if (!token) throw new Error(`Directory did not return node_token: ${JSON.stringify(data)}`);
    return token;
  }

  async heartbeat(nodeToken: string): Promise<void> {
    const resp = await fetch(
      `${this._cfg.directoryUrl.replace(/\/$/, "")}/api/v1/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: this._cfg.nodeId,
          node_token: nodeToken,
          status: "available",
        }),
        signal: AbortSignal.timeout(this._cfg.timeoutMs),
      }
    );
    if (!resp.ok) throw new Error(`Heartbeat failed: ${resp.status}`);
  }

  // ── Nonce replay protection ────────────────────────────────────────────────

  private _checkNonce(nonce?: string): boolean {
    if (!nonce) return true;
    const now = Date.now();
    // Evict expired nonces
    for (const [k, exp] of this._nonces) {
      if (exp < now) this._nonces.delete(k);
    }
    if (this._nonces.has(nonce)) return false;
    this._nonces.set(nonce, now + NONCE_TTL_MS);
    return true;
  }

  // ── Prometheus (lazy, optional) ────────────────────────────────────────────

  private async _ensureProm(): Promise<void> {
    if (this._promLoaded) return;
    this._promLoaded = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._prom = await (eval('import("prom-client")') as Promise<any>) as PromLib;
      this._tasksCounter = new this._prom.Counter({
        name: "iicp_tasks_total",
        help: "Total IICP tasks handled",
        labelNames: ["status", "intent", "qos"] as const,
      }) as unknown as PromCounter;
      this._latencyHistogram = new this._prom.Histogram({
        name: "iicp_task_latency_ms",
        help: "IICP task processing latency (ms)",
        labelNames: ["intent", "qos"] as const,
        buckets: [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
      });
      this._tokensCounter = new this._prom.Counter({
        name: "iicp_tokens_used_total",
        help: "Total tokens consumed",
        labelNames: ["intent"] as const,
      }) as unknown as PromCounter;
    } catch {
      this._prom = null;
    }
  }

  // ── serve() ────────────────────────────────────────────────────────────────

  serve(handler: TaskHandler, options: ServeOptions = {}): () => void {
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? 8020;
    const nodeToken = options.nodeToken;

    // Load Prometheus in background (non-blocking)
    this._ensureProm().catch(() => undefined);

    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/iicp/health") {
        this._handleHealth(res);
      } else if (req.method === "GET" && req.url === "/metrics") {
        this._handleMetrics(res);
      } else if (req.method === "POST" && req.url === "/v1/task") {
        this._handleTask(req, res, handler);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      }
    });

    server.listen(port, host);

    let hbTimer: ReturnType<typeof setInterval> | undefined;
    if (nodeToken) {
      hbTimer = setInterval(() => {
        this.heartbeat(nodeToken).catch(() => undefined);
      }, HEARTBEAT_INTERVAL_MS);
    }

    return () => {
      if (hbTimer) clearInterval(hbTimer);
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
    };
  }

  // ── GET /iicp/health ───────────────────────────────────────────────────────

  private _handleHealth(res: http.ServerResponse): void {
    const active = this._activeTasks;
    const max = this._cfg.maxConcurrent;
    const body = JSON.stringify({
      status: "ok",
      node_id: this._cfg.nodeId,
      region: this._cfg.region ?? "unknown",
      load: max > 0 ? active / max : 0,
      active_jobs: active,
      max_concurrent: max,
      available: active < max,
      model: this._cfg.model ?? "",
      intent: this._cfg.intent,
    });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }

  // ── GET /metrics ───────────────────────────────────────────────────────────

  private _handleMetrics(res: http.ServerResponse): void {
    if (!this._prom) {
      const body = "prom-client not installed";
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end(body);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._prom.register.metrics() as Promise<string>).then((metrics: string) => {
      res.writeHead(200, { "Content-Type": this._prom!.register.contentType });
      res.end(metrics);
    }).catch(() => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("metrics unavailable");
    });
  }

  // ── POST /v1/task ──────────────────────────────────────────────────────────

  private _handleTask(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: TaskHandler
  ): void {
    // Concurrency gate — IICP-E021
    if (this._activeTasks >= this._cfg.maxConcurrent) {
      const body = JSON.stringify({
        error: { code: "IICP-E021", message: "capacity_exceeded", retry_after_ms: 2000 },
      });
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "2",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    this._activeTasks++;
    const t0 = Date.now();

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let task: Record<string, unknown> = {};
      try {
        task = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      } catch {
        this._activeTasks--;
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "IICP-E000", message: "invalid JSON" } }));
        return;
      }

      // Nonce replay — IICP-E011
      if (!this._checkNonce(task.nonce as string | undefined)) {
        this._activeTasks--;
        const body = JSON.stringify({ error: { code: "IICP-E011", message: "replay_detected" } });
        res.writeHead(409, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }

      // W3C traceparent propagation
      const tp = req.headers["traceparent"] as string | undefined;
      if (tp) (task as Record<string, unknown>)._trace = { traceparent: tp };

      const intent = (task.intent as string | undefined) ?? this._cfg.intent;
      const constraints = task.constraints as Record<string, unknown> | undefined;
      const qos = (constraints?.qos_class as string | undefined) ?? "best_effort";
      const taskId = (task.task_id as string | undefined) ?? "";

      handler(task)
        .then((result) => {
          this._activeTasks--;
          const latencyMs = Date.now() - t0;
          if (this._tasksCounter) {
            (this._tasksCounter as unknown as { labels: (...args: unknown[]) => { inc: () => void } })
              .labels("completed", intent, qos).inc();
          }
          if (this._latencyHistogram) {
            this._latencyHistogram.labels(intent, qos).observe(latencyMs);
          }
          const tokens = (result.usage as Record<string, number> | undefined)?.total_tokens ?? 0;
          if (tokens && this._tokensCounter) {
            (this._tokensCounter as unknown as { labels: (...args: unknown[]) => { inc: (n: number) => void } })
              .labels(intent).inc(tokens);
          }
          const body = JSON.stringify({ task_id: taskId, status: "completed", ...result });
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
          res.end(body);
        })
        .catch((err: Error) => {
          this._activeTasks--;
          if (this._tasksCounter) {
            (this._tasksCounter as unknown as { labels: (...args: unknown[]) => { inc: () => void } })
              .labels("error", intent, qos).inc();
          }
          const body = JSON.stringify({ task_id: taskId, status: "error", error: { message: err.message } });
          res.writeHead(500, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
          res.end(body);
        });
    });
  }
}

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
// SDK version reported in register payload sdk_version. Update on package
// version bumps; checked by tests against package.json.
const SDK_VERSION = "0.5.6";

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
  /** Tokens per minute capacity declared to directory (REGISTER `limits.tokens_per_min`). Default: 10000. */
  tokensPerMin?: number;
  /** Max tokens per request, declared on the capability object (REGISTER `capabilities[].max_tokens`). Default: 8192. */
  maxTokens?: number;
  /**
   * Optional native IICP binary endpoint (spec/iicp-dir.md v0.7.0).
   * Scheme MUST be `iicp://` (plaintext) or `iicpsec://` (TLS).
   * Default IICP port is 9484 (ADR-040). When set, the directory persists it
   * and clients SHOULD prefer it over `endpoint` for task CALLs.
   */
  transportEndpoint?: string;
  /** #331 Phase A.1 / ADR-041 — NAT-traversal observability surfaced to the
   * directory in the register payload. Set manually or via applyNatProfile(). */
  transportMethod?:
    | "direct"
    | "upnp_mapped"
    | "stun_hole_punch"
    | "turn_relay"
    | "external_tunnel"
    | "unknown";
  natType?: "full_cone" | "restricted_cone" | "port_restricted" | "symmetric" | "unknown";
  transportMetadata?: Record<string, unknown>;
  /** S.12 §2.1 CIP policy block (CIP-D1) surfaced to the directory register.
   * Pass a CooperativeInferencePolicy instance; when undefined the SDK falls
   * back to the module-level getCipPolicy(). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cipPolicy?: any;
  /** ADR-019 declarative pricing block. When undefined, the SDK does not
   * advertise pricing and the directory defaults to 1.0 multiplier. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pricing?: any;
  /** Operator-provisioned HMAC key for ADR-019 signing. If empty, the SDK
   * falls back to the directory-issued key returned in the register response. */
  nodeHmacKey?: string;
}

export interface ServeOptions {
  host?: string;
  port?: number;
  nodeToken?: string;
}

export type TaskHandler = (task: Record<string, unknown>) => Promise<Record<string, unknown>>;

// ── IicpNode ──────────────────────────────────────────────────────────────────

export class IicpNode {
  private readonly _cfg: Required<
    Omit<
      NodeConfig,
      "model" | "region" | "capabilities" | "transportEndpoint" | "transportMethod" | "natType" | "transportMetadata" | "cipPolicy" | "pricing" | "nodeHmacKey"
    >
  > & {
    model: string | undefined;
    region: string | undefined;
    capabilities: string[];
    transportEndpoint: string | undefined;
    transportMethod: NodeConfig["transportMethod"];
    natType: NodeConfig["natType"];
    transportMetadata: Record<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cipPolicy: any | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pricing: any | undefined;
    nodeHmacKey: string;
  };
  private _runtimeHmacKey: string = "";
  /** #343 — UPnP IPv6 pinhole UID captured by applyNatProfile, revoked on shutdown. */
  private _pinholeUid: number | null = null;
  private _pinholeLeaseSeconds = 3600;
  private _pinholeRenewalTimer: ReturnType<typeof setTimeout> | null = null;

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
      tokensPerMin: config.tokensPerMin ?? 10_000,
      maxTokens: config.maxTokens ?? 8192,
      transportEndpoint: config.transportEndpoint,
      transportMethod: config.transportMethod,
      natType: config.natType,
      transportMetadata: config.transportMetadata,
      cipPolicy: config.cipPolicy,
      pricing: config.pricing,
      nodeHmacKey: config.nodeHmacKey ?? "",
    };
    this._runtimeHmacKey = config.nodeHmacKey ?? "";
  }

  /** The HMAC key in use for ADR-019 pricing signatures. */
  get nodeHmacKey(): string {
    return this._runtimeHmacKey;
  }

  /**
   * Populate transport_endpoint + NAT observability fields from a
   * detectNat() result. Operators typically call this right after detectNat()
   * and before register() so the directory receives the discovered public
   * endpoint + observability fields in the same payload.
   *
   * Defensive: tier-4 (unreachable) profiles do NOT overwrite a manually-set
   * endpoint, and transport_method "unreachable" is filtered out before
   * register.
   */
  applyNatProfile(profile: {
    tier: number;
    transportMethod: string;
    publicEndpoint?: string;
    transportEndpoint?: string;
    detectionLog?: string[];
    isReachable(): boolean;
    ipv6?: {
      pinholeActive?: boolean;
      pinholeUniqueId?: number;
      pinholeLeaseSeconds?: number;
    };
  }): void {
    if (profile.isReachable() && profile.publicEndpoint) {
      this._cfg.endpoint = profile.publicEndpoint;
    }
    if (profile.transportEndpoint) {
      this._cfg.transportEndpoint = profile.transportEndpoint;
    }
    if (profile.transportMethod && profile.transportMethod !== "unreachable") {
      this._cfg.transportMethod = profile.transportMethod as NodeConfig["transportMethod"];
    }
    this._cfg.natType = this._cfg.natType ?? "unknown";
    const log = profile.detectionLog ?? [];
    this._cfg.transportMetadata = {
      tier: profile.tier,
      detection_log_tail: log.slice(-1),
    };
    // #343 — capture the IPv6 firewall pinhole UID so we can revoke it on shutdown.
    if (profile.ipv6?.pinholeActive && typeof profile.ipv6.pinholeUniqueId === "number") {
      this._pinholeUid = profile.ipv6.pinholeUniqueId;
      if (typeof profile.ipv6.pinholeLeaseSeconds === "number" && profile.ipv6.pinholeLeaseSeconds > 0) {
        this._pinholeLeaseSeconds = profile.ipv6.pinholeLeaseSeconds;
      }
      this._schedulePinholeRenewal();
    }
  }

  /** #343 — Schedule pinhole renewal at lease/2 interval using UpdatePinhole. */
  private _schedulePinholeRenewal(): void {
    if (this._pinholeRenewalTimer !== null) clearTimeout(this._pinholeRenewalTimer);
    const delayMs = Math.max(this._pinholeLeaseSeconds / 2, 60) * 1000;
    this._pinholeRenewalTimer = setTimeout(async () => {
      const uid = this._pinholeUid;
      if (uid == null) return;
      try {
        const { renewIpv6Pinhole } = await import("./nat_detection.js");
        const ok = await renewIpv6Pinhole(uid, this._pinholeLeaseSeconds);
        if (ok) {
          this._schedulePinholeRenewal(); // schedule next renewal
        } else {
          // Retry sooner — IGD may be temporarily unreachable.
          this._pinholeLeaseSeconds = Math.max(this._pinholeLeaseSeconds, 120);
          this._schedulePinholeRenewal();
        }
      } catch {
        this._schedulePinholeRenewal();
      }
    }, delayMs);
  }

  /** #343 — close the UPnP IPv6 firewall pinhole if one is tracked. Best-effort. */
  async revokePinhole(): Promise<void> {
    if (this._pinholeRenewalTimer !== null) {
      clearTimeout(this._pinholeRenewalTimer);
      this._pinholeRenewalTimer = null;
    }
    const uid = this._pinholeUid;
    if (uid == null) return;
    this._pinholeUid = null;
    try {
      const { deleteIpv6Pinhole } = await import("./nat_detection.js");
      await deleteIpv6Pinhole(uid);
    } catch {
      // Best-effort — leases auto-expire.
    }
  }

  // ── Directory operations ───────────────────────────────────────────────────

  async register(): Promise<string> {
    // spec/iicp-dir.md §3.1 REGISTER + v0.7.0 dual-endpoint extension.
    // Pre-iter-1412 sent a non-spec flat-`intent` shape that the production
    // directory rejects with 422; fixed below.
    const models = this._cfg.model ? [this._cfg.model] : [];
    if (this._cfg.capabilities.length) {
      // Legacy flat capabilities list → fold into the models array.
      for (const m of this._cfg.capabilities) {
        if (!models.includes(m)) models.push(m);
      }
    }
    const body: Record<string, unknown> = {
      endpoint: this._cfg.endpoint,
      region: this._cfg.region ?? "eu-central",
      capabilities: [{
        intent: this._cfg.intent,
        models,
        max_tokens: this._cfg.maxTokens,
      }],
      limits: {
        max_concurrent: this._cfg.maxConcurrent,
        tokens_per_min: this._cfg.tokensPerMin,
      },
    };
    if (this._cfg.nodeId) body.node_id = this._cfg.nodeId;
    // spec v0.7.0 — native IICP binary endpoint
    if (this._cfg.transportEndpoint) body.transport_endpoint = this._cfg.transportEndpoint;
    // #331 / ADR-041 — NAT-traversal observability (set manually or via
    // applyNatProfile after detectNat)
    if (this._cfg.transportMethod) body.transport_method = this._cfg.transportMethod;
    if (this._cfg.natType) body.nat_type = this._cfg.natType;
    if (this._cfg.transportMetadata) body.transport_metadata = this._cfg.transportMetadata;

    // SDK self-identification — directory surfaces these on /v1/discover
    // so dashboards can render a language badge. Free-form so future SDKs
    // (Go / Java / C / WASM) can self-tag without a directory change.
    body.sdk_language = "typescript";
    body.sdk_version = SDK_VERSION;

    // S.12 §2.1 — CIP-D1 policy block. Use the per-config policy if set,
    // otherwise fall back to module-level getCipPolicy().
    const { getCipPolicy, CooperativeInferencePolicy } = await import("./cip_policy.js");
    const policy = this._cfg.cipPolicy ?? getCipPolicy();
    if (policy instanceof CooperativeInferencePolicy) {
      const block = policy.asRegisterPolicyBlock();
      if (Object.keys(block).length > 0) body.policy = block;
    }

    // ADR-019 — declarative pricing. Operator opt-in.
    if (this._cfg.pricing) {
      const { buildPricingBlock } = await import("./pricing.js");
      body.pricing = buildPricingBlock(this._cfg.pricing, this._runtimeHmacKey);
    }
    if (this._cfg.nodeHmacKey) {
      body.node_hmac_key = this._cfg.nodeHmacKey;
    }

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
    // ADR-019: capture the directory-issued HMAC key for subsequent pricing
    // signatures. Operator-provisioned key wins when set.
    if (!this._runtimeHmacKey) {
      const dirKey = data.node_hmac_key;
      if (typeof dirKey === "string" && dirKey.length > 0) {
        this._runtimeHmacKey = dirKey;
      }
    }
    return token;
  }

  async heartbeat(nodeToken: string): Promise<void> {
    const resp = await fetch(
      // /v1/heartbeat (NOT /api/v1/heartbeat) — default directoryUrl
      // already ends in /api; doubling produced 404s and prevented
      // last_seen updates, so nodes vanished from /v1/stats.
      `${this._cfg.directoryUrl.replace(/\/$/, "")}/v1/heartbeat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // NodeTokenAuth middleware on the directory side requires
          // Bearer auth; the body token is kept for back-compat with
          // older directory builds.
          Authorization: `Bearer ${nodeToken}`,
        },
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

  /**
   * Tell the directory this node is going away.
   *
   * Mirrors iicp_client.IicpNode.deregister (Python iter-1471). Best-effort:
   * shutdown paths swallow failures so a flaky directory connection doesn't
   * block process exit.
   */
  async deregister(nodeToken: string): Promise<void> {
    const resp = await fetch(
      `${this._cfg.directoryUrl.replace(/\/$/, "")}/v1/register`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: this._cfg.nodeId,
          node_token: nodeToken,
        }),
        signal: AbortSignal.timeout(this._cfg.timeoutMs),
      }
    );
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Deregister failed: ${resp.status}`);
    }
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
    const uid = this._pinholeUid;
    const pinholeState = uid != null
      ? { active: true, unique_id: uid, lease_seconds: this._pinholeLeaseSeconds }
      : { active: false };
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
      pinhole_state: pinholeState,
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

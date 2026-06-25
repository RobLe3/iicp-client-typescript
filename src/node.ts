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
import * as net from "node:net"; // #457 — single-port HTTP + native transport multiplexer
import { createHmac } from "node:crypto"; // #411 — heartbeat challenge-response HMAC
import { IicpTcpServer, IICP_MAGIC, type TcpTaskHandler } from "./iicp_tcp.js"; // #457
import { isQueueEligible, QUEUE_WAIT_MS } from "./scheduler.js";
import { AvailabilityEvaluator, type Window } from "./availability.js";
import { IdempotencyGuard } from "./idempotency.js";
import { PeerManager } from "./peer_manager.js";
import { HttpPollWorkerSession, RelaySessionRegistry } from "./relay_session.js";
import { getCipPolicy } from "./cip_policy.js"; // #403 — per-task admission gate
import type { Delegation } from "./delegation.js"; // #407 — ADR-045 operator delegation
import type { CxPublicKey } from "./types.js";
import { decryptPayload, loadOrCreateNodeCxKey } from "./confidentiality.js";
import { verifyRelayBindTicket } from "./relay_ticket.js";
import { BackendStabilityObservation, observeBackendStability } from "./backend_stability.js";
import { autoUpdateStatusPayload } from "./updater.js";

const DEFAULT_DIRECTORY = "https://iicp.network/api";
const HEARTBEAT_INTERVAL_MS = 30_000;
// #450 — browser relay workers call /v1/relay/* and /v1/relay-for/* via fetch().
const RELAY_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
} as const;
const NONCE_TTL_MS = 300_000;
// SDK version reported in register payload sdk_version. Derive from package.json so
// the directory adoption signal cannot drift from the published package version.
const SDK_VERSION: string = (require("../package.json") as { version: string }).version;

const EMBEDDING_INTENT = "urn:iicp:intent:llm:embedding:v1";

/**
 * TC-9c: exported helper — POSTs a CIPWorkerReceipt to directoryUrl/v1/credits/award.
 * Exported for unit testing; the IicpNode class calls this from its private wrapper.
 */
export async function postCipReceipt(opts: {
  directoryUrl: string;
  token: string;
  hmacKey: string;
  nodeId: string;
  taskId: string;
  tokensUsed: number;
  result: Record<string, unknown>;
  /** #488 — querying node ID for self-query neutrality at the directory. */
  queryingNodeId?: string;
}): Promise<void> {
  const { createHmac, createHash, randomBytes } = await import("node:crypto");
  const { directoryUrl, token, hmacKey, nodeId, taskId, tokensUsed, result, queryingNodeId } = opts;

  const sortedCanonical = JSON.stringify(result, (_k, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      );
    }
    return v;
  });
  const responseHash = createHash("sha256").update(sortedCanonical, "utf8").digest("hex");
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  // #490 — include queryingNodeId in canonical message when present to prevent spoofing.
  // Directory ≥ v1.10.25 verifies the extended canonical; older receipts use short form.
  const msg = queryingNodeId
    ? `${taskId}:${tokensUsed}:::${nonce}:${responseHash}:${queryingNodeId}`
    : `${taskId}:${tokensUsed}:::${nonce}:${responseHash}`;
  const signature = createHmac("sha256", hmacKey).update(msg, "utf8").digest("hex");
  const amount = Math.max(tokensUsed, 1) / 1000.0;

  const body: Record<string, unknown> = {
    node_id: nodeId,
    task_id: taskId,
    tokens_used: tokensUsed,
    amount: Math.round(amount * 10000) / 10000,
    nonce,
    expires_at: expiresAt,
    signature,
    response_hash: responseHash,
    reason: "task_completion",
  };
  // #488: include querying_node_id for self-query neutrality detection at the directory.
  if (queryingNodeId) body["querying_node_id"] = queryingNodeId;

  await fetch(`${directoryUrl.replace(/\/+$/, "")}/v1/credits/award`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * #409 — classify a backend model to the IICP intent it serves. Embedding
 * models (name contains "embed") advertise the embedding intent; everything
 * else advertises the node's configured/default intent (chat). Conservative:
 * only embeddings are split out — the verified real case.
 */
export function intentForModel(model: string, defaultIntent: string): string {
  return model.toLowerCase().includes("embed") ? EMBEDDING_INTENT : defaultIntent;
}

/**
 * #408 / ADR-046 (B1/#414 — audio-in added) — input modalities a backend model
 * accepts. Vision-language models (name contains vl/vision/llava) accept images;
 * "omni" models accept image and audio; audio models (audio/voxtral) accept audio;
 * else text-only. Each is a modality of chat, not a separate intent. The directory +
 * spec accept text/image/audio/video in input_modalities (v0.10.0).
 */
export function modalitiesForModel(model: string): string[] {
  const m = model.toLowerCase();
  const hasImage =
    m.includes("-vl-") || m.endsWith("-vl") || m.includes("vision") || m.includes("llava") || m.includes("omni");
  const hasAudio = m.includes("audio") || m.includes("voxtral") || m.includes("omni");
  const mods = ["text"];
  if (hasImage) mods.push("image");
  if (hasAudio) mods.push("audio");
  return mods;
}

/**
 * #457 / ADR-040 — derive the native binary transport_endpoint from the HTTP `endpoint`.
 * They share one host:port (serve() multiplexes both planes on one socket via first-byte
 * detection), so the native URI is the same authority with the `iicp` scheme (`iicpsec`
 * for TLS). Returns null if the endpoint is not a parseable http(s) URL.
 */
export function deriveNativeEndpoint(endpoint: string): string | null {
  try {
    const u = new URL(endpoint);
    if (u.protocol === "http:") return `iicp://${u.host}`;
    if (u.protocol === "https:") return `iicpsec://${u.host}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * #409 + #408 — group detected backend models into one capability object per
 * (intent, input_modalities): advertise every intent the backend serves (chat +
 * embedding) AND distinguish text-only vs image-capable (vision) chat. The
 * directory accepts a multi-element capabilities array; clients pick the
 * per-(intent,modality) model from discover. Back-compatible: a single text chat
 * model yields the same single ["text"] capability. First-seen group leads.
 */
export function buildCapabilities(
  models: string[],
  defaultIntent: string,
  maxTokens: number,
): Array<{ intent: string; models: string[]; max_tokens: number; input_modalities: string[] }> {
  if (models.length === 0) {
    return [{ intent: defaultIntent, models: [], max_tokens: maxTokens, input_modalities: ["text"] }];
  }
  const order: string[] = [];
  const groups = new Map<string, { intent: string; models: string[]; input_modalities: string[] }>();
  for (const m of models) {
    const intent = intentForModel(m, defaultIntent);
    const modalities = modalitiesForModel(m);
    const key = `${intent}\0${modalities.join(",")}`;
    if (!groups.has(key)) {
      groups.set(key, { intent, models: [], input_modalities: modalities });
      order.push(key);
    }
    const g = groups.get(key)!;
    if (!g.models.includes(m)) g.models.push(m);
  }
  return order.map((key) => {
    const g = groups.get(key)!;
    return { intent: g.intent, models: g.models, max_tokens: maxTokens, input_modalities: g.input_modalities };
  });
}

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
  /** Detected backend server flavor: ollama/lmstudio/vllm/llamacpp/anthropic/custom. */
  backend?: string;
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
  /** ADR-043 §9 (#344) — 8-category exposure_mode; derived via qualifyService in the
   * serve flow and surfaced to the directory nodes.exposure_mode column. */
  exposureMode?: string;
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
  /** Phase 3+ availability windows (ADR-006). Each: {start,end:"HH:MM", share:0-1}
   * in local time. Shapes effective capacity advertised + gated. Empty → full. */
  availabilityWindows?: Window[];
  /** ADR-010 task_id idempotency. Off by default to preserve the pre-0.6 contract.
   * When true, a duplicate task_id within 5 min is rejected with IICP-E010. */
  enableIdempotency?: boolean;
  /** Phase 2 mesh (ADR-009/022). When true, serve() gossips peers and exposes
   * POST /v1/peers. Default false. */
  enableMesh?: boolean;
  /** When true, serve() exposes POST /v1/relay to forward tasks to peers learned
   * via gossip (ADR-022). Requires enableMesh. Default false. */
  relayCapable?: boolean;
  /** Port for the RelayAcceptServer (R1 relay-as-last-resort, #341).
   * Workers behind CGNAT connect outbound here and send RELAY_BIND.
   * Default 9485. */
  relayAcceptPort?: number;
  /** R2: when set, this node acts as a relay worker — connects outbound to
   * the specified relay. Format: "host:port" (e.g. "relay.example.com:9485").
   * env: IICP_RELAY_WORKER_ENDPOINT */
  relayWorkerEndpoint?: string;
  /** ADR-045 Phase A (#407) — optional operator→node delegation token (built by
   * the wallet via delegation.issueDelegation for this nodeId). When set,
   * register() attaches it; the directory verifies it offline + binds the
   * operator. Key lifecycle (gen/store/backup) is the wallet's concern (#307). */
  operatorDelegation?: Delegation;
  /** #463/#464 — operator-identity attributes advertised at register (bound only when the
   * delegation verifies). display_name is the public handle (node detail + leaderboard);
   * created_at + integrity_hash are identity-integrity. NEVER the operator's contact/email
   * or secret key. */
  operatorDisplayName?: string;
  operatorCreatedAt?: string;
  operatorIntegrityHash?: string;
  /** #494 — backend base URL for live model health probing during heartbeat.
   * When set, the heartbeat includes health_models=[current runtime list] so
   * the directory can filter stale-model nodes from discover. Omit for no probing. */
  backendUrl?: string;
  /** Bearer key for authenticated backends (LM Studio etc.). */
  backendApiKey?: string;
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
      "model" | "backend" | "region" | "capabilities" | "transportEndpoint" | "transportMethod" | "natType" | "transportMetadata" | "exposureMode" | "cipPolicy" | "pricing" | "nodeHmacKey" | "availabilityWindows" | "enableIdempotency" | "enableMesh" | "relayCapable" | "relayWorkerEndpoint" | "operatorDelegation" | "operatorDisplayName" | "operatorCreatedAt" | "operatorIntegrityHash" | "backendUrl" | "backendApiKey"
    >
  > & {
    model: string | undefined;
    backend: string | undefined;
    region: string | undefined;
    capabilities: string[];
    transportEndpoint: string | undefined;
    transportMethod: NodeConfig["transportMethod"];
    natType: NodeConfig["natType"];
    transportMetadata: Record<string, unknown> | undefined;
    exposureMode: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cipPolicy: any | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pricing: any | undefined;
    nodeHmacKey: string;
    availabilityWindows: Window[];
    enableIdempotency: boolean;
    enableMesh: boolean;
    relayCapable: boolean;
    relayAcceptPort: number;
    relayWorkerEndpoint: string | undefined;
    operatorDelegation: Delegation | undefined;
    operatorDisplayName: string | undefined;
    operatorCreatedAt: string | undefined;
    operatorIntegrityHash: string | undefined;
    backendUrl: string | undefined;
    backendApiKey: string | undefined;
  };
  private readonly _availability: AvailabilityEvaluator;
  private readonly _idempotency = new IdempotencyGuard();
  private readonly _peerManager: PeerManager;
  private _runtimeHmacKey: string = "";
  /** ADR-047 Part A (#411) — latest liveness nonce from the heartbeat response,
   * answered (HMAC) on the next beat. null until the first response. */
  private _livenessChallenge: string | null = null;
  /** BUG-5: token stashed by register() so deregister()/heartbeat don't need it re-passed. */
  private _runtimeToken: string = "";
  /** #343 — UPnP IPv6 pinhole UID captured by applyNatProfile, revoked on shutdown. */
  private _pinholeUid: number | null = null;
  private _pinholeLeaseSeconds = 3600;
  private _pinholeRenewalTimer: ReturnType<typeof setTimeout> | null = null;

  /** R1 relay-as-last-resort (#341): session registry for bound CGNAT workers. */
  private readonly _relaySessions = new RelaySessionRegistry();
  private _activeTasks = 0;
  private _nonces = new Map<string, number>(); // nonce → expiry timestamp (ms)
  // F4 (#524) — per-origin /v1/task fixed-window rate limit. Nodes answer CORS
  // for any origin, so a malicious page could script a visitor's browser into a
  // task proxy. Keyed by Origin header (else client IP). Default 120/60s;
  // IICP_TASK_RATE_LIMIT overrides (0 disables).
  private readonly _taskRateLimit = Number(process.env.IICP_TASK_RATE_LIMIT ?? "120");
  private readonly _taskRateWindowMs = 60_000;
  private _taskRateBuckets = new Map<string, { start: number; count: number }>();
  /** Incremental task counters drained on each heartbeat for directory reporting. */
  private _tasksSuccessPending = 0;
  private _tasksFailedPending = 0;
  private _tasksLatencyTotalMsPending = 0;
  /** #494 — model set registered at last register(); compared each heartbeat for drift. */
  private _registeredModels = new Set<string>();
  private _prom: PromLib | null = null;
  private _tasksCounter: PromCounter | null = null;
  private _latencyHistogram: PromHistogram | null = null;
  private _tokensCounter: PromCounter | null = null;
  private _backendStability = new BackendStabilityObservation();
  private _promLoaded = false;
  private readonly _cxPublicKey: CxPublicKey | undefined;
  private readonly _cxPrivateKeyBytes: Buffer | undefined;
  private readonly _cxPublicKeyBytes: Buffer | undefined;

  constructor(config: NodeConfig) {
    this._cfg = {
      nodeId: config.nodeId,
      backend: config.backend,
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
      exposureMode: config.exposureMode,
      cipPolicy: config.cipPolicy,
      pricing: config.pricing,
      nodeHmacKey: config.nodeHmacKey ?? "",
      availabilityWindows: config.availabilityWindows ?? [],
      enableIdempotency: config.enableIdempotency ?? false,
      enableMesh: config.enableMesh ?? false,
      relayCapable: config.relayCapable ?? false,
      relayAcceptPort: config.relayAcceptPort ?? 9485,
      relayWorkerEndpoint: config.relayWorkerEndpoint,
      operatorDelegation: config.operatorDelegation,
      operatorDisplayName: config.operatorDisplayName,
      operatorCreatedAt: config.operatorCreatedAt,
      operatorIntegrityHash: config.operatorIntegrityHash,
      backendUrl: config.backendUrl,
      backendApiKey: config.backendApiKey,
    };
    this._runtimeHmacKey = config.nodeHmacKey ?? "";
    try {
      const cx = loadOrCreateNodeCxKey(this._cfg.nodeId, this._cfg.endpoint);
      this._cxPublicKey = cx.publicKey;
      this._cxPrivateKeyBytes = cx.privateKeyBytes;
      this._cxPublicKeyBytes = cx.publicKeyBytes;
    } catch (exc) {
      console.warn(`[iicp-node] IICP-CX provider key unavailable; node will not advertise CX: ${exc instanceof Error ? exc.message : exc}`);
      this._cxPublicKey = undefined;
      this._cxPrivateKeyBytes = undefined;
      this._cxPublicKeyBytes = undefined;
    }
    this._availability = new AvailabilityEvaluator(this._cfg.availabilityWindows);
    this._peerManager = new PeerManager(this._cfg.directoryUrl, config.nodeHmacKey ?? "", {
      relayCapable: config.relayCapable ?? false,
      relayAcceptPort: config.relayAcceptPort ?? 9485,
    });
  }

  /** Effective concurrency cap after applying availability windows (ADR-006). */
  private _effectiveMaxConcurrent(): number {
    return this._availability.effectiveMaxConcurrent(this._cfg.maxConcurrent);
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

  private _backendStabilitySnapshot(): BackendStabilityObservation {
    return this._backendStability;
  }

  private _setBackendStability(observation: BackendStabilityObservation): void {
    // Keep an active drain until it expires unless the new observation is also
    // draining; a transient probe miss must not prematurely reopen admission.
    if (this._backendStability.isDraining() && !observation.isDraining()) return;
    this._backendStability = observation;
  }

  private async _observeBackendStability(): Promise<BackendStabilityObservation> {
    const obs = this._cfg.backendUrl
      ? await observeBackendStability({
          backendUrl: this._cfg.backendUrl,
          backend: this._cfg.backend,
          expectedModel: this._cfg.model,
          apiKey: this._cfg.backendApiKey ?? "",
        })
      : new BackendStabilityObservation();
    this._setBackendStability(obs);
    return obs;
  }

  // ── Directory operations ───────────────────────────────────────────────────

  /** Phase 2 (#529/#55) — seed a previously-cached node_token so the next
   * register() proves ownership via current_node_token (IICP-E050 token path). */
  seedToken(token: string): void {
    if (token) this._runtimeToken = token;
  }

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
      // #409 — one capability object per intent the backend can serve (e.g.
      // chat + embedding), classified from the detected model set.
      capabilities: buildCapabilities(models, this._cfg.intent, this._cfg.maxTokens),
      limits: {
        max_concurrent: this._cfg.maxConcurrent,
        tokens_per_min: this._cfg.tokensPerMin,
      },
    };
    if (this._cfg.nodeId) body.node_id = this._cfg.nodeId;
    // Phase 2 (#529/#55) — prove ownership on re-registration so an endpoint
    // change (rotating tunnel/CGNAT) is accepted via the IICP-E050 token path.
    // Sent only when a prior token is held; additive + backwards-compatible.
    if (this._runtimeToken) body.current_node_token = this._runtimeToken;
    // spec v0.7.0 — native IICP binary endpoint
    if (this._cfg.transportEndpoint) body.transport_endpoint = this._cfg.transportEndpoint;
    // #331 / ADR-041 — NAT-traversal observability (set manually or via
    // applyNatProfile after detectNat)
    if (this._cfg.transportMethod) body.transport_method = this._cfg.transportMethod;
    if (this._cfg.natType) body.nat_type = this._cfg.natType;
    if (this._cfg.transportMetadata) body.transport_metadata = this._cfg.transportMetadata;
    if (this._cfg.exposureMode) body.exposure_mode = this._cfg.exposureMode;
    // ADR-045 Phase A (#407) — attach the operator→node delegation when the
    // operator/wallet has issued one (built via delegation.issueDelegation for
    // this node_id). The directory verifies it offline and binds the operator.
    if (this._cfg.operatorDelegation) {
      body.operator_delegation = this._cfg.operatorDelegation;
      // #463/#464 — operator-identity attributes ride with the delegation (directory binds
      // them only when it verifies). Never contact/email or the secret key.
      if (this._cfg.operatorDisplayName) body.operator_display_name = this._cfg.operatorDisplayName;
      if (this._cfg.operatorCreatedAt) body.operator_created_at = this._cfg.operatorCreatedAt;
      if (this._cfg.operatorIntegrityHash) body.operator_integrity_hash = this._cfg.operatorIntegrityHash;
    }

    // SDK self-identification — directory surfaces these on /v1/discover
    // so dashboards can render a language badge. Free-form so future SDKs
    // (Go / Java / C / WASM) can self-tag without a directory change.
    body.sdk_language = "typescript";
    body.sdk_version = SDK_VERSION;
    Object.assign(body, autoUpdateStatusPayload());
    if (this._cxPublicKey) body.cx_public_key = this._cxPublicKey;
    if (this._cfg.backend) body.backend = this._cfg.backend;
    if (this._cfg.relayCapable) {
      body.relay_capable = true;
      body.relay_accept_port = this._cfg.relayAcceptPort;
    }

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
    // BUG-5: stash the token so deregister()/heartbeat don't need it re-passed.
    this._runtimeToken = token;
    // ADR-019: capture the directory-issued HMAC key for subsequent pricing
    // signatures. Operator-provisioned key wins when set.
    if (!this._runtimeHmacKey) {
      const dirKey = data.node_hmac_key;
      if (typeof dirKey === "string" && dirKey.length > 0) {
        this._runtimeHmacKey = dirKey;
      }
    }
    // #494 — track registered model set for drift detection.
    this._registeredModels = new Set(models);
    return token;
  }

  async heartbeat(nodeToken: string): Promise<void> {
    // Drain incremental task counters for directory reputation reporting.
    const ok = this._tasksSuccessPending;
    const fail = this._tasksFailedPending;
    const latencyTotalMs = this._tasksLatencyTotalMsPending;
    this._tasksSuccessPending = 0;
    this._tasksFailedPending = 0;
    this._tasksLatencyTotalMsPending = 0;

    const payload: Record<string, unknown> = {
      node_id: this._cfg.nodeId,
      node_token: nodeToken,
      status: "available",
      // Explicit availability boolean. The directory keys discover eligibility off
      // `available` (not the `status` string); sending it lets a node that briefly
      // went dormant (host sleep) be restored on the very next beat — robust even
      // against directory builds older than v1.10.17 whose heartbeat handler
      // defaulted to the stored (possibly false) value.
      available: true,
      // Live capacity after availability shaping (ADR-006).
      max_concurrent: this._effectiveMaxConcurrent(),
      ...autoUpdateStatusPayload(),
    };
    if (ok > 0 || fail > 0) {
      const metrics: Record<string, number> = { tasks_success: ok, tasks_failed: fail };
      const total = ok + fail;
      if (total > 0 && latencyTotalMs > 0) {
        metrics.avg_latency_ms = Math.round((latencyTotalMs / total) * 100) / 100;
      }
      payload.metrics = metrics;
    }
    // ADR-047 Part A (#411) — answer the directory's liveness challenge from the
    // previous beat: HMAC the nonce with node_hmac_key, proving key control with
    // no dial-back (works for CGNAT/IPv6). No-op until both nonce + key exist.
    if (this._livenessChallenge && this._runtimeHmacKey) {
      payload.challenge_response = createHmac("sha256", this._runtimeHmacKey)
        .update(this._livenessChallenge)
        .digest("hex");
    }
    // #494 — report live model list so the directory can filter stale-model nodes.
    if (this._cfg.backendUrl) {
      const healthModels = await this._probeHealthModels();
      if (healthModels !== null) payload.health_models = healthModels;
      const stability = await this._observeBackendStability();
      payload.backend_stability = stability.publicDict();
    }

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
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this._cfg.timeoutMs),
      }
    );
    if (!resp.ok) {
      // #399 — carry the status so the heartbeat loop can detect a
      // node-unknown rejection (401/404/410) and re-register.
      throw Object.assign(new Error(`Heartbeat failed: ${resp.status}`), {
        status: resp.status,
      });
    }
    // Capture the fresh nonce to answer on the next beat (ADR-047 Part A).
    try {
      const data = (await resp.json()) as { challenge?: string };
      if (data.challenge) this._livenessChallenge = data.challenge;
    } catch {
      // older directory without a challenge → leave as-is
    }
  }

  /**
   * #494 — probe the backend's live model list for health_models heartbeat reporting.
   * Tries Ollama /api/tags first, then OpenAI-compatible /v1/models. Returns null on
   * any error (probe failure is soft — heartbeat still sends without health_models).
   */
  private async _probeHealthModels(): Promise<string[] | null> {
    const base = (this._cfg.backendUrl ?? "").replace(/\/$/, "");
    if (!base) return null;
    const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
    const headers: Record<string, string> = {};
    if (this._cfg.backendApiKey) headers["Authorization"] = `Bearer ${this._cfg.backendApiKey}`;
    // Ollama /api/tags
    try {
      const r = await fetch(`${root}/api/tags`, { headers, signal: AbortSignal.timeout(2_000) });
      if (r.ok) {
        const d = (await r.json()) as { models?: { name?: string }[] };
        return [...new Set((d.models ?? []).flatMap((m) => (m.name ? [m.name] : [])))].sort();
      }
    } catch { /* fall through */ }
    // OpenAI-compatible /v1/models
    try {
      const r = await fetch(`${root}/v1/models`, { headers, signal: AbortSignal.timeout(2_000) });
      if (r.ok) {
        const d = (await r.json()) as { data?: { id?: string }[] };
        return (d.data ?? []).flatMap((m) => (m.id ? [m.id] : []));
      }
    } catch { /* fall through */ }
    return null;
  }

  /**
   * #494 — re-register when the backend's live model set diverges from registered.
   *
   * Only fires when the live list is non-empty (avoids spurious re-registration
   * during transient backend downtime). Soft: failure is logged, retried next tick.
   * Returns the fresh token when re-registration fires, otherwise the current token.
   */
  private async _maybeReregisterOnModelDrift(token: string): Promise<string> {
    if (!this._cfg.backendUrl || this._registeredModels.size === 0) return token;
    const live = await this._probeHealthModels();
    if (!live || live.length === 0) return token;
    const liveSet = new Set(live);
    if (liveSet.size === this._registeredModels.size && [...liveSet].every((m) => this._registeredModels.has(m)))
      return token;
    // Drift detected — update config and re-register.
    const liveSorted = [...liveSet].sort();
    this._cfg.model = liveSorted[0];
    this._cfg.capabilities = liveSorted.slice(1);
    try {
      const newToken = await this.register();
      return newToken;
    } catch {
      /* soft failure — retry next tick */
      return token;
    }
  }

  /**
   * #404 — one heartbeat tick: send a heartbeat, and on a node-unknown rejection
   * (401/404/410) re-register and return the fresh token. Returns the token to use
   * on the next tick. Extracted from the setInterval loop so the self-heal behavior
   * is unit-testable (the interval loop itself isn't).
   */
  async _heartbeatTick(token: string): Promise<string> {
    try {
      await this.heartbeat(token);
      // #494 — detect model list drift and re-register with the updated list.
      return await this._maybeReregisterOnModelDrift(token);
    } catch (err: unknown) {
      const status = (err as { status?: number } | undefined)?.status;
      if (status === 401 || status === 404 || status === 410) {
        try {
          return await this.register();
        } catch {
          /* re-registration failed — retry on the next tick with the same token */
        }
      }
      return token;
    }
  }

  /**
   * Tell the directory this node is going away.
   *
   * Mirrors iicp_client.IicpNode.deregister (Python iter-1471). Best-effort:
   * shutdown paths swallow failures so a flaky directory connection doesn't
   * block process exit.
   */
  async deregister(nodeToken?: string): Promise<void> {
    // BUG-5: default to the token stashed by register() so callers can simply
    // `await node.deregister()`. Explicit arg overrides.
    const token = nodeToken ?? this._runtimeToken;
    if (!token) {
      throw new Error("deregister() requires a node token (none stashed — call register() first)");
    }
    const resp = await fetch(
      `${this._cfg.directoryUrl.replace(/\/$/, "")}/v1/register`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ node_id: this._cfg.nodeId }),
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
    const port = options.port ?? 9484;
    const nodeToken = options.nodeToken;

    // Load Prometheus in background (non-blocking)
    this._ensureProm().catch(() => undefined);

    const server = http.createServer((req, res) => {
      // CORS on every endpoint (2026-06-12): web pages are first-class
      // consumers (iicp.network/browser-node dispatches /v1/task to https
      // nodes directly). CORS only ever gated browsers — curl was never
      // restricted — so this adds no capability, just removes the browser
      // block. setHeader merges with later writeHead headers.
      for (const [k, v] of Object.entries(RELAY_CORS_HEADERS)) res.setHeader(k, v);
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Max-Age": "86400" });
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/iicp/health") {
        this._handleHealth(res);
      } else if (req.method === "GET" && req.url === "/metrics") {
        this._handleMetrics(res);
      } else if (req.method === "POST" && req.url === "/v1/task") {
        this._handleTask(req, res, handler);
      } else if (req.method === "POST" && req.url === "/v1/peers" && this._cfg.enableMesh) {
        this._handlePeers(req, res);
      } else if (req.method === "POST" && req.url === "/v1/relay" && this._cfg.relayCapable) {
        this._handleRelay(req, res);
      } else if (req.method === "POST" && req.url === "/v1/relay/bind" && this._cfg.relayCapable) {
        this._handleRelayBind(req, res);
      } else if (req.method === "GET" && req.url === "/v1/relay/pull" && this._cfg.relayCapable) {
        this._handleRelayPull(req, res);
      } else if (req.method === "POST" && req.url === "/v1/relay/result" && this._cfg.relayCapable) {
        this._handleRelayResult(req, res);
      } else if (req.method === "POST" && req.url === "/v1/relay/unbind" && this._cfg.relayCapable) {
        this._handleRelayUnbind(req, res);
      } else if (
        req.method === "POST" &&
        req.url?.startsWith("/v1/relay-for/") &&
        req.url.endsWith("/v1/task") &&
        this._cfg.relayCapable
      ) {
        this._handleRelayForTask(req, res);
      } else if (
        req.method === "GET" &&
        req.url?.startsWith("/v1/relay-for/") &&
        req.url.endsWith("/iicp/health") &&
        this._cfg.relayCapable
      ) {
        this._handleRelayForHealth(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      }
    });

    // #457 / ADR-040 — native IICP binary transport on the SAME port as HTTP. A single
    // listener peeks the first bytes of each connection: the IICP frame magic ("IICP")
    // routes to the native handler, anything else (an HTTP request line) to the control
    // plane above. One socket ⇒ one pinhole ⇒ native is reachable exactly when HTTP is
    // (advertise-when-reachable), and CGNAT nodes need no second hole. The native handler
    // shares the same backend task handler as HTTP.
    const tcpServer = new IicpTcpServer({
      host,
      port,
      nodeId: this._cfg.nodeId,
      handler: ((t: { task_id: string; intent: string; payload: Record<string, unknown> }) =>
        handler({ task_id: t.task_id, intent: t.intent, payload: t.payload })) as TcpTaskHandler,
    });
    const mux = net.createServer((socket) => {
      socket.once("data", (chunk: Buffer) => {
        const isNative = chunk.length >= 4 && chunk.subarray(0, 4).equals(IICP_MAGIC);
        // Put the peeked bytes back so the chosen consumer parses from the start.
        socket.unshift(chunk);
        if (isNative) {
          void tcpServer.handleConnection(socket);
        } else {
          server.emit("connection", socket);
        }
      });
      socket.on("error", () => undefined);
    });
    mux.listen(port, host);

    let hbTimer: ReturnType<typeof setInterval> | undefined;
    // #404 — start the heartbeat loop when a token is present OR empty (register
    // failed → loop self-heals via re-register on 401). undefined = --skip-registration.
    if (nodeToken !== undefined) {
      let currentToken = nodeToken;
      hbTimer = setInterval(() => {
        void this._heartbeatTick(currentToken).then((t) => {
          currentToken = t;
        });
      }, HEARTBEAT_INTERVAL_MS);
    }
    if (this._cfg.enableMesh) {
      // Phase 2 mesh: bootstrap then gossip every 30s (managed inside PeerManager).
      void this._peerManager.start(this._cfg.nodeId, this._cfg.endpoint);
    }

    // R1: start RelayAcceptServer when relay-capable (#341)
    let relayAcceptSrv: import("./relay_session.js").RelayAcceptServer | undefined;
    if (this._cfg.relayCapable) {
      import("./relay_session.js").then(({ RelayAcceptServer: RAS }) => {
        relayAcceptSrv = new RAS(this._relaySessions, { host, port: this._cfg.relayAcceptPort, httpPort: port });
        relayAcceptSrv.start().catch((err) => {
          console.warn(`[iicp-node] relay accept server failed to start: ${err instanceof Error ? err.message : err}`);
        });
      }).catch(() => undefined);
    }

    // R2: start relay worker client if relayWorkerEndpoint is configured (#341)
    let stopRelayWorker: (() => void) | undefined;
    if (this._cfg.relayWorkerEndpoint) {
      const ep = this._cfg.relayWorkerEndpoint;
      const lastColon = ep.lastIndexOf(":");
      const relayHost = lastColon > 0 ? ep.slice(0, lastColon) : ep;
      const relayPortStr = lastColon > 0 ? ep.slice(lastColon + 1) : "9485";
      const relayPort = parseInt(relayPortStr, 10) || 9485;
      let currentToken = nodeToken;
      const self = this;
      const onBind = async (rHost: string, rPort: number, _wId: string) => {
        // Path-scoped endpoint (#450): consumers compose "{endpoint}/v1/task",
        // so the scoped path makes the relay forward to THIS worker's bound
        // session instead of executing the task on its own backend. rPort is
        // the relay's HTTP port (RELAY_ACK field 4).
        const newEndpoint = `http://${rHost}:${rPort}/v1/relay-for/${_wId}`;
        self["_cfg"].endpoint = newEndpoint;
        (self["_cfg"] as Record<string, unknown>).transportMethod = "turn_relay";
        if (currentToken) {
          try { await self.deregister(currentToken); } catch { /* best-effort */ }
        }
        try {
          const tok = await self.register();
          currentToken = tok ?? undefined;
          console.log(`[iicp-node] relay worker: re-registered with relay endpoint ${newEndpoint}`);
        } catch (exc) {
          console.warn(`[iicp-node] relay worker: re-registration failed: ${exc instanceof Error ? exc.message : exc}`);
        }
      };
      import("./relay_worker_client.js").then(({ RelayWorkerClient }) => {
        const rwc = new RelayWorkerClient({
          workerId: this._cfg.nodeId,
          intent: this._cfg.intent,
          relayHost,
          relayPort,
          handler: handler as never,
          models: this._cfg.model ? [this._cfg.model] : [],
          directoryUrl: this._cfg.directoryUrl,
          nodeToken: currentToken,
          onBind,
        });
        stopRelayWorker = rwc.start();
        console.log(`[iicp-node] relay worker started → ${relayHost}:${relayPort}`);
      }).catch(() => undefined);
    }

    return () => {
      if (hbTimer) clearInterval(hbTimer);
      this._peerManager.stop();
      if (stopRelayWorker) stopRelayWorker();
      if (relayAcceptSrv) relayAcceptSrv.stop().catch(() => undefined);
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
      mux.close(); // #457 — close the single-port multiplexer (owns the bound socket)
    };
  }

  // ── POST /v1/peers (ADR-009 gossip exchange) ────────────────────────────────

  private _handlePeers(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString() || "{}";
      const sig = req.headers["x-iicp-signature"] as string | undefined;
      if (!this._peerManager.verifyExchange(raw, sig)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "IICP-E012", message: "invalid_signature" } }));
        return;
      }
      try {
        const body = JSON.parse(raw) as { known_peers?: unknown[] };
        const incoming = (body.known_peers ?? []).filter(
          (p): p is Record<string, unknown> => typeof p === "object" && p !== null
        );
        this._peerManager.mergePeers(incoming as never[]);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "IICP-E000", message: "invalid JSON" } }));
        return;
      }
      const out = JSON.stringify({ peers: this._peerManager.getPeers() });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(out) });
      res.end(out);
    });
  }

  // ── POST /v1/relay (ADR-022 mesh relay) ─────────────────────────────────────

  private _handleRelay(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let payload: { target_node_id?: string; task?: unknown };
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "IICP-E000", message: "invalid JSON" } }));
        return;
      }
      const targetId = payload.target_node_id ?? "";
      const task = payload.task;
      if (!targetId || !task) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "IICP-E000", message: "target_node_id and task required" } }));
        return;
      }

      // R1: check relay session registry first (CGNAT workers with no inbound endpoint)
      const relaySession = this._relaySessions.get(targetId);
      if (relaySession) {
        try {
          const result = await relaySession.forwardTask(task);
          const taskId = (task as Record<string, unknown>).task_id ?? "";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ task_id: taskId, status: "completed", ...result }));
        } catch (exc) {
          const msg = exc instanceof Error ? exc.message : String(exc);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "IICP-E031", message: `relay session forward failed: ${msg}` } }));
        }
        return;
      }

      // Fall back to HTTP forwarding for routable peers (ADR-022)
      const target = this._peerManager.relayTarget(targetId);
      if (!target) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "IICP-E030", message: "target not in peer list and not a bound relay worker" } }));
        return;
      }
      try {
        const resp = await fetch(`${target.endpoint.replace(/\/$/, "")}/v1/task`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(task),
          signal: AbortSignal.timeout(120_000),
        });
        const text = await resp.text();
        res.writeHead(resp.status, { "Content-Type": "application/json" });
        res.end(text);
      } catch (exc) {
        const msg = exc instanceof Error ? exc.message : String(exc);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "IICP-E031", message: `relay failed: ${msg}` } }));
      }
    });
  }

  // ── HTTP long-poll relay worker transport (#450) ─────────────────────────────
  // Browser-compatible worker side: bind → pull (long-poll) → result. Same
  // RelaySessionRegistry as TCP RELAY_BIND workers; consumers reach both via
  // the path-scoped /v1/relay-for/<wid>/ endpoints. All responses carry CORS
  // headers (web pages are first-class callers of this transport).

  /** Resolve the Bearer token to a live HTTP-poll session, or undefined. */
  private _relayAuthedSession(req: http.IncomingMessage): HttpPollWorkerSession | undefined {
    const auth = (req.headers["authorization"] as string | undefined) ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return this._relaySessions.getByToken(token);
  }

  private _relayJson(res: http.ServerResponse, status: number, body: unknown): void {
    const out = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(out),
      ...RELAY_CORS_HEADERS,
    });
    res.end(out);
  }

  private _handleRelayBind(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let payload: { worker_id?: string; intent?: string; models?: unknown; bind_ticket?: unknown };
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        this._relayJson(res, 400, { error: { code: "IICP-E000", message: "invalid JSON" } });
        return;
      }
      const workerId = payload.worker_id ?? "";
      if (!workerId || typeof workerId !== "string") {
        this._relayJson(res, 422, { error: { code: "IICP-E001", message: "worker_id is required" } });
        return;
      }
      const bindTicket = typeof payload.bind_ticket === "string" ? payload.bind_ticket : "";
      const ticketPublicKey = process.env["IICP_RELAY_BIND_TICKET_PUBLIC_KEY"] ?? "";
      const requireBindTicket = process.env["IICP_RELAY_REQUIRE_BIND_TICKET"] === "1";
      if (bindTicket && ticketPublicKey) {
        const claims = verifyRelayBindTicket(bindTicket, ticketPublicKey, workerId, this._cfg.nodeId);
        if (!claims) {
          this._relayJson(res, 401, { error: { code: "IICP-E040", message: "relay bind ticket invalid" } });
          return;
        }
      } else if (requireBindTicket) {
        this._relayJson(res, 401, { error: { code: "IICP-E040", message: "relay bind ticket required" } });
        return;
      } else if (!bindTicket) {
        console.warn(`[iicp-node] HTTP-poll relay bind without ticket: ${workerId}`);
      }

      // #510 interim-C parity: never displace an ALIVE bound session.
      const existing = this._relaySessions.get(workerId);
      if (existing && existing.isAlive()) {
        this._relayJson(res, 409, {
          error: { code: "IICP-E038", message: "worker_id has an alive relay session — rebind rejected" },
        });
        return;
      }
      // Red-team F5: reject new binds past the session cap (bind-flood DoS).
      if (this._relaySessions.atCapacity(workerId)) {
        this._relayJson(res, 503, {
          error: { code: "IICP-E039", message: "relay at session capacity — try another relay" },
        });
        return;
      }
      const models = Array.isArray(payload.models) ? (payload.models as unknown[]).map(String) : [];
      const session = new HttpPollWorkerSession(workerId, {
        intent: String(payload.intent ?? ""),
        models,
      });
      this._relaySessions.bind(workerId, session);
      console.log(`[iicp-node] HTTP-poll relay worker bound: ${workerId} (models=${models.slice(0, 3).join(",")})`);
      this._relayJson(res, 200, {
        session_token: session.sessionToken,
        poll_timeout_s: 25,
        worker_endpoint_path: `/v1/relay-for/${workerId}`,
      });
    });
  }

  private _handleRelayPull(req: http.IncomingMessage, res: http.ServerResponse): void {
    const session = this._relayAuthedSession(req);
    if (!session) {
      this._relayJson(res, 401, { error: { code: "IICP-E021", message: "invalid or missing relay session token" } });
      return;
    }
    void session.nextCall(25_000).then((call) => {
      if (call === null) {
        res.writeHead(204, { ...RELAY_CORS_HEADERS });
        res.end();
        return;
      }
      this._relayJson(res, 200, call);
    });
  }

  private _handleRelayResult(req: http.IncomingMessage, res: http.ServerResponse): void {
    const session = this._relayAuthedSession(req);
    if (!session) {
      this._relayJson(res, 401, { error: { code: "IICP-E021", message: "invalid or missing relay session token" } });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let payload: { call_id?: string; result?: unknown };
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        this._relayJson(res, 400, { error: { code: "IICP-E000", message: "invalid JSON" } });
        return;
      }
      const callId = payload.call_id ?? "";
      const result = payload.result;
      if (!callId || typeof result !== "object" || result === null) {
        this._relayJson(res, 422, { error: { code: "IICP-E001", message: "call_id and result are required" } });
        return;
      }
      session.onResponse(callId, result as Record<string, unknown>);
      res.writeHead(204, { ...RELAY_CORS_HEADERS });
      res.end();
    });
  }

  private _handleRelayUnbind(req: http.IncomingMessage, res: http.ServerResponse): void {
    const session = this._relayAuthedSession(req);
    if (!session) {
      this._relayJson(res, 401, { error: { code: "IICP-E021", message: "invalid or missing relay session token" } });
      return;
    }
    session.close();
    this._relaySessions.unbind(session.workerId);
    console.log(`[iicp-node] HTTP-poll relay worker unbound: ${session.workerId}`);
    res.writeHead(204, { ...RELAY_CORS_HEADERS });
    res.end();
  }

  // ── Path-scoped worker endpoints: /v1/relay-for/<wid>/… ─────────────────────
  // Relay-bound workers register endpoint={relay}/v1/relay-for/<wid> with the
  // directory, so PUBLISHED consumers — which compose "{endpoint}/v1/task" —
  // route through the relay with no client changes.

  private _relayForWorkerId(req: http.IncomingMessage): string {
    const parts = (req.url ?? "").split("/");
    // ['', 'v1', 'relay-for', '<wid>', ...]
    return parts.length > 3 ? parts[3] : "";
  }

  private _handleRelayForTask(req: http.IncomingMessage, res: http.ServerResponse): void {
    const workerId = this._relayForWorkerId(req);
    const session = this._relaySessions.get(workerId);
    if (!session || !session.isAlive()) {
      this._relayJson(res, 404, { error: { code: "IICP-E030", message: "no alive relay session for this worker" } });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let task: Record<string, unknown>;
      try {
        task = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        this._relayJson(res, 400, { error: { code: "IICP-E000", message: "invalid JSON" } });
        return;
      }
      try {
        const result = await session.forwardTask(task, 120_000);
        this._relayJson(res, 200, { task_id: task.task_id ?? "", status: "completed", ...result });
      } catch (exc) {
        const msg = exc instanceof Error ? exc.message : String(exc);
        this._relayJson(res, 502, { error: { code: "IICP-E031", message: `relay session forward failed: ${msg}` } });
      }
    });
  }

  private _handleRelayForHealth(req: http.IncomingMessage, res: http.ServerResponse): void {
    const workerId = this._relayForWorkerId(req);
    const session = this._relaySessions.get(workerId);
    if (!session || !session.isAlive()) {
      this._relayJson(res, 404, { error: { code: "IICP-E030", message: "no alive relay session for this worker" } });
      return;
    }
    this._relayJson(res, 200, {
      status: "ok",
      node_id: workerId,
      via_relay: true,
      models: session instanceof HttpPollWorkerSession ? session.models : [],
    });
  }

  // ── GET /iicp/health ───────────────────────────────────────────────────────

  private _handleHealth(res: http.ServerResponse): void {
    const active = this._activeTasks;
    const max = this._cfg.maxConcurrent;
    const effMax = this._effectiveMaxConcurrent();
    const uid = this._pinholeUid;
    const pinholeState = uid != null
      ? { active: true, unique_id: uid, lease_seconds: this._pinholeLeaseSeconds }
      : { active: false };
    const allModels: string[] = this._cfg.model ? [this._cfg.model] : [];
    for (const m of this._cfg.capabilities) {
      if (!allModels.includes(m)) allModels.push(m);
    }
    const body = JSON.stringify({
      status: "ok",
      node_id: this._cfg.nodeId,
      region: this._cfg.region ?? "unknown",
      load: max > 0 ? active / max : 0,
      active_jobs: active,
      max_concurrent: max,
      effective_max_concurrent: effMax,
      available: active < effMax,
      model: this._cfg.model ?? "",
      models: allModels,
      intent: this._cfg.intent,
      pinhole_state: pinholeState,
      backend_stability: this._backendStabilitySnapshot().publicDict(),
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

  /**
   * QoS-aware admission. Resolves true once a slot is free, false if capacity
   * stays full. realtime/interactive wait up to QUEUE_WAIT_MS; other tiers fail
   * fast. The check-then-increment is non-atomic but safe in the single-threaded
   * event loop (advisory back-pressure, matching the prior counter gate).
   */
  private async _admit(qos: string): Promise<boolean> {
    // Effective cap folds in availability windows (ADR-006): a reduced/closed
    // window lowers capacity below maxConcurrent.
    const cap = this._effectiveMaxConcurrent();
    if (this._activeTasks < cap) return true;
    if (!isQueueEligible(qos)) return false;
    const deadline = Date.now() + QUEUE_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (this._activeTasks < this._effectiveMaxConcurrent()) return true;
    }
    return false;
  }

  /** F4 (#524) fixed-window per-origin admission for /v1/task. */
  private _taskRateAllow(key: string): boolean {
    const now = Date.now();
    let b = this._taskRateBuckets.get(key);
    if (!b || now - b.start >= this._taskRateWindowMs) {
      b = { start: now, count: 0 };
    }
    b.count += 1;
    this._taskRateBuckets.set(key, b);
    if (this._taskRateBuckets.size > 4096) {
      const cutoff = now - this._taskRateWindowMs;
      for (const [k, v] of this._taskRateBuckets) {
        if (v.start < cutoff) this._taskRateBuckets.delete(k);
      }
    }
    return b.count <= this._taskRateLimit;
  }

  private _handleTask(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: TaskHandler
  ): void {
    // F4 (#524) — rate-limit browser-origin task dispatch (the CORS confused-
    // deputy vector) only. Non-browser callers send no Origin and are the
    // operator's own authed traffic — never throttled.
    const origin = req.headers["origin"] as string | undefined;
    if (this._taskRateLimit > 0 && origin) {
      if (!this._taskRateAllow(origin)) {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Retry-After": String(this._taskRateWindowMs / 1000),
        });
        res.end(JSON.stringify({ error: { code: "IICP-E023", message: "per-origin task rate limit exceeded" } }));
        return;
      }
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let task: Record<string, unknown> = {};
      try {
        task = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "IICP-E000", message: "invalid JSON" } }));
        return;
      }

      const intent = (task.intent as string | undefined) ?? this._cfg.intent;
      const constraints = task.constraints as Record<string, unknown> | undefined;
      const qos = (constraints?.qos_class as string | undefined) ?? "best_effort";
      const taskId = (task.task_id as string | undefined) ?? "";
      const queryingNodeId = (task.source_node_id as string | undefined) ?? undefined;

      // #403 — CIP per-task admission gate (parity with the adapter cip_gate):
      // reject tool-execution-domain intents unless the operator opted in via
      // cipPolicy.allowToolExecution.
      const cipPol = this._cfg.cipPolicy ?? getCipPolicy();
      if (cipPol && typeof cipPol.permitsIntent === "function" && !cipPol.permitsIntent(intent)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "tool_execution_denied",
              message: "Tool-execution intents are not permitted by this node's CIP policy",
            },
          }),
        );
        return;
      }

      // #553 / WQ-179 — provider-local backend drain guard.
      const stability = this._backendStabilitySnapshot();
      const retryAfter = stability.retryAfterS();
      if (stability.isDraining() && retryAfter !== null) {
        const body = JSON.stringify({
          error: {
            code: "IICP-E024",
            message: "backend temporarily draining",
            reason: stability.reasonClass,
            retry_after_ms: retryAfter * 1000,
          },
        });
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      // QoS-aware admission — IICP-E021. realtime/interactive wait briefly for a
      // slot; batch/best-effort/unspecified fail fast (ADR-006; see scheduler.ts).
      void this._admit(qos).then((admitted) => {
        if (!admitted) {
          const body = JSON.stringify({
            error: {
              code: "IICP-E021",
              message: "capacity_exceeded",
              qos_class: qos,
              retry_after_ms: 2000,
            },
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

        // Nonce replay — IICP-E011
        if (!this._checkNonce(task.nonce as string | undefined)) {
          this._activeTasks--;
          const body = JSON.stringify({ error: { code: "IICP-E011", message: "replay_detected" } });
          res.writeHead(409, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
          res.end(body);
          return;
        }

        // Idempotency — duplicate task_id within the retry window (ADR-010). Opt-in
        // (enableIdempotency) to preserve the pre-0.6 contract.
        if (
          this._cfg.enableIdempotency &&
          !this._idempotency.checkAndRegister(task.task_id as string | undefined)
        ) {
          this._activeTasks--;
          const body = JSON.stringify({ error: { code: "IICP-E010", message: "duplicate_task" } });
          res.writeHead(409, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
          res.end(body);
          return;
        }

        if (task.iicp_conf && typeof task.iicp_conf === "object" && task.payload === undefined) {
          if (!this._cxPrivateKeyBytes || !this._cxPublicKeyBytes) {
            this._activeTasks--;
            const body = JSON.stringify({ error: { code: "IICP-CX-01", message: "node has no CX private key" } });
            res.writeHead(400, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
            res.end(body);
            return;
          }
          try {
            task.payload = decryptPayload(
              task.iicp_conf as Record<string, unknown>,
              this._cxPrivateKeyBytes,
              this._cxPublicKeyBytes,
            );
            task._cx_encrypted = true;
          } catch (exc) {
            this._activeTasks--;
            const msg = exc instanceof Error ? exc.message : String(exc);
            const body = JSON.stringify({ error: { code: "IICP-CX-02", message: `iicp_conf decrypt failed: ${msg}` } });
            res.writeHead(400, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
            res.end(body);
            return;
          }
        }

        // W3C traceparent propagation
        const tp = req.headers["traceparent"] as string | undefined;
        if (tp) (task as Record<string, unknown>)._trace = { traceparent: tp };

      // ADR-014 — OTel validate span (nonce + auth check already done above; span marks boundary)
      import("./otel_tracer.js").then(({ withTaskValidateSpan, withTaskExecuteSpan }) => {
        withTaskValidateSpan(taskId, () => undefined);
        return withTaskExecuteSpan(taskId, intent, () => handler(task));
      }).catch(() => handler(task))
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
          this._tasksSuccessPending++;
          if (latencyMs > 0) this._tasksLatencyTotalMsPending += latencyMs;
          const body = JSON.stringify({ task_id: taskId, status: "completed", ...result });
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
          res.end(body);
          // TC-9c: fire best-effort CIPWorkerReceipt to the directory (server-side award path).
          if (this._runtimeHmacKey && this._runtimeToken) {
            void this._postCipReceipt(taskId, tokens, result, queryingNodeId);
          }
        })
        .catch((err: Error) => {
          this._activeTasks--;
          if (this._tasksCounter) {
            (this._tasksCounter as unknown as { labels: (...args: unknown[]) => { inc: () => void } })
              .labels("error", intent, qos).inc();
          }
          this._tasksFailedPending++;
          const latencyMs = Date.now() - t0;
          if (latencyMs > 0) this._tasksLatencyTotalMsPending += latencyMs;
          const body = JSON.stringify({ task_id: taskId, status: "error", error: { message: err.message } });
          res.writeHead(500, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
          res.end(body);
        });
      });
    });
  }

  /**
   * TC-9c: POST a CIPWorkerReceipt to /v1/credits/award after a successful task.
   * Server-side credit award path — the node reports completion directly so the
   * directory credits the provider wallet without proxy forwarding.
   * Best-effort: errors are swallowed so they never affect the task response.
   */
  private async _postCipReceipt(
    taskId: string,
    tokensUsed: number,
    result: Record<string, unknown>,
    queryingNodeId?: string,
  ): Promise<void> {
    try {
      await postCipReceipt({
        directoryUrl: this._cfg.directoryUrl,
        token: this._runtimeToken,
        hmacKey: this._runtimeHmacKey,
        nodeId: this._cfg.nodeId,
        taskId,
        tokensUsed,
        result,
        queryingNodeId,
      });
    } catch {
      // Best-effort: never propagate to caller.
    }
  }
}

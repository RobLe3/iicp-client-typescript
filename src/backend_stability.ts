// SPDX-License-Identifier: Apache-2.0
/** Provider-local backend stability observer and drain guard (#553).
 *
 * Conservative by design: read-only probes only, coarse public output, no
 * automatic model load/unload orchestration and no host-safety guarantee.
 */

export type BackendState = "ok" | "degraded" | "draining";
export type BackendReason = "ok" | "backend_cold" | "backend_loading" | "backend_unstable" | "observer_error";

export interface BackendStabilityObservationInit {
  backendState?: BackendState;
  reasonClass?: BackendReason;
  drainUntilMs?: number | null;
  observedAtMs?: number;
  diagnostics?: Record<string, unknown>;
}

export class BackendStabilityObservation {
  backendState: BackendState;
  reasonClass: BackendReason;
  drainUntilMs: number | null;
  observedAtMs: number;
  diagnostics: Record<string, unknown>;

  constructor(init: BackendStabilityObservationInit = {}) {
    this.backendState = init.backendState ?? "ok";
    this.reasonClass = init.reasonClass ?? "ok";
    this.drainUntilMs = init.drainUntilMs ?? null;
    this.observedAtMs = init.observedAtMs ?? Date.now();
    this.diagnostics = init.diagnostics ?? {};
  }

  retryAfterS(nowMs = Date.now()): number | null {
    if (this.drainUntilMs === null) return null;
    const remaining = this.drainUntilMs - nowMs;
    if (remaining <= 0) return null;
    return Math.max(1, Math.round(remaining / 1000));
  }

  isDraining(nowMs = Date.now()): boolean {
    return this.backendState === "draining" && this.retryAfterS(nowMs) !== null;
  }

  publicDict(nowMs = Date.now()): Record<string, unknown> {
    const body: Record<string, unknown> = {
      backend_state: this.backendState,
      reason_class: this.reasonClass,
    };
    const retry = this.retryAfterS(nowMs);
    if (retry !== null) {
      body.retry_after_s = retry;
      body.drain_until = Math.floor((this.drainUntilMs ?? 0) / 1000);
    }
    return body;
  }
}

function norm(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
}

function modelMatches(candidate: string, expectedModel?: string): boolean {
  if (!expectedModel) return true;
  return candidate === expectedModel || candidate.split(":", 1)[0] === expectedModel.split(":", 1)[0];
}

export function parseOllamaPs(data: unknown, expectedModel?: string): BackendStabilityObservation {
  const models = typeof data === "object" && data !== null && Array.isArray((data as { models?: unknown }).models)
    ? (data as { models: unknown[] }).models
    : null;
  if (!models) return new BackendStabilityObservation({ backendState: "degraded", reasonClass: "observer_error" });
  const names = models.flatMap((m) => {
    if (typeof m !== "object" || m === null) return [];
    const name = (m as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
  const loadedExpected = names.some((name) => modelMatches(name, expectedModel));
  if (expectedModel && !loadedExpected) {
    return new BackendStabilityObservation({
      backendState: "degraded",
      reasonClass: "backend_cold",
      diagnostics: { loaded_model_count: names.length, expected_model_loaded: false },
    });
  }
  return new BackendStabilityObservation({ diagnostics: { loaded_model_count: names.length } });
}

export function parseLmStudioModels(
  data: unknown,
  expectedModel?: string,
  opts: { nowMs?: number; loadingRetryS?: number; unstableRetryS?: number } = {},
): BackendStabilityObservation {
  const nowMs = opts.nowMs ?? Date.now();
  const obj = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
  const rawModels = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : null;
  if (!rawModels) {
    return new BackendStabilityObservation({ backendState: "degraded", reasonClass: "observer_error", observedAtMs: nowMs });
  }
  let sawExpected = !expectedModel;
  let sawLoadedExpected = false;
  let sawLoading = false;
  let sawUnstable = false;
  let loadedCount = 0;
  for (const item of rawModels) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const modelId = String(rec.id ?? rec.model_key ?? rec.path ?? "");
    const expected = modelMatches(modelId, expectedModel);
    sawExpected = sawExpected || expected;
    const instancesRaw = Array.isArray(rec.loaded_instances)
      ? rec.loaded_instances
      : Array.isArray(rec.loadedInstances) ? rec.loadedInstances : [];
    for (const inst of instancesRaw) {
      if (typeof inst !== "object" || inst === null) continue;
      loadedCount += 1;
      if (expected) sawLoadedExpected = true;
      const state = norm((inst as Record<string, unknown>).state ?? (inst as Record<string, unknown>).status ?? (inst as Record<string, unknown>).load_status);
      if (["loading", "initializing", "starting", "warming", "warming_up"].includes(state)) sawLoading = true;
      if (["error", "failed", "crashed", "unhealthy", "oom", "out_of_memory"].includes(state)) sawUnstable = true;
    }
  }
  if (sawUnstable) {
    return new BackendStabilityObservation({
      backendState: "draining",
      reasonClass: "backend_unstable",
      drainUntilMs: nowMs + (opts.unstableRetryS ?? 60) * 1000,
      observedAtMs: nowMs,
      diagnostics: { loaded_instance_count: loadedCount },
    });
  }
  if (sawLoading) {
    return new BackendStabilityObservation({
      backendState: "draining",
      reasonClass: "backend_loading",
      drainUntilMs: nowMs + (opts.loadingRetryS ?? 30) * 1000,
      observedAtMs: nowMs,
      diagnostics: { loaded_instance_count: loadedCount },
    });
  }
  if (expectedModel && (!sawExpected || !sawLoadedExpected)) {
    return new BackendStabilityObservation({
      backendState: "degraded",
      reasonClass: "backend_cold",
      observedAtMs: nowMs,
      diagnostics: { loaded_instance_count: loadedCount, expected_model_loaded: false },
    });
  }
  return new BackendStabilityObservation({ observedAtMs: nowMs, diagnostics: { loaded_instance_count: loadedCount } });
}

export async function observeBackendStability(opts: {
  backendUrl: string;
  backend?: string;
  expectedModel?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<BackendStabilityObservation> {
  const base = opts.backendUrl.replace(/\/$/, "");
  if (!base) return new BackendStabilityObservation({ backendState: "degraded", reasonClass: "observer_error" });
  const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
  const flavor = norm(opts.backend);
  const headers: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  const f = opts.fetchImpl ?? fetch;
  const signal = () => AbortSignal.timeout(opts.timeoutMs ?? 2000);
  try {
    if (flavor === "ollama" || flavor === "") {
      const r = await f(`${root}/api/ps`, { headers, signal: signal() });
      if (r.ok) return parseOllamaPs(await r.json(), opts.expectedModel);
      if (flavor === "ollama") return new BackendStabilityObservation({ backendState: "degraded", reasonClass: "observer_error" });
    }
    if (["lmstudio", "lm_studio", "lm_studio_server", ""].includes(flavor)) {
      const r = await f(`${root}/api/v1/models`, { headers, signal: signal() });
      if (r.ok) return parseLmStudioModels(await r.json(), opts.expectedModel);
      if (flavor) return new BackendStabilityObservation({ backendState: "degraded", reasonClass: "observer_error" });
    }
  } catch {
    return new BackendStabilityObservation({ backendState: "degraded", reasonClass: "observer_error" });
  }
  return new BackendStabilityObservation();
}

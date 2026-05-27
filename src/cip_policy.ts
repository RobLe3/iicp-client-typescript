// SPDX-License-Identifier: Apache-2.0
/**
 * CIP-W01/CIP-W02 provider-side policy gate — S.12, ADR-012.
 *
 * TypeScript port of iicp-client-python's cip_policy.py (iter-1429).
 *
 * The Cooperative Inference Profile gives a node three operator-controlled
 * roles (consumer / coordinator / worker). Safe Phase-4 defaults: all three
 * are OFF until the operator opts in. The capacity gate enforces S.12 §2.2:
 * worker tasks at capacity MUST return IICP-E021 rather than silently queue.
 */

export interface CooperativeInferencePolicyOptions {
  enabled?: boolean;
  allowCoordinator?: boolean;
  allowWorker?: boolean;
  maxReplicas?: number;
  /** Bounded to [1, 60000]ms. */
  maxWorkerTimeoutMs?: number;
  maxConcurrentRemote?: number;
}

/** Safe-by-default CIP policy with the S.12 §2.2 capacity gate built-in. */
export class CooperativeInferencePolicy {
  readonly enabled: boolean;
  readonly allowCoordinator: boolean;
  readonly allowWorker: boolean;
  readonly maxReplicas: number;
  readonly maxWorkerTimeoutMs: number;
  readonly maxConcurrentRemote: number;
  private _inFlight = 0;

  constructor(opts: CooperativeInferencePolicyOptions = {}) {
    this.enabled = opts.enabled ?? false;
    this.allowCoordinator = opts.allowCoordinator ?? false;
    this.allowWorker = opts.allowWorker ?? false;
    this.maxReplicas = Math.max(1, opts.maxReplicas ?? 3);
    this.maxWorkerTimeoutMs = Math.max(1, Math.min(60_000, opts.maxWorkerTimeoutMs ?? 30_000));
    this.maxConcurrentRemote = Math.max(1, opts.maxConcurrentRemote ?? 2);
  }

  /** CIP-W01: returns true if this node may act as a CIP coordinator. */
  checkCoordinator(): boolean {
    return this.enabled && this.allowCoordinator;
  }

  /** CIP-W02: returns true if this node may accept CIP worker tasks. */
  checkWorker(): boolean {
    return this.enabled && this.allowWorker;
  }

  /**
   * CIP-A1-GATE-06: try to acquire a worker concurrency slot. Returns true
   * on success — caller MUST call releaseCipSlot() when done. Returns false
   * when at capacity, in which case the caller MUST respond with IICP-E021
   * rather than queue or delay (S.12 §2.2 explicit non-silent-queue rule).
   */
  tryAcquireCipSlot(): boolean {
    if (this._inFlight >= this.maxConcurrentRemote) return false;
    this._inFlight += 1;
    return true;
  }

  /** Release a slot acquired via tryAcquireCipSlot(). */
  releaseCipSlot(): void {
    if (this._inFlight > 0) this._inFlight -= 1;
  }

  /**
   * Build the `policy` sub-object the directory expects in /v1/register.
   * Only emits keys when CIP is enabled — disabled-by-default operators
   * shouldn't clutter the payload with `allow_*: false`.
   */
  asRegisterPolicyBlock(): Record<string, unknown> {
    if (!this.enabled) return {};
    return {
      allow_remote_inference: this.allowWorker,
    };
  }
}

// ── Module-level default policy ──────────────────────────────────────────

let _policy: CooperativeInferencePolicy = new CooperativeInferencePolicy();

/** Return the active CIP policy (safe defaults until configureCipPolicy is called). */
export function getCipPolicy(): CooperativeInferencePolicy {
  return _policy;
}

/** Replace the module-level CIP policy. Returns the new policy for chaining. */
export function configureCipPolicy(
  opts: CooperativeInferencePolicyOptions = {}
): CooperativeInferencePolicy {
  _policy = new CooperativeInferencePolicy(opts);
  return _policy;
}

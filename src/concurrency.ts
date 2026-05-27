// SPDX-License-Identifier: Apache-2.0
/**
 * Unified concurrency gate for the hybrid client.
 *
 * TypeScript port of iicp-client-python's concurrency.py (iter-1438).
 * Tier 2 Item 5 of #340. Caps simultaneous inference tasks at
 * `max_concurrent` from the node's registration envelope; when full the
 * SDK responds with IICP-E021 (429) on whichever transport carries the
 * CALL — HTTP /v1/task OR native IICP TCP RESPONSE frame.
 *
 * Non-blocking acquire — CapacityExceededError raises immediately rather
 * than queueing. The proxy MUST learn back-pressure right away so it
 * can route elsewhere (ADR-008). Queueing would mask overload.
 */

/** Raised by [`ConcurrencyGate.acquire`] when the gate is at capacity. */
export class CapacityExceededError extends Error {
  readonly maxConcurrent: number;
  constructor(maxConcurrent: number) {
    super(`max_concurrent (${maxConcurrent}) reached`);
    this.name = "CapacityExceededError";
    this.maxConcurrent = maxConcurrent;
  }
}

/**
 * Cap simultaneous inference tasks. Single shared primitive across HTTP
 * and native IICP transports so the directory's NodeScorer sees the same
 * back-pressure regardless of which transport carried the CALL.
 *
 * Usage::
 *
 *   const gate = new ConcurrencyGate(4);
 *   try {
 *     await gate.acquire();
 *     try {
 *       await runTask();
 *     } finally {
 *       gate.release();
 *     }
 *   } catch (e) {
 *     if (e instanceof CapacityExceededError) return { error_code: 429, ... };
 *     throw e;
 *   }
 *
 * Or via the `run()` helper that auto-releases:
 *
 *   const result = await gate.run(async () => runTask());
 */
export class ConcurrencyGate {
  readonly maxConcurrent: number;
  private _active = 0;

  constructor(maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error(`max_concurrent must be >= 1, got ${maxConcurrent}`);
    }
    this.maxConcurrent = maxConcurrent;
  }

  /** Non-blocking acquire. Throws CapacityExceededError when full. */
  acquire(): void {
    if (this._active >= this.maxConcurrent) {
      throw new CapacityExceededError(this.maxConcurrent);
    }
    this._active += 1;
  }

  /** Release a slot acquired via [`acquire`]. */
  release(): void {
    if (this._active > 0) this._active -= 1;
  }

  /** Convenience: run `fn` while holding a slot, releasing on success or error. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get activeJobs(): number {
    return this._active;
  }

  /** Load fraction in [0, 1]. Reported in heartbeats so the NodeScorer can
   * down-rank busy nodes (ADR-008). */
  get load(): number {
    if (this.maxConcurrent === 0) return 1.0;
    return this._active / this.maxConcurrent;
  }
}

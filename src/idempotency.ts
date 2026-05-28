// SPDX-License-Identifier: Apache-2.0
/**
 * Idempotency guard — task_id dedup with TTL eviction (parity Block E, #340).
 *
 * Port of iicp-adapter `services/idempotency.py` (ADR-010). Prevents duplicate task
 * execution when a proxy retries a CALL. Distinct from the nonce replay cache: nonce
 * protects a signed request from replay; this dedups on `task_id`. In-memory, 5-minute
 * TTL, lazy eviction. Cross-restart dedup is intentionally not provided.
 */

const TTL_MS = 300_000; // 5-minute window — matches ADR-010 §3 and the nonce cache.

export class IdempotencyGuard {
  private seen = new Map<string, number>(); // task_id → expiry (ms epoch)
  private readonly ttlMs: number;

  constructor(ttlMs: number = TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** True if task_id is new; false if a duplicate within the TTL. Empty id → always new. */
  checkAndRegister(taskId: string | null | undefined): boolean {
    if (!taskId) return true;
    const now = Date.now();
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
    if (this.seen.has(taskId)) return false;
    this.seen.set(taskId, now + this.ttlMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

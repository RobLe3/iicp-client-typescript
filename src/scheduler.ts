// SPDX-License-Identifier: Apache-2.0
/**
 * QoS-aware admission policy for the provider serve path (parity Block C, #340).
 *
 * Port of the QoS *contract* from iicp-adapter `scheduling/queue.py`. The adapter runs a
 * full PriorityQueue dispatcher; the SDK serve gate is deliberately fail-fast (queuing
 * would hide overload from the proxy). To close the cat-8 parity gap without contradicting
 * that design, the SDK applies QoS-aware admission:
 *
 *   - realtime / interactive → queue-eligible: wait briefly (QUEUE_WAIT_MS) for a slot.
 *   - batch / best-effort / unspecified → fail fast with IICP-E021.
 *
 * Priority ordering (lower = higher priority) is exposed for telemetry parity.
 */

// Lower value = higher priority. Both spellings accepted (adapter uses "best-effort").
export const QOS_PRIORITY: Record<string, number> = {
  realtime: 0,
  interactive: 1,
  batch: 2,
  best_effort: 3,
  "best-effort": 3,
};

/** Tiers that wait briefly for a slot rather than failing fast at capacity. */
export const QUEUE_ELIGIBLE: ReadonlySet<string> = new Set(["realtime", "interactive"]);

/** Bounded wait for queue-eligible tiers (ms). */
export const QUEUE_WAIT_MS = 2000;

/** Priority rank for a QoS class (lower = higher priority; unknown → 3). */
export function qosPriority(qos: string | null | undefined): number {
  if (qos == null) return 3;
  return QOS_PRIORITY[qos] ?? 3;
}

/** True if a task of this QoS class should wait briefly for a slot at capacity. */
export function isQueueEligible(qos: string | null | undefined): boolean {
  return qos != null && QUEUE_ELIGIBLE.has(qos);
}

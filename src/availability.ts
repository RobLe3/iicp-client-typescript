// SPDX-License-Identifier: Apache-2.0
/**
 * Time-based availability windows — operator capacity shaping by time-of-day.
 *
 * Port of iicp-adapter `scheduling/availability.py` (parity Block D, #340). Lets an
 * operator dedicate different fractions of `maxConcurrent` at different times.
 *
 *   - start/end: "HH:MM" in local time.
 *   - share: fraction of maxConcurrent (0.0 = closed, 1.0 = full).
 *   - Outside all windows: 0.5 (available but not primary).
 *   - No windows: always 1.0.
 *
 * The directory learns live load via heartbeats and scores accordingly (ADR-001) — it
 * doesn't push scheduling to nodes.
 */

export interface Window {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  share: number; // 0.0–1.0
}

function hhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export class AvailabilityEvaluator {
  private readonly windows: Window[];

  constructor(windows?: Window[] | null) {
    this.windows = windows ?? [];
  }

  /** Capacity share [0,1] for the current local time-of-day. */
  currentShare(now: Date = new Date()): number {
    if (this.windows.length === 0) return 1.0;
    const current = hhmm(now);
    for (const w of this.windows) {
      if (w.start <= w.end) {
        if (w.start <= current && current <= w.end) return w.share;
      } else {
        // Midnight-spanning window (e.g. 22:00–06:00)
        if (current >= w.start || current <= w.end) return w.share;
      }
    }
    return 0.5; // outside all windows
  }

  /** Scale base maxConcurrent by the current share (floor 1 when share > 0).
   * A base of 0 (operator explicitly disabled) stays 0. */
  effectiveMaxConcurrent(baseMax: number, now: Date = new Date()): number {
    if (baseMax <= 0) return 0;
    const share = this.currentShare(now);
    if (share <= 0.0) return 0;
    return Math.max(1, Math.floor(baseMax * share));
  }

  isWithinWindow(now: Date = new Date()): boolean {
    if (this.windows.length === 0) return true;
    return this.currentShare(now) > 0.0;
  }
}

// SPDX-License-Identifier: Apache-2.0
/**
 * Self-updater for provider nodes (#521 WQ-089).
 *
 * `iicp-node update` still supports the safe read-only version check, but
 * normal long-running `iicp-node serve` processes now also run a default-on
 * background loop: check npm hourly (first check within five minutes), install
 * `@iicp/client@latest` when a newer stable release exists, and restart onto
 * the upgraded package in covered service paths. The loop is
 * failure-isolated and opt-out via `IICP_AUTO_UPDATE=0`.
 */

const NPM_URL = "https://registry.npmjs.org/@iicp/client/latest";
const DEFAULT_AUTO_UPDATE_INTERVAL_S = 3600;
let sdkLatestSeen: string | null = null;
let sdkUpdateLastCheckedAt: string | null = null;
let sdkUpdateErrorClass: string | null = null;

/** Parse a dotted version into a comparable tuple; truncate at the first
 * non-numeric segment ('1.2.3-rc1' → [1,2,3]). */
export function parseVersion(v: string): number[] {
  const out: number[] = [];
  for (const part of v.trim().replace(/^[vV]/, "").split(".")) {
    const m = /^\d+/.exec(part);
    if (!m) break;
    out.push(parseInt(m[0], 10));
  }
  return out;
}

/** True when `latest` is strictly newer than `current` (numeric, not lex). */
export function isOutdated(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

/** Fetch @iicp/client's latest published version, or null on any error. */
export async function latestNpmVersion(timeoutMs = 5000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(NPM_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export interface UpdateVerdict {
  current: string;
  latest: string | null;
  outdated: boolean;
  command: string;
}

export function checkUpdate(current: string, latest: string | null): UpdateVerdict {
  return {
    current,
    latest,
    outdated: latest !== null && isOutdated(current, latest),
    command: "npm install -g @iicp/client@latest",
  };
}

// ── P2 — background self-updater (#521) ─────────────────────────────────────────
// A node running `serve` periodically checks npm and, on a newer release, upgrades
// (`npm install -g`) and re-execs onto it. This removes the manual-upgrade
// dependency in covered service paths. Nodes older than the hardened 0.7.67 serve
// wiring may need one manual upgrade/restart first. Default-on; opt out with
// IICP_AUTO_UPDATE=0. Loop-safe (post-upgrade running version == latest) and failure-isolated.

import { spawn } from "node:child_process";

/** `npm install -g @iicp/client@latest` in a subprocess. Resolves true on success. */
export async function performSelfUpdate(
  spec = "@iicp/client@latest",
  npmBin = "npm",
  timeoutMs = 600_000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn(npmBin, ["install", "-g", spec], { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(false);
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    } catch {
      finish(false);
    }
  });
}

/** Re-exec the current command so the upgraded global package is loaded. Node has no
 * in-place execv, so we spawn a detached copy with the same argv and exit. */
export function reexecCli(): void {
  const child = spawn(process.argv[0], process.argv.slice(1), {
    stdio: "inherit",
    detached: true,
  });
  child.unref();
  process.exit(0);
}

/** Default-on; IICP_AUTO_UPDATE=0/false/no/off opts out. */
export function autoUpdateEnabled(): boolean {
  const v = (process.env.IICP_AUTO_UPDATE ?? "1").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(v);
}

/** Check cadence in ms (default 1h), floored at 5 min. */
export function autoUpdateIntervalMs(defaultS = DEFAULT_AUTO_UPDATE_INTERVAL_S): number {
  const n = parseInt(process.env.IICP_AUTO_UPDATE_INTERVAL_S ?? String(defaultS), 10);
  return (Number.isFinite(n) ? Math.max(300, n) : defaultS) * 1000;
}

/** Delay before the first background check; never later than five minutes. */
export function autoUpdateInitialDelayMs(intervalMs: number): number {
  return Math.min(intervalMs, 5 * 60_000);
}

/** One evaluation of the auto-update rule. Pure orchestration — all I/O injected so
 * the decision is unit-testable. Returns the action taken. */
export async function autoUpdateTick(
  current: string,
  latest: string | null,
  enabled: boolean,
  upgradeFn: () => Promise<boolean>,
  reexecFn: () => void,
  logFn: (m: string) => void,
): Promise<"disabled" | "unknown" | "current" | "upgraded" | "upgrade-failed"> {
  sdkLatestSeen = latest;
  sdkUpdateLastCheckedAt = new Date().toISOString();
  sdkUpdateErrorClass = latest === null ? "latest_unknown" : null;
  if (!enabled) return "disabled";
  if (latest === null) return "unknown";
  if (!isOutdated(current, latest)) return "current";
  logFn(`auto-update: newer release ${latest} available (running ${current}) — upgrading…`);
  if (await upgradeFn()) {
    logFn(`auto-update: upgraded to ${latest}; restarting to apply…`);
    reexecFn();
    return "upgraded";
  }
  logFn("auto-update: upgrade failed; staying on current version, will retry next check");
  return "upgrade-failed";
}

export function recordUpdateCheck(latest: string | null, errorClass: string | null = null): void {
  sdkLatestSeen = latest;
  sdkUpdateLastCheckedAt = new Date().toISOString();
  sdkUpdateErrorClass = errorClass;
}

export function autoUpdateStatusPayload(): Record<string, string | number | boolean | null> {
  return {
    auto_update_enabled: autoUpdateEnabled(),
    auto_update_interval_s: Math.round(autoUpdateIntervalMs() / 1000),
    sdk_latest_seen: sdkLatestSeen,
    sdk_update_last_checked_at: sdkUpdateLastCheckedAt,
    sdk_update_error_class: sdkUpdateErrorClass,
  };
}

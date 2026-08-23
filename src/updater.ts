// SPDX-License-Identifier: Apache-2.0
/**
 * Self-updater for provider nodes (#521 WQ-089).
 *
 * `iicp-node update` still supports the safe read-only version check, but
 * normal long-running `iicp-node serve` processes now also run a default-on
 * background loop: check npm hourly (first check within five minutes), install
 * that exact stable release from the official registry, and restart onto
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
export function parseVersion(v: string): [number, number, number] | null {
  const parts = v.trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !/^(0|[1-9]\d*)$/.test(part))) return null;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** True when `latest` is strictly newer than `current` (numeric, not lex). */
export function isOutdated(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (a === null || b === null) return false;
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
  command: string | null;
}

export function checkUpdate(current: string, latest: string | null): UpdateVerdict {
  return {
    current,
    latest,
    outdated: latest !== null && isOutdated(current, latest),
    command: latest !== null && isOutdated(current, latest)
      ? `npm install -g @iicp/client@${latest} --registry=https://registry.npmjs.org`
      : null,
  };
}

// ── P2 — background self-updater (#521) ─────────────────────────────────────────
// A node running `serve` periodically checks npm and, on a newer release, upgrades
// (`npm install -g`) and re-execs onto it. This removes the manual-upgrade
// dependency in covered service paths. Nodes older than the hardened 0.7.67 serve
// wiring may need one manual upgrade/restart first. Default-on; opt out with
// IICP_AUTO_UPDATE=0. Loop-safe (post-upgrade running version == latest) and failure-isolated.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

interface PersistedUpdateState {
  sdk_update_last_attempted_version: string | null;
  sdk_update_last_result: "success" | "failed" | null;
  sdk_update_consecutive_failures: number;
  sdk_update_next_retry_at: string | null;
}

let persistedState: PersistedUpdateState = {
  sdk_update_last_attempted_version: null,
  sdk_update_last_result: null,
  sdk_update_consecutive_failures: 0,
  sdk_update_next_retry_at: null,
};

function updateStatePath(): string {
  return process.env.IICP_UPDATE_STATE_FILE
    ?? join(process.env.IICP_HOME ?? join(homedir(), ".iicp"), "state", "update-status.json");
}

function loadUpdateState(): void {
  try {
    const value = JSON.parse(readFileSync(updateStatePath(), "utf8")) as Partial<PersistedUpdateState>;
    persistedState = {
      sdk_update_last_attempted_version: typeof value.sdk_update_last_attempted_version === "string" ? value.sdk_update_last_attempted_version : null,
      sdk_update_last_result: value.sdk_update_last_result === "success" || value.sdk_update_last_result === "failed" ? value.sdk_update_last_result : null,
      sdk_update_consecutive_failures: Number.isInteger(value.sdk_update_consecutive_failures) && Number(value.sdk_update_consecutive_failures) >= 0 ? Number(value.sdk_update_consecutive_failures) : 0,
      sdk_update_next_retry_at: typeof value.sdk_update_next_retry_at === "string" ? value.sdk_update_next_retry_at : null,
    };
  } catch {
    // Missing or malformed local state must not prevent a fresh update check.
  }
}

function persistUpdateState(): boolean {
  const path = updateStatePath();
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(persistedState)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    return true;
  } catch {
    try { unlinkSync(temporary); } catch { /* no partial state to preserve */ }
    return false;
  }
}

function retryDelayMs(failures: number): number {
  return Math.min(86_400_000, autoUpdateIntervalMs() * (2 ** Math.min(Math.max(failures - 1, 0), 5)));
}

export function candidateRetryBlocked(version: string, now = Date.now()): boolean {
  loadUpdateState();
  if (persistedState.sdk_update_last_attempted_version !== version || persistedState.sdk_update_last_result !== "failed") return false;
  const retryAt = Date.parse(persistedState.sdk_update_next_retry_at ?? "");
  return Number.isFinite(retryAt) && retryAt > now;
}

export function recordUpdateResult(version: string, success: boolean, errorClass: string | null = null): void {
  loadUpdateState();
  const sameCandidate = persistedState.sdk_update_last_attempted_version === version;
  const failures = success ? 0 : (sameCandidate ? persistedState.sdk_update_consecutive_failures + 1 : 1);
  persistedState = {
    sdk_update_last_attempted_version: version,
    sdk_update_last_result: success ? "success" : "failed",
    sdk_update_consecutive_failures: failures,
    sdk_update_next_retry_at: success ? null : new Date(Date.now() + retryDelayMs(failures)).toISOString(),
  };
  sdkUpdateErrorClass = errorClass;
  if (!persistUpdateState()) sdkUpdateErrorClass = "update_state_write_failed";
}

export function npmInstallArgs(version: string): string[] | null {
  if (parseVersion(version) === null) return null;
  return [
    "install", "-g", `@iicp/client@${version}`,
    "--registry=https://registry.npmjs.org",
    "--ignore-scripts",
  ];
}

/** Install the exact validated stable candidate from the official npm registry. */
export async function performSelfUpdate(
  version: string,
  npmBin = "npm",
  timeoutMs = 600_000,
): Promise<boolean> {
  const args = npmInstallArgs(version);
  if (args === null) return false;
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn(npmBin, args, { stdio: "ignore" });
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
  upgradeFn: (version: string) => Promise<boolean>,
  reexecFn: () => void,
  logFn: (m: string) => void,
): Promise<"disabled" | "unknown" | "current" | "backoff" | "upgraded" | "upgrade-failed"> {
  sdkLatestSeen = latest;
  sdkUpdateLastCheckedAt = new Date().toISOString();
  sdkUpdateErrorClass = latest === null ? "latest_unknown" : null;
  if (!enabled) return "disabled";
  if (latest === null) return "unknown";
  if (!isOutdated(current, latest)) return "current";
  if (candidateRetryBlocked(latest)) return "backoff";
  logFn(`auto-update: newer release ${latest} available (running ${current}) — upgrading…`);
  if (await upgradeFn(latest)) {
    recordUpdateResult(latest, true);
    logFn(`auto-update: upgraded to ${latest}; restarting to apply…`);
    reexecFn();
    return "upgraded";
  }
  recordUpdateResult(latest, false, "package_install_failed");
  logFn("auto-update: upgrade failed; staying on current version with bounded retry backoff");
  return "upgrade-failed";
}

export function recordUpdateCheck(latest: string | null, errorClass: string | null = null): void {
  sdkLatestSeen = latest;
  sdkUpdateLastCheckedAt = new Date().toISOString();
  sdkUpdateErrorClass = errorClass;
}

export function autoUpdateStatusPayload(): Record<string, string | number | boolean | null> {
  loadUpdateState();
  return {
    auto_update_enabled: autoUpdateEnabled(),
    auto_update_interval_s: Math.round(autoUpdateIntervalMs() / 1000),
    sdk_latest_seen: sdkLatestSeen,
    sdk_update_last_checked_at: sdkUpdateLastCheckedAt,
    sdk_update_error_class: sdkUpdateErrorClass,
    ...persistedState,
  };
}

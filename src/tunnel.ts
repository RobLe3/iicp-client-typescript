// SPDX-License-Identifier: Apache-2.0
/**
 * Quick-Tunnel escalation — #520 rung 5 of the NAT ladder.
 * TypeScript port of iicp-client-python/tunnel.py (0f97ca1).
 *
 * When every NAT variant fails (no direct endpoint, no UPnP pinhole, no IPv6
 * GUA, no relay-capable peer in the directory), the node can still become
 * publicly reachable with ZERO account, domain, or router changes: spawn
 * `cloudflared tunnel --url http://127.0.0.1:<port>` and register the issued
 * `https://*.trycloudflare.com` URL as the endpoint.
 *
 * Lifecycle is fully automatic: setup (binary detection — never auto-installed),
 * initiation (spawn + URL parse ≤20 s), supervision (bounded respawn; URL
 * rotates → caller re-registers), teardown (close() idempotent + process-exit
 * hook so a normal exit never orphans the child).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** cloudflared usually prints the URL within ~5 s; 20 s covers slow first runs. */
export const TUNNEL_START_TIMEOUT_MS = 20_000;
/**
 * Bounded self-healing: this many CONSECUTIVE failed respawns (without the tunnel
 * recovering to a healthy state in between) → give up. Resets to 0 once a respawned
 * tunnel passes a health check, so a long-running relay heals indefinitely. (#538)
 */
export const MAX_RESPAWNS = 3;
/**
 * Active liveness check of the tunnel's OWN public URL — catches the failure mode the
 * process-exit watcher misses: cloudflared still running but the edge connection
 * dropped, so the URL is unreachable while the node looks healthy (the recurring
 * dead-endpoint bug, #538). Probe every interval; after this many consecutive failures,
 * force a tunnel restart (kill → exit hook respawns → new URL → re-register).
 */
export const TUNNEL_HEALTH_INTERVAL_MS = 30_000;
export const TUNNEL_HEALTH_MAX_FAILS = 2;
export const TUNNEL_VERIFY_TIMEOUT_MS = 30_000;

export type TunnelState = "ready" | "twilight" | "recovering" | "dead";

export interface TunnelWatchOptions {
  elastic?: boolean;
  onState?: (state: TunnelState) => void;
  probe?: (url: string) => Promise<boolean>;
  healthIntervalMs?: number;
  verifyTimeoutMs?: number;
}

/**
 * GET `<url>/iicp/health` through the Cloudflare edge back to the local node — the same
 * path a browser consumer takes — so it detects an edge-drop, not just a local-process
 * death. Any error / non-2xx → unreachable (a failed probe).
 */
async function tunnelUrlReachable(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/iicp/health`, { signal: ctrl.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntilReachable(
  url: string,
  probe: (url: string) => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await probe(url)) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

export const INSTALL_HINT =
  "cloudflared not found — install it to become reachable without router " +
  "changes (zero-account Quick Tunnel): " +
  "macOS `brew install cloudflared` · Linux: https://pkg.cloudflare.com · " +
  "Windows `winget install Cloudflare.cloudflared`";

/** Locate the cloudflared binary on PATH, or null (we never auto-install it). */
export function cloudflaredPath(): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `cloudflared${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/** A running Quick Tunnel: public `url` → `http://127.0.0.1:<localPort>`. */
export class QuickTunnel {
  process: ChildProcess;
  url: string;
  readonly localPort: number;
  private readonly _binary: string;
  private _closed = false;
  private _respawns = 0;
  private _healthTimer?: ReturnType<typeof setInterval>;
  private readonly _exitHook: () => void;

  constructor(proc: ChildProcess, url: string, localPort: number, binary: string) {
    this.process = proc;
    this.url = url;
    this.localPort = localPort;
    this._binary = binary;
    this._exitHook = () => this.close();
    process.on("exit", this._exitHook);
  }

  get respawns(): number {
    return this._respawns;
  }

  /**
   * Start the watchdog: on unexpected exit, respawn (bounded) and call
   * `onNewUrl(newUrl)` — Quick Tunnel URLs rotate per process, so the caller
   * MUST re-register. After MAX_RESPAWNS, `onDead()` fires once.
   */
  watch(onNewUrl: (url: string) => void, onDead: () => void, options: TunnelWatchOptions = {}): void {
    // #538 — edge-drop detection: cloudflared can stay alive while its tunnel becomes
    // unreachable. Probe the public URL; on sustained failure, kill the child so the
    // exit hook respawns it. A healthy probe resets the respawn count so a long-running
    // relay heals indefinitely.
    let healthFails = 0;
    let state: TunnelState = "ready";
    const probe = options.probe ?? tunnelUrlReachable;
    const healthIntervalMs = options.healthIntervalMs ?? TUNNEL_HEALTH_INTERVAL_MS;
    const verifyTimeoutMs = options.verifyTimeoutMs ?? TUNNEL_VERIFY_TIMEOUT_MS;
    const setState = (next: TunnelState) => {
      if (state === next) return;
      state = next;
      options.onState?.(next);
    };
    options.onState?.(state);
    const healthTimer = setInterval(() => {
      if (this._closed) return;
      if (this.process.exitCode !== null || this.process.killed) return; // exit hook owns this
      void (async () => {
        if (await probe(this.url)) {
          healthFails = 0;
          this._respawns = 0;
          setState("ready");
        } else {
          healthFails += 1;
          setState("twilight");
          if (healthFails >= TUNNEL_HEALTH_MAX_FAILS) {
            console.warn(
              `[quick-tunnel] ${this.url} unreachable ${healthFails}× while cloudflared is up ` +
                "(twilight) — rebuilding tunnel.",
            );
            setState("recovering");
            healthFails = 0;
            if (this.process.exitCode === null && !this.process.killed) {
              this.process.kill("SIGTERM"); // → once("exit") → respawn below
            }
          }
        }
      })();
    }, healthIntervalMs);
    // Don't let the watchdog timer keep a one-shot/test process alive.
    healthTimer.unref?.();
    this._healthTimer = healthTimer;

    const arm = (proc: ChildProcess) => {
      proc.once("exit", () => {
        if (this._closed) return;
        void (async () => {
          setState("recovering");
          this._respawns += 1;
          if (this._respawns > MAX_RESPAWNS) {
            console.error(
              `[quick-tunnel] ${this._respawns - 1} consecutive respawns failed to recover ` +
                "a healthy tunnel — giving up. Node is no longer publicly reachable; restart " +
                "`iicp-node serve` to recover.",
            );
            setState("dead");
            onDead();
            return;
          }
          console.warn(
            `[quick-tunnel] tunnel down — respawning (${this._respawns}/${MAX_RESPAWNS})…`,
          );
          let fresh: QuickTunnel;
          try {
            fresh = await openQuickTunnel(this.localPort, TUNNEL_START_TIMEOUT_MS, this._binary);
          } catch (exc) {
            console.error(
              `[quick-tunnel] respawn failed: ${exc instanceof Error ? exc.message : exc}`,
            );
            setState("dead");
            onDead();
            return;
          }
          // Adopt the fresh child; drop its own exit-hook (ours stays armed).
          process.removeListener("exit", fresh._exitHook);
          this.process = fresh.process;
          this.url = fresh.url;
          arm(this.process);
          if (options.elastic) {
            console.log(`[quick-tunnel] candidate tunnel up at ${this.url}; verifying public health…`);
            if (await waitUntilReachable(this.url, probe, verifyTimeoutMs)) {
              this._respawns = 0;
              setState("ready");
              console.log(`[quick-tunnel] verified at ${this.url} — re-registering.`);
              onNewUrl(this.url);
            } else {
              console.warn(`[quick-tunnel] candidate ${this.url} stayed unreachable — rebuilding.`);
              if (this.process.exitCode === null && !this.process.killed) this.process.kill("SIGTERM");
            }
          } else {
            console.log(`[quick-tunnel] back up at ${this.url} — re-registering.`);
            onNewUrl(this.url);
          }
        })();
      });
    };
    arm(this.process);
  }

  /** Terminate the tunnel child. Idempotent; also runs on process exit. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    if (this._healthTimer) clearInterval(this._healthTimer);
    process.removeListener("exit", this._exitHook);
    if (this.process.exitCode === null && !this.process.killed) {
      this.process.kill("SIGTERM");
    }
  }
}

/**
 * Spawn cloudflared and resolve with the running tunnel + its public URL.
 * Rejects with INSTALL_HINT when the binary is absent, or a timeout error
 * when no URL appears within `timeoutMs`.
 */
export function openQuickTunnel(
  localPort: number,
  timeoutMs: number = TUNNEL_START_TIMEOUT_MS,
  binary?: string,
): Promise<QuickTunnel> {
  return new Promise((resolve, reject) => {
    const resolved = binary ?? cloudflaredPath();
    if (!resolved) {
      reject(new Error(INSTALL_HINT));
      return;
    }
    const proc = spawn(resolved, ["tunnel", "--url", `http://127.0.0.1:${localPort}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(`cloudflared produced no tunnel URL within ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const onChunk = (chunk: Buffer) => {
      if (settled) return; // keep draining (streams stay flowing) but ignore
      const m = URL_RE.exec(chunk.toString());
      if (m) {
        settled = true;
        clearTimeout(timer);
        console.log(`[quick-tunnel] up: ${m[0]} → http://127.0.0.1:${localPort}`);
        resolve(new QuickTunnel(proc, m[0], localPort, resolved));
      }
    };
    // cloudflared logs to stderr; read both to be version-proof. Attaching
    // handlers keeps the pipes flowing so the child never blocks on a full pipe.
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited (code=${code}) before printing a tunnel URL`));
    });
    proc.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

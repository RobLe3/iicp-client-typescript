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
export const TUNNEL_DOH_TIMEOUT_MS = 5_000;
export const TUNNEL_DEAD_RETRY_INITIAL_MS = 30_000;
export const TUNNEL_DEAD_RETRY_MAX_MS = 300_000;

export type TunnelState = "ready" | "twilight" | "recovering" | "dead";
export type TunnelDeadAction = "stop" | "retry";

export interface TunnelWatchOptions {
  elastic?: boolean;
  onState?: (state: TunnelState) => void;
  onDeadAction?: () => TunnelDeadAction | void;
  probe?: (url: string) => Promise<boolean>;
  healthIntervalMs?: number;
  verifyTimeoutMs?: number;
  deadRetryDelayMs?: (attempt: number) => number;
}

function trycloudflareHost(url: string): string | null {
  if (!url.trim().startsWith("https://")) return null;
  const host = url.trim().slice("https://".length).split("/")[0];
  if (!host.endsWith(".trycloudflare.com")) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

function isLikelyDnsError(exc: unknown): boolean {
  const anyExc = exc as { message?: string; cause?: { code?: string; message?: string } };
  const code = anyExc?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return true;
  const msg = `${anyExc?.message ?? String(exc)} ${anyExc?.cause?.message ?? ""}`.toLowerCase();
  return (
    msg.includes("dns") ||
    msg.includes("failed to lookup address") ||
    msg.includes("nodename nor servname") ||
    msg.includes("name or service not known") ||
    msg.includes("temporary failure in name resolution") ||
    msg.includes("enotfound") ||
    msg.includes("eai_again")
  );
}

async function dohHasAnswer(host: string, recordType: "A" | "AAAA"): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TUNNEL_DOH_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${host}&type=${recordType}`,
      { headers: { accept: "application/dns-json" }, signal: ctrl.signal },
    );
    if (!resp.ok) return false;
    const body = (await resp.json()) as { Status?: number; Answer?: unknown[] };
    return body.Status === 0 && Array.isArray(body.Answer) && body.Answer.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function trycloudflarePublishedViaDoh(url: string): Promise<boolean> {
  const host = trycloudflareHost(url);
  if (!host) return false;
  return (await dohHasAnswer(host, "A")) || (await dohHasAnswer(host, "AAAA"));
}

/**
 * GET `<url>/iicp/health` through the Cloudflare edge back to the local node — the same
 * path a browser consumer takes — so it detects an edge-drop, not just a local-process
 * death. Local resolvers can lag freshly-created accountless `trycloudflare.com`
 * records; if local DNS fails but Cloudflare DoH already publishes the hostname, keep
 * the tunnel alive so we do not create→verify→kill-loop fresh public URLs.
 */
async function tunnelUrlReachable(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const resp = await fetch(`${url.replace(/\/$/, "")}/iicp/health`, { signal: ctrl.signal });
    return resp.ok;
  } catch (exc) {
    if (isLikelyDnsError(exc) && (await trycloudflarePublishedViaDoh(url))) {
      console.warn(
        `[quick-tunnel] local DNS has not resolved ${url} yet, but Cloudflare DoH ` +
          "already publishes it — keeping tunnel alive.",
      );
      return true;
    }
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

function deadRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 4));
  return Math.min(TUNNEL_DEAD_RETRY_INITIAL_MS * 2 ** exponent, TUNNEL_DEAD_RETRY_MAX_MS);
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
    let deadRetries = 0;
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
          deadRetries = 0;
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

    const handleDead = async (): Promise<boolean> => {
      setState("dead");
      onDead();
      if (options.onDeadAction?.() !== "retry") return false;
      deadRetries += 1;
      const delay = options.deadRetryDelayMs?.(deadRetries) ?? deadRetryDelayMs(deadRetries);
      console.warn(`[quick-tunnel] dead-state retry policy active — retrying in ${Math.round(delay / 1000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this._closed) return false;
      this._respawns = 0;
      healthFails = 0;
      setState("recovering");
      return true;
    };

    const arm = (proc: ChildProcess) => {
      proc.once("exit", () => {
        if (this._closed) return;
        const recover = async (): Promise<void> => {
          setState("recovering");
          while (!this._closed) {
            this._respawns += 1;
            if (this._respawns > MAX_RESPAWNS) {
              console.error(
                `[quick-tunnel] ${this._respawns - 1} consecutive respawns failed to recover ` +
                  "a healthy tunnel — giving up. Node is no longer publicly reachable; restart " +
                  "`iicp-node serve` to recover.",
              );
              if (await handleDead()) continue;
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
              if (await handleDead()) continue;
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
                deadRetries = 0;
                setState("ready");
                console.log(`[quick-tunnel] verified at ${this.url} — re-registering.`);
                onNewUrl(this.url);
              } else {
                console.warn(`[quick-tunnel] candidate ${this.url} stayed unreachable — rebuilding.`);
                if (this.process.exitCode === null && !this.process.killed) this.process.kill("SIGTERM");
              }
              return;
            } else {
              deadRetries = 0;
              console.log(`[quick-tunnel] back up at ${this.url} — re-registering.`);
              onNewUrl(this.url);
              return;
            }
          }
        };
        void recover();
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
    const lastLines: string[] = [];
    const errorWithOutput = (reason: string) =>
      lastLines.length ? `${reason}; last cloudflared output: ${lastLines.join(" | ")}` : reason;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(errorWithOutput(`cloudflared produced no tunnel URL within ${timeoutMs / 1000}s`)));
    }, timeoutMs);

    const onChunk = (chunk: Buffer) => {
      if (settled) return; // keep draining (streams stay flowing) but ignore
      const text = chunk.toString();
      lastLines.push(...text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
      while (lastLines.length > 6) lastLines.shift();
      const m = URL_RE.exec(text);
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
      reject(new Error(errorWithOutput(`cloudflared exited (code=${code}) before printing a tunnel URL`)));
    });
    proc.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

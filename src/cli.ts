#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * iicp-node — turn @iicp/client into a runnable provider node.
 *
 * Usage:
 *   iicp-node serve --model qwen2.5:0.5b --backend-url http://localhost:11434
 *   iicp-node init                 # interactive wizard
 *   iicp-node list                 # list saved node configs
 *
 * All flags also read from env (IICP_BACKEND_URL, IICP_BACKEND_MODEL,
 * IICP_PUBLIC_ENDPOINT, IICP_DIRECTORY_URL, IICP_REGION,
 * IICP_MAX_CONCURRENT, IICP_NODE_ID, IICP_INTENT, IICP_PORT, IICP_HOST,
 * IICP_NODE_NAME, IICP_AUTO_DETECT_NAT, IICP_EXTERNAL_IP_PROBE_URL).
 *
 * Mirrors iicp_client.cli (Python) so operators choosing TypeScript get the
 * same one-liner setup path.
 */
import { parseArgs } from "node:util";
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as edVerify,
} from "node:crypto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SDK_VERSION: string = (require("../package.json") as { version: string }).version;
import * as net from "node:net";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { IicpNode, deriveNativeEndpoint } from "./node.js";
import { IicpClient } from "./client.js";
import { writeNodeEvent } from "./node_log.js";
import { configureCipPolicy } from "./cip_policy.js";
import { runProxy, createProxyServer, type TaskClient } from "./proxy/index.js";
import { InstanceLock, NodeAlreadyServingError } from "./instance_lock.js";
import { getBackendHandler, BACKEND_TYPES } from "./backends/index.js";
import {
  classifyRecovery,
  envGraceChecks,
  nodeRegistryPrefix,
  registryNodePresence,
} from "./recovery.js";
import {
  configDir,
  generateNode,
  generateOperator,
  listNodes,
  loadNode,
  loadOperator,
  noIdentityNotice,
  operatorDecryptAtRest,
  operatorEncryptAtRest,
  operatorIsEncrypted,
  operatorIsKeyBacked,
  operatorSigningKey,
  saveNode,
  saveOperator,
  type NodeIdentity,
} from "./identity.js";
import { issueDelegation, signOperatorSelfService, signRename } from "./delegation.js";
import { McpToolPolicy, toolRiskLabel } from "./mcp_policy.js";
import {
  LEGACY_MCP_REVISION,
  MODERN_MCP_REVISION,
  SUPPORTED_MCP_REVISIONS,
  buildModernMcpRequest,
  validateModernMcpResponse,
} from "./mcp_negotiation.js";

type UpdaterModule = typeof import("./updater.js");

export interface ProviderAutoUpdateOptions {
  current?: string;
  loadUpdater?: () => Promise<UpdaterModule>;
  logFn?: (message: string) => void;
}

/**
 * Start the default-on provider updater for long-running TS node processes.
 *
 * This is intentionally shared by normal `serve` and `mcp-gateway`: the updater
 * must be a provider invariant, not a gateway-only feature. Timers are unref'd
 * so they never keep a terminating process alive, and the returned stop handle
 * lets tests/shutdown clear pending timers.
 */
export function startProviderAutoUpdate(options: ProviderAutoUpdateOptions = {}): () => void {
  let stopped = false;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  const current = options.current ?? SDK_VERSION;
  const loadUpdater = options.loadUpdater ?? (() => import("./updater.js"));
  const logFn = options.logFn ?? ((m: string) => console.log(`  [iicp-node] ${m}`));

  void (async () => {
    const u = await loadUpdater();
    if (stopped || !u.autoUpdateEnabled()) return;
    const tick = () => {
      void (async () => {
        try {
          await u.autoUpdateTick(
            current,
            await u.latestNpmVersion(),
            true,
            () => u.performSelfUpdate(),
            () => u.reexecCli(),
            logFn,
          );
        } catch (err) {
          u.recordUpdateCheck(null, err instanceof Error ? err.name : "Error");
        }
      })();
    };
    const intervalMs = u.autoUpdateIntervalMs();
    const firstDelayMs = u.autoUpdateInitialDelayMs(intervalMs);
    firstTimer = setTimeout(() => {
      if (stopped) return;
      tick();
      intervalTimer = setInterval(tick, intervalMs);
      intervalTimer.unref();
    }, firstDelayMs);
    firstTimer.unref();
  })().catch((err) => {
    if (!stopped) {
      logFn(`auto-update: failed to start (${err instanceof Error ? err.name : "Error"})`);
    }
  });

  return () => {
    stopped = true;
    if (firstTimer) clearTimeout(firstTimer);
    if (intervalTimer) clearInterval(intervalTimer);
  };
}

export interface ServeOpts {
  backendUrl: string;
  policyManifest?: string;
  /** Explicit operator receipt-profile opt-in; undefined allows saved-node fallback. */
  receiptProfiles?: string[];
  backendType: string;
  experimental?: boolean;
  /** #5 — Bearer key for an auth-requiring OpenAI-compat backend (LM Studio, hosted). Empty = none. */
  backendApiKey: string;
  model: string;
  publicEndpoint: string;
  directoryUrl: string;
  region?: string;
  intent: string;
  maxConcurrent: number;
  nodeId: string;
  port: number;
  host: string;
  skipRegistration: boolean;
  force: boolean;
  autoDetectNat: boolean;
  externalIpProbeUrl: string;
  relayWorkerEndpoint: string;
  relayCapable?: boolean;
  /** #520 rung 5 tri-state: true=forced, false=disabled, undefined=auto. */
  tunnel?: boolean;
  relayAcceptPort?: number;
  node: string;
  logDir?: string;
  withProxy?: boolean;
  /** TC-9c — pre-loaded from saved node config; passed to IicpNode so receipts work on restart. */
  nodeHmacKey?: string;
}

export function resolveReceiptProfiles(
  cliValues: string[] | undefined,
  envValue: string | undefined,
  savedValues?: string[],
): string[] {
  const raw = cliValues ?? (envValue !== undefined ? envValue.split(",") : (savedValues ?? []));
  const profiles = [...new Set(raw.map((value) => value.trim()).filter(Boolean))];
  const unsupported = profiles.filter((value) => value !== "consumer_cosignature_v1");
  if (unsupported.length > 0) {
    throw new CliError(
      `unsupported receipt profile(s): ${unsupported.join(", ")}. Supported: consumer_cosignature_v1.`,
    );
  }
  return profiles;
}

function envOr(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v ?? fallback;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v.toLowerCase() === "true" || v === "1" || v.toLowerCase() === "yes";
}

export const TUNNEL_DEAD_EXIT_CODE = 75;
export type TunnelDeadPolicy = "auto" | "retry" | "exit" | "log-only";
export type TunnelDeadBehavior = "exit" | "retry" | "log-only";

export function tunnelDeadPolicyFromEnv(): TunnelDeadPolicy {
  const value = (process.env.IICP_TUNNEL_DEAD_POLICY ?? "auto").trim().toLowerCase();
  if (value === "auto" || value === "retry" || value === "exit" || value === "log-only") return value;
  if (value === "log_only" || value === "logonly") return "log-only";
  console.warn(`[iicp-node] ignoring invalid IICP_TUNNEL_DEAD_POLICY=${JSON.stringify(value)}; using auto.`);
  return "auto";
}

export function tunnelDeadBehavior(policy: TunnelDeadPolicy, supervised: boolean): TunnelDeadBehavior {
  if (policy === "auto") return supervised ? "exit" : "retry";
  return policy;
}

export function relayWorkerFallbackAllowed(relayCapable: boolean | undefined): boolean {
  // A relay-capable node is relay infrastructure. If its own public route is
  // unavailable, supervised services should restart and retry the public route
  // instead of turning into a relay worker and removing relay capacity.
  return relayCapable !== true;
}

async function exitIfSupervisedPublicFallbackUnrecovered(): Promise<void> {
  if (tunnelDeadBehavior(tunnelDeadPolicyFromEnv(), envBool("IICP_SUPERVISED")) !== "exit") return;
  // eslint-disable-next-line no-console
  console.error(
    `[iicp-node] public fallback is still unavailable after tunnel/relay attempts. ` +
      `Exiting with code ${TUNNEL_DEAD_EXIT_CODE} so the supervisor can retry instead of ` +
      `advertising an unverified direct route.`,
  );
  process.exit(TUNNEL_DEAD_EXIT_CODE);
}

function printHelp(): void {
  process.stdout.write(
    `usage: iicp-node <command> [options]\n\n` +
      `Commands:\n` +
      `  init                       Interactive wizard — set up operator + first node config\n` +
      `  list                       List node configs saved under ~/.iicp/nodes/\n` +
      `  serve                      Register and serve a node\n` +
      `  doctor                     Check local health, directory presence, and recovery action\n` +
      `  query <prompt>             Discover mesh nodes and submit a chat task\n` +
      `  credits                    Show your operator wallet plus this node's credit ledger\n` +
      `  proxy                      Run the local OpenAI/Ollama/Anthropic-compat gateway (loopback; no registration)\n` +
      `  mcp-gateway                Bridge a local MCP server as an IICP provider node (registers + serves)\n` +
      `  service                    Generate/install OS supervisor units for unattended node serving\n` +
      `  update                     Check whether a newer @iicp/client release is available\n` +
      `  operator rename <name>     Change your public display_name (signed by your operator key)\n` +
      `  operator dsr <action>      Export, restrict, or anonymize your directory records\n` +
      `  operator encrypt           Password-encrypt the operator secret at rest ($IICP_OPERATOR_PASSPHRASE)\n` +
      `  operator decrypt           Remove at-rest encryption of the operator secret\n\n` +
      `Run an IICP provider node backed by an OpenAI-compatible server.\n\n` +
      `serve required (flag or env):\n` +
      `  --model NAME               IICP_BACKEND_MODEL — model name (e.g. qwen2.5:0.5b)\n` +
      `  (or --node NAME            load both from ~/.iicp/nodes/<NAME>.json after \`iicp-node init\`)\n\n` +
      `serve optional:\n` +
      `  --backend-url URL          IICP_BACKEND_URL — local backend (MeshLLM → http://localhost:9337/v1)\n` +
      `  --backend-type TYPE        IICP_BACKEND_TYPE — openai_compat | vllm | llamacpp | meshllm | anthropic (default openai_compat)\n` +
      `  --backend-api-key KEY      IICP_BACKEND_API_KEY — Bearer key for an auth'd backend (LM Studio, hosted); anthropic uses it as x-api-key\n` +
      `  --experimental             IICP_EXPERIMENTAL — enable an explicitly selected preview backend feature\n` +
      `  --policy-manifest FILE     IICP_POLICY_MANIFEST_FILE — sign and advertise a public node-policy JSON document\n` +
      `  --receipt-profile PROFILE  IICP_SUPPORTED_RECEIPT_PROFILES — repeatable; supported: consumer_cosignature_v1\n` +
      `  --public-endpoint URL      IICP_PUBLIC_ENDPOINT — externally reachable URL of this node\n` +
      `  --directory-url URL        IICP_DIRECTORY_URL (default https://iicp.network/api)\n` +
      `  --region REGION            IICP_REGION (e.g. us-east; unknown if unset)\n` +
      `  --intent URN               IICP_INTENT (default urn:iicp:intent:llm:chat:v1)\n` +
      `  --max-concurrent N         IICP_MAX_CONCURRENT (default 4)\n` +
      `  --node-id ID               IICP_NODE_ID (auto-generated if absent)\n` +
      `  --port N                   IICP_PORT (default 9484)\n` +
      `  --host HOST                IICP_HOST (default :: — dual-stack IPv4+IPv6)\n` +
      `  --skip-registration        IICP_SKIP_REGISTRATION — register-free dev mode\n` +
      `  --force                    IICP_FORCE — take over the single-instance lock for this node_id\n` +
      `  --auto-detect-nat          IICP_AUTO_DETECT_NAT — run NAT detection at startup (default on)\n` +
      `  --no-auto-detect-nat       disable NAT detection at startup\n` +
      `  --external-ip-probe-url U  IICP_EXTERNAL_IP_PROBE_URL — fallback IPv4 probe\n` +
      `  --tunnel / --no-tunnel     IICP_TUNNEL — #520 rung 5: zero-account Cloudflare Quick Tunnel for the\n` +
      `                             node's own public endpoint (needs cloudflared on PATH). Default auto: use\n` +
      `                             tunnel when direct IPv4/IPv6/pinhole reachability is unavailable or\n` +
      `                             unverified, then relay. --tunnel forces it; --no-tunnel disables fallback.\n` +
      `                             Dead policy: IICP_TUNNEL_DEAD_POLICY=auto|retry|exit|log-only;\n` +
      `                             generated services set IICP_SUPERVISED=1.\n` +
      `  --relay-worker-endpoint H  IICP_RELAY_WORKER_ENDPOINT — <host>:<port> of a relay node (R2 last-resort)\n` +
      `  --relay-capable            IICP_RELAY_CAPABLE — advertise as relay server for CGNAT/tier-4 operators\n` +
      `  --relay-accept-port N      IICP_RELAY_ACCEPT_PORT — TCP port for relay accept server (default 9485).\n` +
      `                             Public relays should set IICP_RELAY_REQUIRE_BIND_TICKET=1 and\n` +
      `                             IICP_RELAY_BIND_TICKET_PUBLIC_KEY for directory-signed one-use binds.\n` +
      `  --log-dir DIR              IICP_LOG_DIR — directory for persistent log files (<node_id>.log + events.jsonl)\n` +
      `  --with-proxy               IICP_WITH_PROXY — also run the loopback compat proxy (127.0.0.1:9483) in-process\n\n` +
      `query optional:\n` +
      `  --directory-url URL        IICP_DIRECTORY_URL (default https://iicp.network/api)\n` +
      `  --intent URN               IICP_INTENT (default urn:iicp:intent:llm:chat:v1)\n` +
      `  --model NAME               Pin to a specific model on the remote node\n` +
      `  --max-tokens N             Limit response length\n` +
      `  --timeout-ms N             Request timeout (default 60000)\n` +
      `  --routing-profile NAME     standard | sensitive | eu-restricted | strict-policy | debug-override\n` +
      `  --allow-remote-executor    Explicitly allow remote executor prompt visibility for restrictive profiles\n` +
      `  --region-allowlist LIST    Comma-separated allowed regions before prompt dispatch\n`,
  );
}

function argsHaveHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function printListHelp(): void {
  process.stdout.write(
    `usage: iicp-node list\n\n` +
      `List saved node configs under ~/.iicp/nodes/ without contacting the directory.\n\n` +
      `Options:\n` +
      `  -h, --help                 Show this help and exit without listing nodes\n`,
  );
}

function printUpdateHelp(): void {
  process.stdout.write(
    `usage: iicp-node update\n\n` +
      `Check whether a newer @iicp/client release is available. Read-only: this command never installs or restarts anything.\n\n` +
      `Exit codes:\n` +
      `  0   current, unreachable registry, or help\n` +
      `  10  newer release available\n\n` +
      `Options:\n` +
      `  -h, --help                 Show this help and exit without contacting npm\n`,
  );
}

function printServeHelp(): void {
  process.stdout.write(
    `usage: iicp-node serve [options]\n\n` +
      `Register and serve an IICP provider node backed by an OpenAI-compatible backend.\n` +
      `Use \`iicp-node init\` first for the lowest-friction saved-node path, then run:\n` +
      `  iicp-node serve --node <NAME>\n\n` +
      `Required (flag/env/saved node):\n` +
      `  --model NAME               IICP_BACKEND_MODEL — model name (e.g. qwen2.5:0.5b)\n` +
      `  --node NAME                load ~/.iicp/nodes/<NAME>.json from \`iicp-node init\`\n\n` +
      `Core options:\n` +
      `  --backend-url URL          IICP_BACKEND_URL — Ollama / vLLM / LM Studio (default http://localhost:11434; anthropic → https://api.anthropic.com)\n` +
      `  --backend-type TYPE        IICP_BACKEND_TYPE — openai_compat | vllm | llamacpp | meshllm | anthropic\n` +
      `  --backend-api-key KEY      IICP_BACKEND_API_KEY — Bearer key for auth'd backends\n` +
      `  --experimental             IICP_EXPERIMENTAL — enable an explicitly selected preview backend feature\n` +
      `  --policy-manifest FILE     IICP_POLICY_MANIFEST_FILE — sign and advertise a public node-policy JSON document\n` +
      `  --receipt-profile PROFILE  IICP_SUPPORTED_RECEIPT_PROFILES — repeatable; supported: consumer_cosignature_v1\n` +
      `  --public-endpoint URL      IICP_PUBLIC_ENDPOINT — externally reachable URL of this node\n` +
      `  --directory-url URL        IICP_DIRECTORY_URL (default https://iicp.network/api)\n` +
      `  --region REGION            IICP_REGION (e.g. eu-central)\n` +
      `  --intent URN               IICP_INTENT (default urn:iicp:intent:llm:chat:v1)\n` +
      `  --max-concurrent N         IICP_MAX_CONCURRENT (default 4)\n` +
      `  --node-id ID               IICP_NODE_ID (auto-generated if absent)\n` +
      `  --port N                   IICP_PORT (default 9484)\n` +
      `  --host HOST                IICP_HOST (default :: — dual-stack IPv4+IPv6)\n` +
      `  --skip-registration        IICP_SKIP_REGISTRATION — register-free dev mode\n` +
      `  --force                    IICP_FORCE — take over the single-instance lock for this node_id\n\n` +
      `Reachability and resilience:\n` +
      `  --auto-detect-nat          IICP_AUTO_DETECT_NAT — run NAT detection at startup (default on)\n` +
      `  --no-auto-detect-nat       disable NAT detection at startup\n` +
      `  --external-ip-probe-url U  IICP_EXTERNAL_IP_PROBE_URL — fallback IPv4 probe\n` +
      `  --tunnel / --no-tunnel     IICP_TUNNEL — auto Cloudflare Quick Tunnel fallback when direct reachability fails\n` +
      `  --relay-worker-endpoint H  IICP_RELAY_WORKER_ENDPOINT — <host>:<port> of a relay node\n` +
      `  --relay-capable            IICP_RELAY_CAPABLE — advertise as relay server\n` +
      `  --relay-accept-port N      IICP_RELAY_ACCEPT_PORT — relay accept TCP port (default 9485)\n` +
      `  --log-dir DIR              IICP_LOG_DIR — directory for persistent log files\n` +
      `  --with-proxy               IICP_WITH_PROXY — also run the loopback compat proxy (127.0.0.1:9483)\n` +
      `  -h, --help                 Show this focused serve help\n`,
  );
}

/**
 * Thrown by safeParseArgs / port parsing to signal a clean, user-facing CLI error.
 * main() catches it and prints a one-line `ERROR:` (exit 2) — never a raw stack trace.
 */
class CliError extends Error {}

/**
 * Wrap node:util parseArgs so unknown options / bad values surface as a friendly
 * `ERROR: unknown option '--x'` (exit 2) instead of a raw ERR_PARSE_ARGS_* stack trace.
 */
function safeParseArgs<T extends Parameters<typeof parseArgs>[0] & object>(
  config: T,
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (exc) {
    const e = exc as { code?: string; message?: string };
    if (e?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const m = /Unknown option '([^']*)'/.exec(e.message ?? "");
      throw new CliError(`unknown option '${m?.[1] ?? "?"}'`);
    }
    if (e?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" || e?.code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") {
      throw new CliError(e.message ?? "invalid argument");
    }
    throw new CliError(e?.message ?? String(exc));
  }
}

/** Parse a port flag/env into a number, raising a friendly CliError on a non-numeric value. */
function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new CliError("--port must be a number between 0 and 65535");
  }
  return n;
}

// ── #346 — dependency checker + auto-install ────────────────────────────────

interface DepIssue {
  name: string;
  // "ok"       — present
  // "optional" — opt-in capability not installed; node runs fine without it
  // "warn"     — degraded runtime state (backend unreachable, no IPv6)
  // "missing"  — required dependency absent
  severity: "ok" | "optional" | "warn" | "missing";
  message: string;
  installable: boolean;
  npmExtra: string;
}

async function checkDependencies(backendUrl: string): Promise<DepIssue[]> {
  const out: DepIssue[] = [];

  // 1) Backend reachability
  try {
    const u = backendUrl.replace(/\/$/, "") + "/api/tags";
    const r = await fetch(u, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      out.push({ name: "backend", severity: "ok", message: `reachable at ${backendUrl}`, installable: false, npmExtra: "" });
    } else {
      out.push({ name: "backend", severity: "warn", message: `backend HTTP ${r.status}`, installable: false, npmExtra: "" });
    }
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    out.push({ name: "backend", severity: "warn", message: `${backendUrl} unreachable: ${msg}`, installable: false, npmExtra: "" });
  }

  // 2) Optional Node deps mapped to npm peerDependencies
  const optional: Array<[string, string, string]> = [
    ["cbor-x", "cbor-x", "native IICP TCP transport (port 9484)"],
    ["nat-upnp", "nat-upnp", "UPnP NAT detection + IPv6 firewall pinhole"],
    ["prom-client", "prom-client", "/metrics endpoint"],
  ];
  for (const [mod, npmName, purpose] of optional) {
    try {
      // dynamic import — failure throws ERR_MODULE_NOT_FOUND
      await import(mod);
      out.push({ name: mod, severity: "ok", message: purpose, installable: false, npmExtra: "" });
    } catch {
      out.push({ name: mod, severity: "optional", message: `${purpose} (optional — not installed)`, installable: true, npmExtra: npmName });
    }
  }

  // 3) IPv6 routing surface (advisory)
  try {
    const { detectIpv6 } = await import("./nat_detection.js");
    const v6 = await detectIpv6(0, { timeoutMs: 1500 });
    if (v6.globalV6Available) {
      let msg = `${v6.addresses.length} global IPv6 address(es)`;
      if (v6.externalV6Reachable) msg += "; outbound v6 reachable";
      out.push({ name: "ipv6", severity: "ok", message: msg, installable: false, npmExtra: "" });
    } else {
      out.push({ name: "ipv6", severity: "warn", message: "no global IPv6 — direct hosting will require IPv4 + tunnel", installable: false, npmExtra: "" });
    }
  } catch {
    // detect_ipv6 not yet available — skip silently
  }

  return out;
}

/**
 * Detect the backend server flavor for the `backend` node-detail field:
 * ollama / lmstudio / vllm / llamacpp / anthropic / custom. Mirrors
 * iicp-client-rust + -python. Non-OpenAI dialects use backendType; for
 * openai_compat it fingerprints /v1/models response headers — X-Powered-By:Express
 * → lmstudio (LM Studio also serves Ollama-compatible /api/version + /api/tags, so
 * the Express header is the discriminator), uvicorn/vllm → vllm, llama → llamacpp,
 * else probe /api/version → ollama, else custom.
 */
async function detectBackendFlavor(backendUrl: string, apiKey: string, backendType: string): Promise<string> {
  if (backendType === "anthropic" || backendType === "vllm" || backendType === "llamacpp" || backendType === "meshllm") return backendType;
  const base = backendUrl.replace(/\/$/, "");
  const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const ok = async (path: string): Promise<Response | null> => {
    try {
      const r = await fetch(`${root}${path}`, { headers, signal: AbortSignal.timeout(2500) });
      return r.ok ? r : null;
    } catch {
      return null;
    }
  };
  const models = await ok("/v1/models");
  if (models) {
    const powered = (models.headers.get("x-powered-by") || "").toLowerCase();
    const server = (models.headers.get("server") || "").toLowerCase();
    if (powered.includes("express")) return "lmstudio";
    if (server.includes("vllm") || server.includes("uvicorn")) return "vllm";
    if (server.includes("llama.cpp") || server.includes("llama-server")) return "llamacpp";
    if (await ok("/api/version")) return "ollama";
    return "custom";
  }
  if (await ok("/api/version")) return "ollama";
  return "custom";
}

function printDepStatus(issues: DepIssue[]): void {
  const glyph: Record<string, string> = { ok: "  ✓", optional: "  ○", warn: "  !", missing: "  ✗" };
  for (const i of issues) {
    process.stdout.write(`${glyph[i.severity] ?? "  ?"} ${i.name.padEnd(18)}  ${i.message}\n`);
  }
}

function installMissing(issues: DepIssue[]): void {
  const extras = Array.from(
    new Set(
      issues
        .filter((i) => (i.severity === "optional" || i.severity === "missing") && i.installable && i.npmExtra)
        .map((i) => i.npmExtra),
    ),
  ).sort();
  if (extras.length === 0) return;
  process.stdout.write(`\n  → npm install --no-save ${extras.join(" ")}\n`);
  try {
    execSync(`npm install --no-save ${extras.join(" ")}`, { stdio: "inherit" });
    process.stdout.write("  ✓ done\n");
  } catch (exc) {
    process.stderr.write(`  ✗ npm install failed: ${exc instanceof Error ? exc.message : exc}\n`);
  }
}

// ── init / list subcommands ─────────────────────────────────────────────────

async function ask(rl: readline.Interface, prompt: string, fallback = ""): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const a = (await rl.question(`${prompt}${suffix}: `)).trim();
  return a || fallback;
}

async function runInit(): Promise<number> {
  const rl = readline.createInterface({ input, output });
  try {
    process.stdout.write(`iicp-node init — IICP TypeScript SDK\n`);
    process.stdout.write(`Config dir: ${configDir()}\n\n`);

    // Operator
    let op = loadOperator();
    if (op) {
      process.stdout.write(`Found existing operator: ${op.operator_id} (created ${op.created_at})\n`);
    } else {
      process.stdout.write(`No operator identity yet — creating one.\n`);
      const display = await ask(rl, "Display name (optional)");
      const contact = await ask(rl, "Contact email or @handle (optional)");
      op = generateOperator({ display_name: display, contact });
      const p = saveOperator(op);
      process.stdout.write(`  ✓ saved ${p}\n`);
    }
    process.stdout.write("\n");

    // Node
    const name = await ask(rl, "Node name (used as filename stem, lowercase)", "default");
    const existing = loadNode(name);
    if (existing) {
      process.stdout.write(`  ! ~/.iicp/nodes/${name}.json already exists. `);
      const yn = (await ask(rl, "Overwrite? [y/N]", "n")).toLowerCase();
      if (yn !== "y" && yn !== "yes") return 1;
    }

    const backend = await ask(rl, "Backend URL (Ollama / vLLM / LM Studio)", "http://localhost:11434");
    const model = await ask(rl, "Backend model", "qwen2.5:0.5b");
    const directory = await ask(rl, "IICP directory URL", "https://iicp.network/api");
    const region = await ask(rl, "Region tag (e.g. us-east; blank = unknown)", "unknown");
    const intent = await ask(rl, "Intent URN", "urn:iicp:intent:llm:chat:v1");
    const portStr = await ask(rl, "Listen port", "9484");
    const port = parseInt(portStr, 10) || 9484;
    const host = await ask(rl, "Bind host", "0.0.0.0");
    const publicEndpoint = await ask(rl, "Public endpoint URL (blank = dev mode)");
    const autoDetectNatStr = (await ask(rl, "Auto-detect NAT via UPnP/STUN? [y/N]", "n")).toLowerCase();
    const autoDetectNat = autoDetectNatStr === "y" || autoDetectNatStr === "yes";
    const externalIpProbeUrl = autoDetectNat
      ? await ask(rl, "External IPv4 probe URL (optional fallback)", "https://api.ipify.org")
      : "";

    const node = generateNode({
      operator_id: op.operator_id,
      name,
      backend_url: backend,
      model,
      directory_url: directory,
      region,
      intent,
      port,
      host,
      public_endpoint: publicEndpoint,
      auto_detect_nat: autoDetectNat,
      external_ip_probe_url: externalIpProbeUrl,
    });
    const p = saveNode(node);
    process.stdout.write(`\n  ✓ saved ${p}  (node_id=${node.node_id})\n\n`);

    // Dependency check + optional auto-install (#346 parity with Python)
    process.stdout.write(`Checking dependencies …\n`);
    const issues = await checkDependencies(backend);
    printDepStatus(issues);
    const optionalCount = issues.filter((i) => (i.severity === "optional" || i.severity === "missing") && i.installable).length;
    if (optionalCount > 0) {
      const yn = (await ask(rl, `\nEnable ${optionalCount} optional package(s)? (your node runs without them) [Y/n]`, "y")).toLowerCase();
      if (yn === "" || yn === "y" || yn === "yes") {
        installMissing(issues);
      } else {
        process.stdout.write(`  ○ skipping — enable later with: npm install <pkg>\n`);
      }
    }

    process.stdout.write(`\nDocumentation:\n`);
    process.stdout.write(`  Docs:       https://iicp.network/docs/sdk-quickstart-docker\n`);
    process.stdout.write(`  Reference:  iicp-node --help\n`);
    process.stdout.write(`  Spec:       https://iicp.network/spec\n`);
    process.stdout.write(`\nRun: iicp-node serve --node ${name}\n`);
    return 0;
  } finally {
    rl.close();
  }
}

function runList(argv: string[] = []): number {
  const { values } = safeParseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printListHelp();
    return 0;
  }
  const nodes = listNodes();
  if (nodes.length === 0) {
    process.stdout.write(`No saved node configs. Run \`iicp-node init\` first.\n`);
    return 0;
  }
  process.stdout.write(`Saved nodes (${configDir()}/nodes):\n`);
  for (const n of nodes) {
    process.stdout.write(`  - ${n.name.padEnd(20)}  ${n.model.padEnd(24)}  ${n.public_endpoint || "(dev)"}\n`);
  }
  return 0;
}

// ── serve helpers ───────────────────────────────────────────────────────────

/**
 * Pure reachability escalation planner (tunnel-FIRST, relay = last resort; maintainer
 * 2026-06-13). Returns the ordered attempt sequence for a tier-≥3 node with no explicitly
 * configured relay; empty for tier<3 or an operator-configured relay. A self-hosted Quick
 * Tunnel is more autonomous than a third-party relay (no relay metadata/#510, one less hop);
 * --no-tunnel / IICP_TUNNEL=0 (tunnelEnabled=false) restores relay-first. Parity with the
 * Python/Rust planners; unit-tested so the reorder can't silently break.
 */
export function planReachability(
  tier: number,
  relayConfigured: boolean,
  tunnelEnabled: boolean,
): Array<"tunnel" | "relay" | "gossip"> {
  if (tier < 3 || relayConfigured) return [];
  return [...(tunnelEnabled ? (["tunnel"] as const) : []), "relay", "gossip"];
}

export function endpointIsLocalOrPrivate(endpoint: string): boolean {
  const ep = endpoint.toLowerCase();
  return ep.includes("://localhost") ||
    ep.includes("://127.") ||
    ep.includes("://0.0.0.0") ||
    ep.includes("://192.168.") ||
    ep.includes("://10.") ||
    Array.from({ length: 16 }, (_, i) => 16 + i).some((n) => ep.includes(`://172.${n}.`)) ||
    ep.includes("://[::1]") ||
    ep.includes("://[fc") ||
    ep.includes("://[fd");
}

export function directTunnelFallbackReason(
  endpoint: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile?: any,
): string | null {
  if (endpointIsLocalOrPrivate(endpoint)) return "local/private endpoint";
  if (profile && (Number(profile.tier ?? 0) >= 3 || profile.transportMethod === "unreachable")) {
    return "NAT traversal did not produce a direct public route";
  }
  if (endpoint.includes("://[")) {
    const pinholeActive = Boolean(profile?.ipv6?.pinholeActive);
    if (!pinholeActive) return "IPv6 direct endpoint has no verified inbound pinhole";
  }
  return null;
}

/** Query directory for relay-capable peers and elect one deterministically.
 *  Used when NAT detection returns tier≥3 (CGNAT + no usable IPv6).
 *  Returns [relayHost, relayPort] or null if no relay-capable peer is found.
 */
async function _autoElectRelay(
  directoryUrl: string,
  intent: string,
  nodeId: string,
): Promise<[string, number] | null> {
  try {
    const url = `${directoryUrl.replace(/\/$/, "")}/v1/discover?intent=${encodeURIComponent(intent)}&relay_capable=true`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { nodes?: Array<Record<string, unknown>> };
    const candidates = (data.nodes ?? []).filter(
      (n) => n.relay_capable && n.endpoint && n.node_id !== nodeId,
    );
    if (!candidates.length) return null;

    const { createHash } = await import("node:crypto");
    const scored = candidates.map((c) => ({
      c,
      score: [
        Number(c.load ?? 0),
        createHash("sha256").update(`${nodeId}:${String(c.node_id)}`).digest("hex"),
      ] as [number, string],
    }));
    scored.sort((a, b) => {
      if (a.score[0] !== b.score[0]) return a.score[0] - b.score[0];
      return a.score[1] < b.score[1] ? -1 : 1;
    });
    const elected = scored[0].c;
    const endpoint = String(elected.endpoint ?? "").replace(/\/$/, "");
    const u = new URL(endpoint.startsWith("http") ? endpoint : `http://${endpoint}`);
    const relayHost = u.hostname;
    const relayPort = (elected.relay_accept_port as number | undefined) ?? 9485;
    if (!relayHost) return null;
    return [relayHost, relayPort];
  } catch {
    return null;
  }
}

/**
 * Return the first bindable TCP port >= `start` on `host`.
 *
 * The official IICP port 9484 is the starting point; when running multiple
 * nodes on one host (each model on its own port → its own pinhole) the second
 * node auto-increments to 9485, the third to 9486, and so on. Probes by
 * attempting a real listen so the chosen port is genuinely free before NAT
 * detection opens a pinhole and the directory registration advertises it.
 */
function findAvailablePort(host: string, start: number, maxTries = 64): Promise<number> {
  const bindHost = host === "" || host === "0.0.0.0" ? "0.0.0.0" : host;
  return new Promise((resolve) => {
    let candidate = start;
    const tryBind = (): void => {
      if (candidate >= start + maxTries) {
        resolve(start); // exhausted — let serve() surface the real bind error
        return;
      }
      const srv = net.createServer();
      srv.once("error", () => {
        srv.close();
        candidate += 1;
        tryBind();
      });
      srv.once("listening", () => {
        const chosen = candidate;
        srv.close(() => resolve(chosen));
      });
      srv.listen(candidate, bindHost);
    };
    tryBind();
  });
}

// ── serve ───────────────────────────────────────────────────────────────────

export function applySavedNode(opts: ServeOpts, saved: NodeIdentity): ServeOpts {
  return {
    ...opts,
    // Onboarding: default to Ollama's well-known local port so only --model is required.
    // #414/C1 — an `anthropic` backend defaults to the Anthropic API, not localhost.
    backendUrl:
      opts.backendUrl ||
      saved.backend_url ||
      (opts.backendType === "anthropic" ? "https://api.anthropic.com" : "http://localhost:11434"),
    model: opts.model || saved.model,
    publicEndpoint: opts.publicEndpoint || saved.public_endpoint,
    directoryUrl: opts.directoryUrl || saved.directory_url,
    region: opts.region || saved.region,
    intent: opts.intent || saved.intent,
    nodeId: opts.nodeId || saved.node_id,
    maxConcurrent: opts.maxConcurrent === 4 ? saved.max_concurrent : opts.maxConcurrent,
    port: opts.port === 9484 ? saved.port : opts.port,
    host: opts.host === "::" ? saved.host : opts.host,
    autoDetectNat: opts.autoDetectNat || saved.auto_detect_nat,
    externalIpProbeUrl: opts.externalIpProbeUrl || saved.external_ip_probe_url,
    nodeHmacKey: opts.nodeHmacKey || saved.node_hmac_key || undefined,
    receiptProfiles: opts.receiptProfiles ?? resolveReceiptProfiles(undefined, undefined, saved.supported_receipt_profiles),
  };
}

async function runServe(opts: ServeOpts): Promise<number> {
  // CIP toggle via env var — keeps the SDK opt-out by default (safe) but
  // lets operators advertise as a CIP worker by exporting one env var.
  if (envBool("IICP_CIP_ALLOW_WORKER")) {
    configureCipPolicy({
      enabled: true,
      allowWorker: true,
      allowCoordinator: true,
    });
  }

  // 2-C: co-host the compat proxy on loopback alongside the node, supervised so a
  // proxy failure logs but never drops the network-facing node. Forced to 127.0.0.1.
  if (opts.withProxy) {
    const pport = envInt("IICP_PROXY_PORT", 9483);
    const pclient = new IicpClient({
      directory_url: opts.directoryUrl,
      region: opts.region,
    }) as unknown as TaskClient;
    const pserver = createProxyServer(pclient);
    pserver.on("error", (e) => process.stderr.write(`co-hosted proxy error (node continues): ${String(e)}\n`));
    pserver.listen(pport, "127.0.0.1", () =>
      process.stdout.write(`co-hosted proxy → http://127.0.0.1:${pport} (OpenAI/Ollama/Anthropic compat)\n`),
    );
  }

  // Phase 2 (#529/#55) — capture any cached node_token so the node can prove
  // ownership on re-registration (IICP-E050 token path).
  let savedNodeToken: string | undefined;
  if (opts.node) {
    const saved = loadNode(opts.node);
    if (!saved) {
      process.stderr.write(
        `ERROR: no saved config at ~/.iicp/nodes/${opts.node}.json. Run \`iicp-node init\` first.\n`,
      );
      return 2;
    }
    savedNodeToken = saved.node_token ?? undefined;
    opts = applySavedNode(opts, saved);
  }

  // #410/#414 — built-in backend-url fallback applied LAST (after flag/env/saved-config),
  // so a bare `serve --model x` works without --backend-url. An `anthropic` backend
  // defaults to the Anthropic API, not localhost Ollama. Mirrors Python cli.py ~704.
  if (!opts.backendUrl) {
    opts.backendUrl = opts.backendType === "anthropic"
      ? "https://api.anthropic.com"
      : opts.backendType === "meshllm"
        ? "http://localhost:9337/v1"
        : "http://localhost:11434";
  }
  // Resolve the public default only after a saved node has had the opportunity
  // to supply its own directory URL. This preserves saved-node precedence.
  if (!opts.directoryUrl) opts.directoryUrl = "https://iicp.network/api";

  // Onboarding: if no --model given, auto-select the first model the backend advertises
  // (Ollama /api/tags) so a bare `iicp-node serve` just works (parity with Rust/Python).
  if (!opts.model && opts.backendUrl) {
    try {
      const tagsUrl = opts.backendUrl.replace(/\/$/, "") + "/api/tags";
      const r = await fetch(tagsUrl, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const d = (await r.json()) as { models?: Array<{ name: string }> };
        const first = (d.models ?? [])[0]?.name;
        if (first) {
          opts.model = first;
          process.stderr.write(`[iicp-node] no --model given — auto-selected '${first}' from ${opts.backendUrl}\n`);
        }
      }
    } catch {
      // best-effort; the required-model check below surfaces a clear error
    }
    // MeshLLM is OpenAI-compatible rather than Ollama-compatible. Its model
    // inventory decides routing, so never choose an arbitrary model when several
    // are available.
    if (!opts.model) {
      try {
        const root = opts.backendUrl.replace(/\/$/, "").replace(/\/v1$/, "");
        const r = await fetch(`${root}/v1/models`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const d = (await r.json()) as { data?: Array<{ id?: string }> };
          const models = (d.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
          if (opts.backendType === "meshllm" && models.length > 1) {
            process.stderr.write(`ERROR: MeshLLM advertises multiple models; select one with --model: ${models.join(", ")}\n`);
            return 2;
          }
          if (models.length === 1) {
            opts.model = models[0];
            process.stderr.write(`[iicp-node] no --model given — auto-selected '${opts.model}' from ${opts.backendUrl}\n`);
          }
        }
      } catch { /* required-model check below remains authoritative */ }
    }
  }

  if (opts.backendType === "meshllm" && opts.model === "mesh" && !opts.experimental) {
    process.stderr.write("ERROR: MeshLLM model 'mesh' is experimental; pass --experimental explicitly to enable it.\n");
    return 2;
  }

  if (!opts.backendUrl || !opts.model) {
    process.stderr.write(
      "ERROR: --model is required (--backend-url defaults to http://localhost:11434). Set IICP_BACKEND_MODEL, or use --node NAME.\n",
    );
    return 2;
  }
  if (!(BACKEND_TYPES as readonly string[]).includes(opts.backendType)) {
    process.stderr.write(
      `ERROR: --backend-type must be one of ${JSON.stringify(BACKEND_TYPES)}.\n`,
    );
    return 2;
  }
  const nodeId = (opts.nodeId || randomUUID()).slice(0, 36);
  const logDir = opts.logDir;

  // #405 — single-instance lock: refuse a second LIVE process for this node_id
  // (the token-rotation war). Distinct node_ids are unaffected. Fails open.
  let instanceLock: InstanceLock;
  try {
    instanceLock = InstanceLock.acquire(nodeId, opts.force);
  } catch (exc) {
    if (exc instanceof NodeAlreadyServingError) {
      console.error(`[iicp-node] ${exc.message}`);
      process.exit(2);
    }
    throw exc;
  }

  // Resolve the actual listen port before NAT detection: start at the
  // requested port (default 9484, the official IICP port) and auto-increment
  // to the next free port. Keeps one port per node (multiple models share it)
  // while N nodes on one host each get a distinct port → distinct pinhole.
  // Skipped when the operator supplies an explicit --public-endpoint.
  if (!opts.publicEndpoint) {
    const resolvedPort = await findAvailablePort(opts.host, opts.port);
    if (resolvedPort !== opts.port) {
      console.log(
        `[iicp-node] port ${opts.port} in use — auto-incremented to first free port ${resolvedPort}.`,
      );
      opts.port = resolvedPort;
    }
  }

  let publicEndpoint = opts.publicEndpoint || `http://localhost:${opts.port}`;

  // #520 rung 5 — Quick Tunnel escalation state (see src/tunnel.ts).
  const tunnelPref: boolean | undefined = opts.tunnel;
  let tunnelHandle: import("./tunnel.js").QuickTunnel | null = null;
  let quickTunnelAttempted = false;
  const openTunnelRung = async (
    localPort: number,
    forced: boolean,
  ): Promise<import("./tunnel.js").QuickTunnel | null> => {
    const { INSTALL_HINT, cloudflaredPath, openQuickTunnel } = await import("./tunnel.js");
    if (!cloudflaredPath()) {
      // eslint-disable-next-line no-console
      console.warn(`[iicp-node] ${INSTALL_HINT}`);
      return null;
    }
    try {
      const t = await openQuickTunnel(localPort);
      // eslint-disable-next-line no-console
      console.log(
        `[iicp-node] NAT rung 5${forced ? " (forced)" : ""}: public https endpoint via ` +
          `Quick Tunnel — ${t.url} (zero-account; URL rotates on restart)`,
      );
      return t;
    } catch (exc) {
      // eslint-disable-next-line no-console
      console.warn(
        `[iicp-node] Quick Tunnel failed to start: ${exc instanceof Error ? exc.message : exc} — continuing without it`,
      );
      return null;
    }
  };

  // ADR-043 §5 / #343 — Tier-0 IPv6 pinhole attempt. Runs unconditionally
  // when the operator's public_endpoint is bracketed-IPv6, even without
  // --auto-detect-nat. Mirrors Python's cli.py path: try AddPinhole on
  // each local GUA (ranked: current-temp → secured → deprecated), rewrite
  // the endpoint URL if a different GUA was the one the router accepted.
  let tier0Pinhole: {
    pinholeActive: boolean;
    pinholeUniqueId?: number;
    pinholeLeaseSeconds?: number;
    pinholeInboundAllowed?: boolean;
    detectionLog: string[];
  } | null = null;
  if (!opts.autoDetectNat && publicEndpoint.includes("[")) {
    try {
      const { tryOpenV6PinholeForEndpoint } = await import("./nat_detection.js");
      const r = await tryOpenV6PinholeForEndpoint(publicEndpoint, opts.port);
      for (const line of r.detectionLog) {
        // eslint-disable-next-line no-console
        console.log(`[iicp-node] v6: ${line}`);
      }
      if (r.rewrittenEndpoint) {
        publicEndpoint = r.rewrittenEndpoint;
      }
      tier0Pinhole = r;
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      // eslint-disable-next-line no-console
      console.warn(`[iicp-node] v6 pinhole attempt failed: ${msg}`);
    }
  }

  // ADR-041 / #343 — NAT detection + relay election BEFORE node creation so
  // relay config is available in the IicpNode constructor.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let natProfile: any = null;
  if (opts.autoDetectNat) {
    try {
      const { detectNat } = await import("./nat_detection.js");
      natProfile = await detectNat({
        bindHost: opts.host,
        bindPort: opts.port,
        operatorPublicEndpoint: opts.publicEndpoint || undefined,
        externalIpProbeUrl: opts.externalIpProbeUrl || undefined,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[iicp-node] NAT auto-detect: tier=${natProfile.tier} method=${natProfile.transportMethod} ` +
          `public=${natProfile.publicEndpoint ?? "<none>"} ipv6_pinhole=${natProfile.ipv6?.pinholeActive ?? false}`,
      );
      if (natProfile.publicEndpoint) publicEndpoint = natProfile.publicEndpoint as string;

      // Tier ≥ 3 (CGNAT + no usable IPv6 path), no relay configured → TUNNEL-FIRST,
      // relay = last resort (maintainer 2026-06-13 choreography: tunnel → relay → gossip).
      // A Quick Tunnel gives the node its OWN public endpoint — more autonomous than a
      // third-party relay (no relay metadata/#510, one less hop); rotation mitigated by #538.
      // --no-tunnel / IICP_TUNNEL=0 opts out → relay becomes first again.
      // Escalation order from the pure, unit-tested planner (tested order == used order).
      for (const step of planReachability(natProfile.tier, !!opts.relayWorkerEndpoint, tunnelPref !== false)) {
        if (step === "tunnel") {
          // eslint-disable-next-line no-console
          console.log(
            `[iicp-node] NAT tier=${natProfile.tier}: opening Quick Tunnel (rung 5) for an autonomous public endpoint…`,
          );
          quickTunnelAttempted = true;
          tunnelHandle = await openTunnelRung(opts.port, false);
          if (tunnelHandle) {
            publicEndpoint = tunnelHandle.url;
            break;
          }
        } else if (step === "relay") {
          if (!relayWorkerFallbackAllowed(opts.relayCapable)) {
            // eslint-disable-next-line no-console
            console.warn(
              `[iicp-node] NAT tier=${natProfile.tier}: no tunnel for relay-capable node — ` +
                "not falling back through another relay; supervisor will retry the public route.",
            );
            break;
          }
          // eslint-disable-next-line no-console
          console.log(
            `[iicp-node] NAT tier=${natProfile.tier}: no tunnel — auto-electing a relay from directory (last resort)…`,
          );
          const elected = await _autoElectRelay(
            opts.directoryUrl ?? "https://iicp.network/api",
            opts.intent,
            nodeId,
          );
          if (elected) {
            const [relayHost, relayPort] = elected;
            opts = { ...opts, relayWorkerEndpoint: `${relayHost}:${relayPort}` };
            // eslint-disable-next-line no-console
            console.log(`[iicp-node] auto-elected relay (last resort): ${relayHost}:${relayPort}`);
            break;
          }
        } else if (step === "gossip") {
          // eslint-disable-next-line no-console
          console.warn(
            `[iicp-node] NAT tier=${natProfile.tier}: no tunnel and no relay-capable peers. ` +
            `Set IICP_RELAY_WORKER_ENDPOINT=<host>:<port> to specify a relay manually.`,
          );
        }
      }
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      // eslint-disable-next-line no-console
      console.warn(`[iicp-node] NAT auto-detect failed: ${msg} — continuing with configured endpoint`);
    }
  }

  // #520 — `--tunnel` forces rung 5 regardless of NAT tier (e.g. an operator
  // who KNOWS they're unreachable, or wants an https endpoint for browser
  // consumers without touching the router).
  if (tunnelPref === true && tunnelHandle === null) {
    quickTunnelAttempted = true;
    tunnelHandle = await openTunnelRung(opts.port, true);
    if (tunnelHandle) publicEndpoint = tunnelHandle.url;
  }

  // Maximum-adoption fallback: keep the direct listener, but if the advertised
  // direct route is local/private or IPv6 without a verified inbound pinhole,
  // publish a Quick Tunnel by default. Operators can opt out with --no-tunnel /
  // IICP_TUNNEL=0.
  if (
    tunnelPref !== false &&
    tunnelHandle === null &&
    !opts.relayWorkerEndpoint &&
    !opts.skipRegistration
  ) {
    const reason = directTunnelFallbackReason(publicEndpoint, natProfile);
    if (reason) {
      // eslint-disable-next-line no-console
      console.log(
        `[iicp-node] direct endpoint needs public fallback (${reason}) — opening Quick Tunnel automatically…`,
      );
      if (quickTunnelAttempted) {
        // eslint-disable-next-line no-console
        console.log(
          "[iicp-node] Quick Tunnel was already attempted for this startup; " +
            "falling back to the previous reachability method.",
        );
      } else {
        quickTunnelAttempted = true;
        tunnelHandle = await openTunnelRung(opts.port, false);
      }
      if (tunnelHandle) {
        publicEndpoint = tunnelHandle.url;
      } else if (relayWorkerFallbackAllowed(opts.relayCapable)) {
        // eslint-disable-next-line no-console
        console.log("[iicp-node] no tunnel available — auto-electing a relay from directory (last resort)…");
        const elected = await _autoElectRelay(
          opts.directoryUrl ?? "https://iicp.network/api",
          opts.intent,
          nodeId,
        );
        if (elected) {
          const [relayHost, relayPort] = elected;
          opts = { ...opts, relayWorkerEndpoint: `${relayHost}:${relayPort}` };
          // eslint-disable-next-line no-console
          console.log(`[iicp-node] auto-elected relay (last resort): ${relayHost}:${relayPort}`);
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "[iicp-node] no tunnel available for relay-capable node — not falling back through " +
            "another relay; supervisor will retry the public route.",
        );
        await exitIfSupervisedPublicFallbackUnrecovered();
      }
    }
  }

  const backendFlavor = await detectBackendFlavor(opts.backendUrl, opts.backendApiKey, opts.backendType);
  process.stderr.write(`backend detected: ${backendFlavor}\n`);

  // #463/#464 — bind the operator identity: issue a delegation FROM the (key-backed) operator
  // identity for this node and advertise the public display_name. The directory verifies the
  // delegation (operator_pub == operator_id) and records the operator. Never sends the secret/contact.
  const _op = loadOperator();
  let _opDelegation: ReturnType<typeof issueDelegation> | undefined;
  let _opDisplayName: string | undefined;
  let _opCreatedAt: string | undefined;
  let _opIntegrityHash: string | undefined;
  let policyManifest: Record<string, unknown> | undefined;
  const _identityNotice = noIdentityNotice(_op);
  if (_identityNotice !== null) {
    // #503 — anonymous registration accrues no founder/recognition standing;
    // say so loudly instead of silently excluding the operator. Non-fatal.
    process.stderr.write(_identityNotice + "\n");
  }
  if (_op && operatorIsKeyBacked(_op)) {
    _opDelegation = issueDelegation(operatorSigningKey(_op), nodeId);
    _opDisplayName = _op.display_name || undefined;
    _opCreatedAt = _op.created_at;
    _opIntegrityHash = _op.operator_integrity_hash || undefined;
    if (opts.policyManifest) {
      const { loadAndSignPolicyManifest } = await import("./policy_manifest.js");
      policyManifest = loadAndSignPolicyManifest(opts.policyManifest, _op);
    }
  }
  if (opts.policyManifest && !policyManifest) throw new Error("--policy-manifest requires a key-backed operator identity");

  const node = new IicpNode({
    nodeId,
    endpoint: publicEndpoint,
    intent: opts.intent,
    model: opts.model,
    backend: backendFlavor,
    region: opts.region || "unknown",
    directoryUrl: opts.directoryUrl,
    maxConcurrent: opts.maxConcurrent,
    relayWorkerEndpoint: opts.relayWorkerEndpoint || undefined,
    relayCapable: opts.relayCapable ?? false,
    relayAcceptPort: opts.relayAcceptPort ?? 9485,
    nodeHmacKey: opts.nodeHmacKey || undefined,
    operatorDelegation: _opDelegation,
    operatorDisplayName: _opDisplayName,
    operatorCreatedAt: _opCreatedAt,
    operatorIntegrityHash: _opIntegrityHash,
    policyManifest,
    supportedReceiptProfiles: opts.receiptProfiles ?? [],
    // #494 — wire backend URL for live health_models probing in heartbeats.
    backendUrl: opts.backendUrl || undefined,
    backendApiKey: opts.backendApiKey || undefined,
  });

  if (opts.node) node.setSavedNodeName(opts.node);
  // Phase 2 (#529/#55) — seed the cached node_token so a re-registration (e.g.
  // after a tunnel-URL rotation) proves ownership via current_node_token.
  if (savedNodeToken) node.seedToken(savedNodeToken);

  // Apply collected NAT profile (covers both auto-detect and tier-0 IPv6 cases).
  if (natProfile) {
    node.applyNatProfile(natProfile);
    // ADR-043 §9 (#344) — derive the canonical exposure_mode from the FULL profile
    // (applyNatProfile's param is a structural subset) and set it on the node config.
    try {
      const { qualifyService } = await import("./qualify.js");
      (node["_cfg"] as Record<string, unknown>).exposureMode = qualifyService(natProfile).exposureMode;
    } catch {
      // best-effort; exposure_mode stays unset if qualification can't run
    }
  } else if (tier0Pinhole) {
    node.applyNatProfile({
      tier: 0,
      transportMethod: "direct",
      publicEndpoint,
      detectionLog: tier0Pinhole.detectionLog,
      isReachable: () => true,
      ipv6: {
        pinholeActive: tier0Pinhole.pinholeActive,
        pinholeUniqueId: tier0Pinhole.pinholeUniqueId,
      },
    });
  }
  if (tunnelHandle) {
    (node["_cfg"] as Record<string, unknown>).endpoint = publicEndpoint;
    (node["_cfg"] as Record<string, unknown>).transportMethod = "external_tunnel";
    (node["_cfg"] as Record<string, unknown>).exposureMode = "tunnel_required";
    (node["_cfg"] as Record<string, unknown>).transportMetadata = {
      tier: 3,
      detection_log_tail: ["rung 5: quick tunnel"],
    };
  }

  // Normalize to the OpenAI-dialect root: the handler appends /chat/completions,
  // so baseUrl MUST end in /v1 (Ollama serves the OpenAI dialect at /v1). An
  // operator naturally passes --backend-url http://host:11434 (matching the
  // /api/tags probe URL), so append /v1 if absent. Mirrors the Python CLI; the
  // raw backendUrl is kept for the /api/tags model probe below.
  const _baseUrl = (() => {
    const t = opts.backendUrl.replace(/\/$/, "");
    return t.endsWith("/v1") ? t : `${t}/v1`;
  })();
  const handler = getBackendHandler(opts.backendType, {
    baseUrl: _baseUrl,
    model: opts.model,
    // #5 — Bearer key for auth'd backends (LM Studio, hosted). Empty/undefined = no header.
    apiKey: opts.backendApiKey || undefined,
  });

  // GAP-6: probe backend for all available models so the registration advertises
  // the full list — not just the single configured model. Best-effort; fall back
  // to the single configured model on any error.
  try {
    // #409 — strip a trailing /v1 to a root so probe URLs are well-formed for
    // both Ollama (`http://host:11434`) and LM Studio/OpenAI-compat
    // (`http://host:1234/v1`); attach the Bearer key (LM Studio /v1/models 401s
    // without it). Without this, /v1 backends got `…/v1/v1/models` (404) and no
    // models were discovered, so multi-intent never fired.
    const base = opts.backendUrl.replace(/\/$/, "");
    const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
    const headers: Record<string, string> = opts.backendApiKey
      ? { Authorization: `Bearer ${opts.backendApiKey}` }
      : {};
    const allModels = await (async (): Promise<string[]> => {
      // Ollama /api/tags ({models:[{name}]})
      try {
        const r = await fetch(`${root}/api/tags`, { headers, signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const d = await r.json() as { models?: Array<{ name: string }> };
          const names = (d.models ?? []).map((m) => m.name);
          if (names.length > 0) return names;
        }
      } catch { /* try OpenAI next */ }
      // OpenAI-compat /v1/models ({data:[{id}]})
      try {
        const r = await fetch(`${root}/v1/models`, { headers, signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const d = await r.json() as { data?: Array<{ id: string }> };
          return (d.data ?? []).map((m) => m.id).filter(Boolean);
        }
      } catch { /* best-effort */ }
      return [];
    })();
    const extra = allModels.filter(
      (m) => m !== opts.model && (opts.backendType !== "meshllm" || opts.experimental || m !== "mesh"),
    );
    if (extra.length > 0) {
      node["_cfg"].capabilities = extra;
      // eslint-disable-next-line no-console
      console.log(`[iicp-node] GAP-6: advertising ${extra.length} additional model(s): ${extra.slice(0, 6).join(", ")}`);
    }
  } catch {
    // best-effort; no-op on error
  }
  if (opts.backendType === "meshllm" && !opts.experimental) {
    (node["_cfg"] as Record<string, unknown>).excludedModels = ["mesh"];
  }

  // NAT-4 guard: if endpoint is non-routable and no relay configured, skip
  // registration to avoid a confusing 422 from the directory's RoutableEndpoint check.
  const epLocal = endpointIsLocalOrPrivate(publicEndpoint);
  if (epLocal && !opts.relayWorkerEndpoint && !opts.skipRegistration) {
    // eslint-disable-next-line no-console
    console.warn(
      "[iicp-node] no routable endpoint detected and no relay configured — " +
        "skipping directory registration. Node will accept direct connections " +
        "but will not appear in discover results. " +
        "Set IICP_PUBLIC_ENDPOINT=<url> or IICP_RELAY_WORKER_ENDPOINT=<host>:<port> to register.",
    );
    opts.skipRegistration = true;
  }

  // #457 / ADR-040 — advertise the native IICP binary transport. serve() multiplexes it
  // onto the SAME socket as HTTP (first-byte detection), so transport_endpoint shares the
  // endpoint's host:port with the iicp:// scheme. Set from the FINAL endpoint (after NAT
  // profile application); register() only sends it when registering (skipRegistration gates
  // the non-routable case) → advertise-when-reachable. Opt out with IICP_DISABLE_NATIVE_TRANSPORT=1.
  if (!opts.skipRegistration && process.env["IICP_DISABLE_NATIVE_TRANSPORT"] !== "1") {
    const finalEndpoint = (node["_cfg"] as { endpoint?: string }).endpoint;
    const nativeEndpoint = finalEndpoint ? deriveNativeEndpoint(finalEndpoint) : null;
    if (nativeEndpoint) {
      (node["_cfg"] as Record<string, unknown>).transportEndpoint = nativeEndpoint;
    }
  }

  // #404 — register with bounded backoff retry. On persistent failure, pass an
  // empty token (NOT undefined) so the heartbeat loop still starts and re-registers
  // on the first 401 (#399 path) once the directory is reachable — the self-healing
  // watchdog. undefined is reserved for --skip-registration (no heartbeat by design).
  let token: string | undefined;
  if (!opts.skipRegistration) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        token = await node.register();
        // eslint-disable-next-line no-console
        console.log(`[iicp-node] registered as ${nodeId} (token=${(token ?? "").slice(0, 8)}…)`);
        writeNodeEvent(nodeId, "register_ok", `endpoint=${opts.publicEndpoint || `http://localhost:${opts.port}`}`, logDir);
        // #456 / TC-9c — cache token + HMAC key in the saved config so `iicp-node credits`
        // can authenticate later and CIPWorkerReceipts work immediately on restart (best-effort).
        if (opts.node && token) {
          const saved = loadNode(opts.node);
          if (saved) {
            saved.node_token = token;
            const hmacKey = node.nodeHmacKey;
            if (hmacKey) saved.node_hmac_key = hmacKey;
            try {
              saveNode(saved);
            } catch {
              /* best-effort cache */
            }
          }
        }
        if (opts.node) completeHandoffForNode(opts.node);
        break;
      } catch (exc) {
        const msg = exc instanceof Error ? exc.message : String(exc);
        if (attempt >= 3) {
          // eslint-disable-next-line no-console
          console.warn(`[iicp-node] registration failed after ${attempt} attempts: ${msg} — starting heartbeat loop anyway; it will re-register on the first 401`);
          writeNodeEvent(nodeId, "register_fail", `error=${msg} attempts=${attempt}`, logDir);
          token = ""; // empty (not undefined) → heartbeat loop starts and self-heals
          break;
        }
        const backoff = 2 ** attempt;
        // eslint-disable-next-line no-console
        console.warn(`[iicp-node] registration attempt ${attempt} failed: ${msg} — retrying in ${backoff}s`);
        await new Promise((r) => setTimeout(r, backoff * 1000));
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[iicp-node] serving ${opts.intent} on ${opts.host}:${opts.port} — ` +
      `backend ${opts.backendUrl} (model=${opts.model}, max_concurrent=${opts.maxConcurrent})`,
  );
  writeNodeEvent(nodeId, "serve_start", `port=${opts.port} model=${opts.model} intent=${opts.intent}`, logDir);
  const stopAutoUpdate = startProviderAutoUpdate();
  // serve() returns a stop() handle but never resolves on its own; we wait for
  // SIGINT/SIGTERM to terminate.
  if (tunnelHandle) {
    // The endpoint was already the tunnel URL at construction; mark the
    // transport and arm the elastic watchdog (URL rotates per process → verify
    // public health, then re-register; twilight/recovery heartbeats are unavailable).
    (node["_cfg"] as Record<string, unknown>).transportMethod = "external_tunnel";
    tunnelHandle.watch(
      (url) => {
        (node["_cfg"] as Record<string, unknown>).endpoint = url;
        void node.register().catch((exc) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[iicp-node] tunnel re-register failed: ${exc instanceof Error ? exc.message : exc}`,
          );
        });
      },
      () => {
        // eslint-disable-next-line no-console
        console.error(
          "[iicp-node] Quick Tunnel permanently down — this node is no longer " +
            "publicly reachable. Restart `iicp-node serve` to recover.",
        );
      },
      {
        elastic: true,
        onDeadAction: () => {
          const behavior = tunnelDeadBehavior(tunnelDeadPolicyFromEnv(), envBool("IICP_SUPERVISED"));
          if (behavior === "exit") {
            // eslint-disable-next-line no-console
            console.error(
              `[iicp-node] supervised tunnel failure policy is exit — terminating with code ${TUNNEL_DEAD_EXIT_CODE} so the supervisor can restart.`,
            );
            process.exit(TUNNEL_DEAD_EXIT_CODE);
          }
          return behavior === "retry" ? "retry" : "stop";
        },
        onState: (state) => {
          node.setRuntimeAvailable(state === "ready");
          // eslint-disable-next-line no-console
          console.log(`[iicp-node] Quick Tunnel state: ${state}`);
        },
      },
    );
  }

  const handoffTimer = scheduleSupervisedHandoffRestart(opts.node);
  const stop = node.serve(handler, { host: opts.host, port: opts.port, nodeToken: token });
  await new Promise<void>((resolve) => {
    const shutdown = async (sig: string) => {
      // eslint-disable-next-line no-console
      console.log(`[iicp-node] ${sig} received — shutting down`);
      try {
        await node.revokePinhole();
      } catch (exc) {
        // eslint-disable-next-line no-console
        console.warn(`[iicp-node] pinhole revoke failed: ${exc instanceof Error ? exc.message : exc}`);
      }
      try {
        if (token) {
          await node.deregister(token);
          writeNodeEvent(nodeId, "deregister_ok", "", logDir);
        }
      } catch (exc) {
        const deregMsg = exc instanceof Error ? exc.message : String(exc);
        // eslint-disable-next-line no-console
        console.warn(`[iicp-node] deregister failed: ${deregMsg}`);
        writeNodeEvent(nodeId, "deregister_fail", `error=${deregMsg}`, logDir);
      }
      tunnelHandle?.close(); // #520 — tear the Quick Tunnel down with the node
      stop();
      if (handoffTimer) clearTimeout(handoffTimer);
      stopAutoUpdate();
      instanceLock.release(); // #405 — free the pidfile on shutdown
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
  // generate unused nodeId silently to keep the helper imported in --help-only paths
  void randomUUID;
  return 0;
}

function printQueryHelp(): void {
  process.stdout.write(
    `usage: iicp-node query <prompt> [options]\n\n` +
      `Discover mesh nodes and submit a chat task.\n\n` +
      `options:\n` +
      `  --directory-url URL        IICP_DIRECTORY_URL (default https://iicp.network/api)\n` +
      `  --intent URN               IICP_INTENT (default urn:iicp:intent:llm:chat:v1)\n` +
      `  --model NAME               Pin to a specific model on the remote node\n` +
      `  --max-tokens N             Limit response length\n` +
      `  --timeout-ms N             Request timeout in milliseconds (default 60000)\n` +
      `  --routing-profile NAME     standard | sensitive | eu-restricted | strict-policy | debug-override\n` +
      `  --allow-remote-executor    Explicitly allow remote executor prompt visibility for restrictive profiles\n` +
      `  --region-allowlist LIST    Comma-separated allowed regions before prompt dispatch\n` +
      `  -h, --help                 Show this help and exit\n`,
  );
}

async function runQuery(argv: string[]): Promise<number> {
  const { values, positionals } = safeParseArgs({
    args: argv,
    options: {
      "directory-url": { type: "string" },
      intent: { type: "string" },
      model: { type: "string" },
      "max-tokens": { type: "string" },
      "timeout-ms": { type: "string" },
      "routing-profile": { type: "string" },
      "allow-remote-executor": { type: "boolean" },
      "region-allowlist": { type: "string" },
      node: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printQueryHelp();
    return 0;
  }

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    printQueryHelp();
    return 1;
  }

  const directoryUrl =
    (values["directory-url"] as string | undefined) ??
    process.env["IICP_DIRECTORY_URL"] ??
    "https://iicp.network/api";
  const intent =
    (values["intent"] as string | undefined) ??
    process.env["IICP_INTENT"] ??
    "urn:iicp:intent:llm:chat:v1";
  const timeoutMs = parseInt((values["timeout-ms"] as string | undefined) ?? "60000", 10);

  const payload: Record<string, unknown> = {
    messages: [{ role: "user", content: prompt }],
  };
  if (values["model"]) payload["model"] = values["model"];
  if (values["max-tokens"]) payload["max_tokens"] = parseInt(values["max-tokens"] as string, 10);
  const routingProfile = String(
    (values["routing-profile"] as string | undefined) ??
    process.env["IICP_ROUTING_PROFILE"] ??
    "standard",
  ).replace(/-/g, "_");
  const regionAllowlist = String(
    (values["region-allowlist"] as string | undefined) ??
    process.env["IICP_REGION_ALLOWLIST"] ??
    "",
  ).split(",").map((r) => r.trim()).filter(Boolean);

  // #488 — resolve querying node identity for self-query neutrality.
  const nodeCfg = (values["node"] as string | undefined) ?? process.env["IICP_NODE"];
  let sourceNodeId: string | undefined;
  if (nodeCfg) {
    const saved = loadNode(nodeCfg);
    if (saved) sourceNodeId = saved.node_id;
  }

  const client = new IicpClient({ directory_url: directoryUrl, timeout_ms: timeoutMs, tls_verify: true });
  process.stderr.write(`[iicp-node] Discovering nodes for ${intent}...\n`);
  if (routingProfile !== "sensitive") {
    process.stderr.write(
      "[iicp-node] privacy: the selected remote executor can read prompts it executes; " +
      "use --routing-profile sensitive for fail-closed no-remote dispatch.\n",
    );
  }

  try {
    const resp = await client.submit({
      task_id: randomUUID(),
      intent,
      payload,
      source_node_id: sourceNodeId,
      routing_policy: {
        profile: routingProfile,
        allowed_regions: regionAllowlist.length > 0 ? regionAllowlist : undefined,
        allow_remote_executor: values["allow-remote-executor"] === true ? true : undefined,
      },
    });
    // Spec terminal success status is "success" (was "completed"); accept both.
    if ((resp.status === "success" || resp.status === "completed") && resp.result) {
      const res = resp.result as Record<string, unknown>;
      const content =
        typeof res["content"] === "string"
          ? res["content"]
          : JSON.stringify(resp.result, null, 2);
      process.stdout.write(content + "\n");
      if (resp.metrics?.node_id) {
        process.stderr.write(`[iicp-node] routed to node ${resp.metrics.node_id.slice(0, 8)}\n`);
      }
      if (resp.metrics?.latency_ms != null) {
        process.stderr.write(`[iicp-node] latency ${resp.metrics.latency_ms.toFixed(0)}ms\n`);
      }
      return 0;
    }
    process.stderr.write(`[iicp-node] task status: ${resp.status}\n`);
    return 1;
  } catch (e) {
    process.stderr.write(`ERROR: ${e}\n`);
    return 1;
  }
}

/** SPKI DER prefix for an Ed25519 public key (12 bytes); + 32 raw key bytes = a parseable SPKI key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** #458 hash-chain genesis root: SHA256_hex("iicp:dir:event-log:genesis:v1"). The prev_hash
 *  of a genesis/legacy event; bound into the signing input the directory verifies against. */
const EVENT_LOG_GENESIS_ROOT = "c44802bedf3e63b5a3f1634c5d19263634f92f26dd15401b09b06dd53a80cf9d";

/**
 * A JSON value where every number keeps its ORIGINAL source literal (`{ __num }`).
 * JS loses the int/float distinction on `JSON.parse` (5.0 → 5), but the directory
 * signs over `serde_json`'s rendering where a whole float is `"5.0"`. By capturing the
 * literal from the directory's own JSON output — produced by the same serializer as its
 * canonical form — we reproduce the signed bytes exactly, no matter the value. (#456)
 */
type LNode = string | boolean | null | { __num: string } | LNode[] | { [k: string]: LNode };

function isLNum(v: LNode): v is { __num: string } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "__num" in v;
}

/** Minimal recursive-descent JSON parse that preserves number literals verbatim. */
function losslessParse(text: string): LNode {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const parseStr = (): string => {
    i++; // opening quote
    let s = "";
    while (text[i] !== '"') {
      const ch = text[i]!;
      if (ch === "\\") {
        const e = text[++i]!;
        if (e === "u") {
          s += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
          i += 5;
        } else {
          const map: Record<string, string> = {
            '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
          };
          s += map[e] ?? e;
          i++;
        }
      } else {
        s += ch;
        i++;
      }
    }
    i++; // closing quote
    return s;
  };
  const parseVal = (): LNode => {
    ws();
    const c = text[i];
    if (c === "{") {
      const o: { [k: string]: LNode } = {};
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return o;
      }
      for (;;) {
        ws();
        const key = parseStr();
        ws();
        i++; // ':'
        o[key] = parseVal();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // '}'
        break;
      }
      return o;
    }
    if (c === "[") {
      const a: LNode[] = [];
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return a;
      }
      for (;;) {
        a.push(parseVal());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // ']'
        break;
      }
      return a;
    }
    if (c === '"') return parseStr();
    if (c === "t") {
      i += 4;
      return true;
    }
    if (c === "f") {
      i += 5;
      return false;
    }
    if (c === "n") {
      i += 4;
      return null;
    }
    const start = i;
    while (i < text.length && "+-0123456789.eE".includes(text[i]!)) i++;
    return { __num: text.slice(start, i) };
  };
  return parseVal();
}

/**
 * Canonical JSON byte-for-byte matching the directory (`federation.rs` / PHP `json_encode`):
 * recursive lexicographic key-sort, no whitespace, `/` and non-ASCII unescaped (JS
 * `JSON.stringify` already matches for strings), numbers emitted as their source literal.
 */
function canonicalJson(node: LNode): string {
  if (node === null || typeof node === "boolean" || typeof node === "string") return JSON.stringify(node);
  if (isLNum(node)) return node.__num;
  if (Array.isArray(node)) return "[" + node.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(node).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(node[k]!)).join(",") + "}";
}

/**
 * #456 --verify: cryptographically confirm this node's CREDIT_AWARD income against the
 * directory's signed event log (defends against a lying directory). Resolves the directory's
 * Ed25519 key from /.well-known/did.json and re-derives + verifies each award signature.
 * Free-tier CREDIT_ALLOCATION is unsigned by design, so it is not counted here (no cry-wolf).
 */
export async function verifyCreditAwards(
  directoryUrl: string,
  nodeId: string,
): Promise<{ sum: number; verified: number; failed: number }> {
  const origin = new URL(directoryUrl).origin; // did.json lives at the host root, not under /api
  const didResp = await fetch(`${origin}/.well-known/did.json`, { signal: AbortSignal.timeout(20000) });
  const did = (await didResp.json()) as {
    verificationMethod?: { publicKeyJwk?: { x?: string } }[];
  };
  const x = did.verificationMethod?.[0]?.publicKeyJwk?.x;
  if (!x) throw new Error("directory did.json has no Ed25519 verification key");
  const raw = Buffer.from(x, "base64url");
  if (raw.length !== 32) throw new Error(`bad Ed25519 key length ${raw.length}`);
  const pubKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });

  const base = directoryUrl.replace(/\/+$/, "");
  let sum = 0;
  let verified = 0;
  let failed = 0;
  let since = 0;
  for (;;) {
    const url = `${base}/v1/events?event_types=CREDIT_AWARD&since_seq=${since}&limit=500`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const tree = losslessParse(await resp.text()) as { [k: string]: LNode };
    const events = (tree["events"] as LNode[] | undefined) ?? [];
    if (events.length === 0) break;
    let maxSeq = since;
    for (const evRaw of events) {
      const ev = evRaw as { [k: string]: LNode };
      const seqNode = ev["seq"];
      const seq = isLNum(seqNode) ? Number(seqNode.__num) : 0;
      maxSeq = Math.max(maxSeq, seq);
      if (ev["event_type"] !== "CREDIT_AWARD" || ev["node_id"] !== nodeId) continue;
      const sig = ev["sig"];
      if (typeof sig !== "string") continue;
      const payload = ev["payload"]!;
      const payloadHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
      const eventId = typeof ev["event_id"] === "string" ? ev["event_id"] : "";
      const tsNode = ev["ts_ms"];
      const tsMs = isLNum(tsNode) ? Number(tsNode.__num) : 0;
      // #458: prev_hash (tamper-evident chain) is bound into the signing input; the directory
      // serves it per event, defaulting to GENESIS_ROOT for a genesis/legacy event.
      const prevHash = typeof ev["prev_hash"] === "string" ? ev["prev_hash"] : EVENT_LOG_GENESIS_ROOT;
      const msg = createHash("sha256")
        .update(`${eventId}:CREDIT_AWARD:${seq}:${tsMs}:${payloadHash}:${prevHash}`)
        .digest();
      const sigBuf = Buffer.from(sig, "hex");
      if (sigBuf.length === 64 && edVerify(null, msg, pubKey, sigBuf)) {
        verified++;
        const amt =
          typeof payload === "object" && payload !== null && !Array.isArray(payload)
            ? (payload as { [k: string]: LNode })["amount"]
            : undefined;
        if (amt !== undefined && isLNum(amt)) sum += Number(amt.__num);
      } else {
        failed++;
      }
    }
    if (events.length < 500 || maxSeq <= since) break;
    since = maxSeq;
  }
  return { sum, verified, failed };
}

/**
 * `iicp-node credits` (#456) — operator wallet + node ledger from the directory's
 * reconcile-checked GET /v1/credits/summary. Figures come authenticated from the
 * directory (not the local config), so editing the saved file cannot inflate them;
 * `reconciles` flags a ledger that does not add up.
 */
function printCreditsHelp(): void {
  process.stdout.write(
    `usage: iicp-node credits [options]\n\n` +
      `Show your operator wallet plus this node's credit ledger (authenticated from the directory).\n\n` +
      `options:\n` +
      `  --node NAME                Load token + node_id from ~/.iicp/nodes/<NAME>.json\n` +
      `  --node-id ID               Node id (if not using --node)\n` +
      `  --token TOKEN              Node token (env IICP_NODE_TOKEN)\n` +
      `  --directory-url URL        IICP directory base URL (defaults to saved node / env / iicp.network)\n` +
      `  --json                     Print the raw summary JSON\n` +
      `  --verify                   Cryptographically audit each award against the signed CREDIT_AWARD log\n` +
      `  -h, --help                 Show this help and exit\n\n` +
      `With no --node / --node-id and exactly one saved node (or a node named 'default'),\n` +
      `that node is used automatically.\n`,
  );
}

async function runCredits(argv: string[]): Promise<number> {
  const { values } = safeParseArgs({
    args: argv,
    options: {
      node: { type: "string" },
      "node-id": { type: "string" },
      token: { type: "string" },
      "directory-url": { type: "string" },
      json: { type: "boolean" },
      verify: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printCreditsHelp();
    return 0;
  }

  let nodeName = values["node"] as string | undefined;
  let directoryUrl = values["directory-url"] as string | undefined;
  let nodeId = values["node-id"] as string | undefined;
  let token = (values["token"] as string | undefined) ?? process.env["IICP_NODE_TOKEN"];

  // #8 — no --node / --node-id: if exactly one saved node (or a 'default' node) exists,
  // use it automatically; otherwise emit a clear error listing the saved node names.
  // If 'default' has no cached token, auto-fall-through to the single node with a token.
  if (!nodeName && !nodeId) {
    const saved = listNodes();
    if (saved.length === 1) {
      nodeName = saved[0]!.name;
    } else if (saved.length === 0) {
      process.stderr.write(
        "ERROR: no saved nodes — run `iicp-node init` / `serve` first, or pass --node-id ID.\n",
      );
      return 1;
    } else {
      const defaultNode = saved.find((n) => n.name === "default");
      if (defaultNode) {
        if (defaultNode.node_token) {
          nodeName = "default";
        } else {
          const withToken = saved.filter((n) => n.node_token);
          if (withToken.length === 1) {
            process.stderr.write(
              `[iicp-node] '${defaultNode.name}' has no cached token — using '${withToken[0]!.name}' instead\n`,
            );
            nodeName = withToken[0]!.name;
          } else if (withToken.length > 1) {
            // Multiple nodes have tokens — show all of them.
            const dir =
              directoryUrl ?? process.env["IICP_DIRECTORY_URL"] ?? "https://iicp.network/api";
            process.stderr.write(
              `[iicp-node] no --node given — showing credits for all ${withToken.length} nodes:\n`,
            );
            // One node failing must not hide the others — show every node,
            // then exit non-zero if any failed (2026-06-11).
            let failed = 0;
            const walletState = { shown: false };
            for (let i = 0; i < withToken.length; i++) {
              if (i > 0) process.stdout.write("\n");
              const n = withToken[i]!;
              const rc = await fetchAndDisplayCredits(
                n.directory_url ?? dir, n.node_id, n.node_token!, n.name,
                Boolean(values["json"]), Boolean(values["verify"]), walletState,
              );
              if (rc !== 0) {
                process.stderr.write(
                  `ERROR: credits fetch failed for node '${n.name}' — continuing with remaining nodes\n`,
                );
                failed++;
              }
            }
            if (failed > 0) {
              process.stderr.write(`ERROR: ${failed}/${withToken.length} node(s) failed\n`);
              return 1;
            }
            return 0;
          } else {
            nodeName = "default"; // no tokens anywhere; "run serve" fires below
          }
        }
      } else {
        process.stderr.write(
          `ERROR: multiple saved nodes — pass --node NAME (one of: ${saved.map((n) => n.name).join(", ")}) or --node-id ID.\n`,
        );
        return 1;
      }
    }
  }

  if (nodeName) {
    const saved = loadNode(nodeName);
    if (!saved) {
      process.stderr.write(
        `ERROR: no saved config at ~/.iicp/nodes/${nodeName}.json — run \`iicp-node init\` / \`serve\` first.\n`,
      );
      return 1;
    }
    directoryUrl = directoryUrl ?? saved.directory_url;
    nodeId = nodeId ?? saved.node_id;
    token = token ?? saved.node_token;
  }
  directoryUrl = directoryUrl ?? process.env["IICP_DIRECTORY_URL"] ?? "https://iicp.network/api";
  if (!nodeId) {
    process.stderr.write("ERROR: node_id required (use --node NAME or --node-id ID)\n");
    return 1;
  }
  if (!token) {
    process.stderr.write(
      "ERROR: no node_token — run `iicp-node serve` once (it caches the token), or pass --token / $IICP_NODE_TOKEN\n",
    );
    return 1;
  }

  const label = nodeName ?? nodeId;
  return fetchAndDisplayCredits(directoryUrl, nodeId, token, label, Boolean(values["json"]), Boolean(values["verify"]));
}

/** Shared fetch+display logic for one node's credits summary. */
async function fetchAndDisplayCredits(
  directoryUrl: string,
  nodeId: string,
  token: string,
  label: string,
  asJson: boolean,
  verify: boolean,
  walletState?: { shown: boolean },
): Promise<number> {
  const url = `${directoryUrl.replace(/\/+$/, "")}/v1/credits/summary?node_id=${encodeURIComponent(nodeId)}`;
  // Transient failures (network error, 5xx, undecodable body) get ONE retry
  // after a short pause — shared-hosting blips and deploy windows otherwise
  // surface as one-shot CLI errors (observed 2026-06-11).
  let resp: Response | undefined;
  let body: Record<string, unknown> | undefined;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    resp = undefined;
    body = undefined;
    try {
      resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      lastErr = `request failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (resp) {
      try {
        body = (await resp.json()) as Record<string, unknown>;
      } catch {
        lastErr = `bad response (HTTP ${resp.status})`;
      }
      if (body !== undefined && resp.status < 500) break; // success or definitive 4xx
      if (body !== undefined) {
        const err = body["error"] as { message?: string } | undefined;
        lastErr = `HTTP ${resp.status}: ${err?.message ?? "request rejected"}`;
      }
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!resp || body === undefined || resp.status >= 500) {
    process.stderr.write(`ERROR: ${lastErr}\n`);
    return 1;
  }
  if (!resp.ok) {
    const err = body["error"] as { message?: string } | undefined;
    process.stderr.write(`ERROR: HTTP ${resp.status}: ${err?.message ?? "request rejected"}\n`);
    return 1;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return 0;
  }

  const earned = Number(body["total_earned"] ?? 0);
  const spent = Number(body["total_spent"] ?? 0);
  const balance = Number(body["balance"] ?? 0);
  const tx = Number(body["tx_count"] ?? 0);
  const reconciles = Boolean(body["reconciles"]);
  const tpc = Number(body["tokens_per_credit"] ?? 1000);
  const pad = (n: number): string => n.toFixed(3).padStart(12);
  const check = reconciles ? "✓ reconciles" : "✗ DOES NOT RECONCILE";
  const wallet = body["operator_wallet"] as Record<string, unknown> | null | undefined;
  if (wallet && typeof wallet === "object") {
    const showWallet = !walletState?.shown;
    const fingerprint = typeof wallet["operator_fingerprint"] === "string" ? ` · operator ${wallet["operator_fingerprint"]}` : "";
    const walletBalance = Number(wallet["total_balance"] ?? balance);
    const walletNodes = Number(wallet["node_count"] ?? 0);
    if (showWallet) {
      process.stdout.write(`IICP operator wallet${fingerprint}\n`);
      if (wallet["total_earned"] !== undefined) process.stdout.write(`  Total earned     ${pad(Number(wallet["total_earned"] ?? 0))}\n`);
      if (wallet["total_spent"] !== undefined) process.stdout.write(`  Total spent      ${pad(Number(wallet["total_spent"] ?? 0))}\n`);
      process.stdout.write("  ─────────────────────────────\n");
      const wr = wallet["reconciles"];
      const walletCheck = wr === true ? "✓ reconciles" : wr === false ? "✗ DOES NOT RECONCILE" : "rollup";
      process.stdout.write(`  Wallet balance   ${pad(walletBalance)}   ${walletCheck}   (≈ ${Math.trunc(walletBalance * tpc)} tokens)\n`);
      process.stdout.write(`  ${walletNodes} linked node(s) · per-node audit below\n\n`);
      if (walletState) walletState.shown = true;
    }
    process.stdout.write(`Node ledger — ${label}\n`);
  } else {
    process.stdout.write(`IICP credits — ${label}\n`);
    process.stdout.write("  Node-local ledger  bind an operator identity to combine nodes\n");
  }
  process.stdout.write(`  Earned (income) ${pad(earned)}\n`);
  process.stdout.write(`  Spent           ${pad(spent)}\n`);
  process.stdout.write("  ─────────────────────────────\n");
  process.stdout.write(`  Balance         ${pad(balance)}   ${check}   (≈ ${Math.trunc(balance * tpc)} tokens)\n`);
  process.stdout.write(`  ${tx} transactions · \`iicp-node credits --json\` for raw\n`);
  if (!reconciles) {
    process.stderr.write(
      "[iicp-node] WARNING: balance != earned − spent — the ledger does not reconcile; do not trust these figures.\n",
    );
  }
  if (verify) {
    process.stdout.write("  ── cryptographic verification (signed CREDIT_AWARD log) ──\n");
    let v: { sum: number; verified: number; failed: number };
    try {
      v = await verifyCreditAwards(directoryUrl, nodeId);
    } catch (e) {
      process.stderr.write(`[iicp-node] --verify failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    if (v.failed > 0) {
      process.stderr.write(
        `[iicp-node] ✗ ${v.failed} award event(s) FAILED Ed25519 verification — ` +
          "tampered or inconsistent event log. Do NOT trust these figures.\n",
      );
      return 1;
    }
    process.stdout.write(
      `  ✓ ${v.verified} award(s) cryptographically verified · ${v.sum.toFixed(3)} credits ` +
        "(Ed25519, signed by the directory)\n",
    );
    const freeTier = earned - v.sum;
    if (freeTier > 0.0001) {
      process.stdout.write(
        `  · ${freeTier.toFixed(3)} credits are free-tier allocation ` +
          "(directory-granted, not signed task awards)\n",
      );
    }
  }
  return 0;
}

function printDoctorHelp(): void {
  process.stdout.write(
    `usage: iicp-node doctor [options]\n\n` +
      `Check local health, directory presence, and deterministic recovery action.\n\n` +
      `options:\n` +
      `  --node NAME                Load saved node config (~/.iicp/nodes/<NAME>.json)\n` +
      `  --directory-url URL        Override the saved IICP directory base URL\n` +
      `  --json                     Print machine-readable recovery state\n` +
      `  -h, --help                 Show this help and exit\n`,
  );
}

function doctorLoopbackHost(host: string): string {
  const h = (host || "").trim();
  if (h === "" || h === "::" || h === "0.0.0.0") return "127.0.0.1";
  return h;
}

function doctorUrl(host: string, port: number): string {
  const h = doctorLoopbackHost(host);
  return h.includes(":") && !h.startsWith("[")
    ? `http://[${h}]:${port}/iicp/health`
    : `http://${h}:${port}/iicp/health`;
}

async function runDoctor(argv: string[]): Promise<number> {
  const { values } = safeParseArgs({
    args: argv,
    options: {
      node: { type: "string" },
      "directory-url": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printDoctorHelp();
    return 0;
  }
  const nodeName = (values.node as string | undefined) ?? process.env.IICP_NODE_NAME ?? "default";
  const saved = loadNode(nodeName);
  if (!saved) {
    process.stderr.write(`ERROR: no saved config at ~/.iicp/nodes/${nodeName}.json — run \`iicp-node init\` first.\n`);
    return 1;
  }
  const directoryUrl =
    (values["directory-url"] as string | undefined) ?? saved.directory_url ?? process.env.IICP_DIRECTORY_URL ?? "https://iicp.network/api";
  const localHealthUrl = doctorUrl(saved.host ?? "0.0.0.0", saved.port ?? 8020);
  let localHealthOk = false;
  let health: Record<string, unknown> | null = null;
  let healthError: string | null = null;
  try {
    const resp = await fetch(localHealthUrl, { signal: AbortSignal.timeout(2_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    health = (await resp.json()) as Record<string, unknown>;
    localHealthOk = true;
  } catch (err) {
    healthError = err instanceof Error ? err.message : String(err);
  }
  const presence = await registryNodePresence(directoryUrl, saved.node_id, 5_000);
  let savedCredentialStatus: "ok" | "stale_or_invalid" | "missing_token" | "error" = saved.node_token ? "error" : "missing_token";
  if (saved.node_token) {
    try {
      const resp = await fetch(`${directoryUrl.replace(/\/+$/, "")}/v1/credits/summary?node_id=${encodeURIComponent(saved.node_id)}`, {
        headers: { Authorization: `Bearer ${saved.node_token}` },
        signal: AbortSignal.timeout(5_000),
      });
      savedCredentialStatus = resp.status === 401 ? "stale_or_invalid" : resp.ok ? "ok" : "error";
    } catch {
      savedCredentialStatus = "error";
    }
  }
  const stability = (health?.["backend_stability"] ?? {}) as Record<string, unknown>;
  const backendState = String(stability["backend_state"] ?? "unknown");
  const backendReason = String(stability["reason_class"] ?? "unknown");
  const backendAttention = backendState === "draining";
  const failures = !localHealthOk || presence === "absent" ? 1 : 0;
  const { state, action } = classifyRecovery({
    localHealthOk,
    publicAvailable: localHealthOk,
    directoryPresence: presence,
    consecutiveFailures: failures,
    graceChecks: envGraceChecks(),
    backendAttention,
  });
  const prefix = nodeRegistryPrefix(saved.node_id);
  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          node: saved.name,
          node_id: saved.node_id,
          prefix,
          directory_url: directoryUrl,
          local_health_url: localHealthUrl,
          local_health_ok: localHealthOk,
          local_health_error: healthError,
          directory_presence: presence,
          saved_credential_status: savedCredentialStatus,
          recovery_state: state,
          recommended_action: action,
          health,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  process.stdout.write(`IICP node doctor — ${saved.name}\n`);
  process.stdout.write(`  Local health            ${localHealthOk ? "ok" : "failed"} (${localHealthUrl})\n`);
  if (healthError) process.stdout.write(`  Local health detail     ${healthError}\n`);
  process.stdout.write(`  Directory prefix        ${prefix}\n`);
  process.stdout.write(`  Directory presence      ${presence}\n`);
  process.stdout.write(`  Saved credential        ${savedCredentialStatus}\n`);
  if (savedCredentialStatus === "stale_or_invalid") {
    process.stdout.write("  Credential detail       saved node token is stale; serving may be healthy while credits fail\n");
  }
  process.stdout.write(`  Backend stability       ${backendState} / ${backendReason}\n`);
  if (backendReason === "backend_cold") {
    process.stdout.write("  Backend detail          idle/cold backend; normally warms on first request, not restart-worthy by itself\n");
  }
  process.stdout.write(`  Recovery state          ${state}\n`);
  process.stdout.write(`  Recommended action      ${action}\n`);
  process.stdout.write("  Note                    restart is automatic only when supervised services set IICP_SUPERVISED=1\n");
  return 0;
}

/**
 * Resolve a passphrase: $IICP_OPERATOR_PASSPHRASE if set (headless/CI), else an interactive
 * readline prompt (this command is operator-run, so a prompt is fine here — only `serve` must
 * stay non-interactive). For `confirm`, the prompt is asked twice and must match.
 */
async function operatorPassphrase(prompt: string, confirm: boolean): Promise<string | null> {
  const env = process.env["IICP_OPERATOR_PASSPHRASE"];
  if (env) return env;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pw = (await rl.question(prompt)).trim();
    if (confirm && pw !== (await rl.question("Confirm passphrase: ")).trim()) {
      process.stderr.write("ERROR: passphrases do not match.\n");
      return null;
    }
    return pw || null;
  } finally {
    rl.close();
  }
}

/** `iicp-node operator encrypt` (#460) — seal the operator secret at rest under a passphrase. */
async function runOperatorEncrypt(): Promise<number> {
  const op = loadOperator();
  if (!op) {
    process.stderr.write("ERROR: no operator identity — run `iicp-node init` first.\n");
    return 1;
  }
  if (operatorIsEncrypted(op)) {
    process.stdout.write("Operator secret is already encrypted at rest.\n");
    return 0;
  }
  if (!operatorIsKeyBacked(op)) {
    process.stderr.write("ERROR: legacy keyless operator identity has nothing to encrypt (#464).\n");
    return 1;
  }
  const pw = await operatorPassphrase("New operator passphrase: ", true);
  if (!pw) {
    process.stderr.write("ERROR: a non-empty passphrase is required.\n");
    return 1;
  }
  saveOperator(operatorEncryptAtRest(op, pw));
  process.stdout.write(
    "Operator secret encrypted at rest (AES-256-GCM / PBKDF2). Set $IICP_OPERATOR_PASSPHRASE " +
      "to unlock it headlessly during `serve`.\n",
  );
  return 0;
}

/** `iicp-node operator decrypt` (#460) — restore the plaintext secret at rest. */
async function runOperatorDecrypt(): Promise<number> {
  const op = loadOperator();
  if (!op) {
    process.stderr.write("ERROR: no operator identity — run `iicp-node init` first.\n");
    return 1;
  }
  if (!operatorIsEncrypted(op)) {
    process.stdout.write("Operator secret is already stored in plaintext.\n");
    return 0;
  }
  const pw = await operatorPassphrase("Operator passphrase: ", false);
  if (!pw) {
    process.stderr.write("ERROR: a passphrase is required to decrypt.\n");
    return 1;
  }
  try {
    saveOperator(operatorDecryptAtRest(op, pw));
  } catch (e) {
    process.stderr.write(`ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  process.stdout.write("Operator secret decrypted (now stored in plaintext at rest).\n");
  return 0;
}

/**
 * `iicp-node operator rename <name>` (#460) — change the public, mutable display_name over
 * the immutable operator_id. The operator signs the canonical rename bytes with their own
 * key, so the directory authenticates the change by signature alone (no node token); one
 * signed call updates the single operator record, reflected on every node + the leaderboard.
 * Updates the local operator.json on success. Never sends the secret/contact.
 */
function printOperatorHelp(): void {
  process.stdout.write(
    `usage: iicp-node operator <subcommand> [options]\n\n` +
      `Manage your operator identity.\n\n` +
      `subcommands:\n` +
      `  rename <name>              Change your public display_name (signed by your operator key)\n` +
      `  key <rotate|revoke>         Safely migrate or revoke your cryptographic operator key\n` +
      `  dsr <action>               Export, restrict, or anonymize your directory records\n` +
      `  encrypt                    Password-encrypt the operator secret at rest ($IICP_OPERATOR_PASSPHRASE)\n` +
      `  decrypt                    Remove at-rest encryption of the operator secret\n\n` +
      `operator rename options:\n` +
      `  --directory-url URL        IICP directory base URL (defaults to env / iicp.network)\n` +
      `  -h, --help                 Show this help and exit\n`,
  );
}

async function runOperatorDsr(argv: string[]): Promise<number> {
  const { values, positionals } = safeParseArgs({
    args: argv,
    options: {
      "directory-url": { type: "string" },
      "tracking-id": { type: "string" },
      output: { type: "string" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(
      "usage: iicp-node operator dsr <export|restrict|anonymize> [options]\n\n" +
        "The local operator key signs a one-use directory challenge. It never enters the browser or request body.\n\n" +
        "  --output FILE             Required for export; creates a new mode-0600 local file\n" +
        "  --yes                     Confirm restrict or anonymize after the retained-record notice\n" +
        "  --tracking-id ID          Optional local reference\n" +
        "  --directory-url URL       IICP directory base URL\n",
    );
    return 0;
  }
  const action = positionals[0];
  if (action !== "export" && action !== "restrict" && action !== "anonymize") {
    process.stderr.write("ERROR: usage: iicp-node operator dsr <export|restrict|anonymize> [options]\n");
    return 2;
  }
  const outputPath = values.output as string | undefined;
  if (action === "export" && !outputPath) {
    process.stderr.write("ERROR: export requires --output <new-file>; it is not printed to the terminal.\n");
    return 2;
  }
  if (outputPath && fs.existsSync(outputPath)) {
    process.stderr.write("ERROR: --output already exists; choose a new path to avoid replacing an export.\n");
    return 2;
  }
  if (action !== "export") {
    process.stderr.write(
      "This action restricts or anonymizes directory records. Minimal signed ledger, security and accounting records may be retained and are explained in the receipt.\n",
    );
    if (!values.yes) {
      process.stderr.write("Re-run with --yes to confirm.\n");
      return 2;
    }
  }
  const op = loadOperator();
  if (!op) {
    process.stderr.write("ERROR: no operator identity — run `iicp-node init` first.\n");
    return 1;
  }
  if (!operatorIsKeyBacked(op)) {
    process.stderr.write("ERROR: this legacy operator identity cannot sign a rights request; regenerate a key-backed identity.\n");
    return 1;
  }
  const directoryUrl =
    (values["directory-url"] as string | undefined) ?? process.env["IICP_DIRECTORY_URL"] ?? "https://iicp.network/api";
  const base = `${directoryUrl.replace(/\/+$/, "")}/v1/operator`;
  let response: Response;
  try {
    const challenge = await fetch(`${base}/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operator_pub: op.operator_id }),
      signal: AbortSignal.timeout(15000),
    });
    const challengeBody = (await challenge.json()) as { nonce?: unknown; error?: { message?: string } };
    if (!challenge.ok || typeof challengeBody.nonce !== "string") {
      throw new Error(challengeBody.error?.message ?? "directory challenge was incomplete");
    }
    const payload: Record<string, unknown> = {
      operator_pub: op.operator_id,
      nonce: challengeBody.nonce,
      ts: Math.floor(Date.now() / 1000),
      tracking_id: (values["tracking-id"] as string | undefined) ?? `dsr-${randomUUID()}`,
    };
    if (action !== "export") payload.confirm = true;
    payload.sig = signOperatorSelfService(operatorSigningKey(op), `dsr_${action}`, payload);
    response = await fetch(`${base}/dsr/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    process.stderr.write(`ERROR: rights request failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!response.ok) {
    const err = body.error as { message?: string } | undefined;
    process.stderr.write(`ERROR: directory rejected rights request: ${err?.message ?? response.status}\n`);
    return 1;
  }
  if (action === "export" && outputPath) {
    try {
      fs.writeFileSync(outputPath, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.chmodSync(outputPath, 0o600);
    } catch (err) {
      process.stderr.write(`ERROR: unable to save export safely: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    process.stdout.write(`Saved redacted directory export to ${outputPath} (mode 0600).\n`);
  } else {
    process.stdout.write(`Directory ${action} request completed.\n`);
  }
  if (typeof body.tracking_id === "string") process.stdout.write(`Receipt reference: ${body.tracking_id}\n`);
  const retention = body.retention_notice ?? body.retention_reason;
  if (typeof retention === "string") process.stdout.write(`Retained records: ${retention}\n`);
  return 0;
}

function operatorArtifactPath(kind: string): string {
  return path.join(configDir(), `operator-${kind}-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}.json`);
}

function writePrivateJsonNew(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writeOperatorHandoffMarker(nodeNames: string[]): string {
  const stamp = Math.floor(Date.now() / 1000);
  const marker = path.join(configDir(), `operator-handoff-pending-${stamp}.json`);
  writePrivateJsonNew(marker, {
    schema: "iicp.operator-handoff.v1",
    action: "rotate",
    created_at_unix: stamp,
    grace_seconds: 300,
    affected_node_names: nodeNames,
    restart_requested_node_names: [],
    completed_node_names: [],
  });
  return marker;
}

type HandoffMarker = {
  affected_node_names?: unknown;
  restart_requested_node_names?: unknown;
  completed_node_names?: unknown;
  created_at_unix?: unknown;
  grace_seconds?: unknown;
};

function handoffMarkerPaths(): string[] {
  try {
    return fs.readdirSync(configDir())
      .filter((name) => /^operator-handoff-pending-.*\.json$/.test(name))
      .map((name) => path.join(configDir(), name));
  } catch { return []; }
}

function readHandoffMarker(file: string): HandoffMarker | null {
  try {
    const body: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return body && typeof body === "object" ? body as HandoffMarker : null;
  } catch { return null; }
}

/** Return remaining grace seconds; completed/restarted services never restart twice. */
export function handoffRestartDelay(marker: HandoffMarker, nodeName: string, now: number): number | null {
  const names = (field: keyof HandoffMarker): Set<string> =>
    new Set(Array.isArray(marker[field]) ? marker[field].filter((value): value is string => typeof value === "string") : []);
  const affected = names("affected_node_names");
  const requested = names("restart_requested_node_names");
  const completed = names("completed_node_names");
  if (!affected.has(nodeName) || requested.has(nodeName) || completed.has(nodeName)) return null;
  const created = marker.created_at_unix;
  const grace = marker.grace_seconds;
  if (typeof created !== "number") return null;
  return Math.max(0, created + (typeof grace === "number" && grace >= 0 ? grace : 300) - now);
}

export function completeHandoffForNode(nodeName: string): void {
  for (const file of handoffMarkerPaths()) {
    const marker = readHandoffMarker(file);
    if (!marker || !Array.isArray(marker.affected_node_names) || !marker.affected_node_names.includes(nodeName)) continue;
    // A rotation can be written while this process is still completing its
    // initial registration. Only the successor that claimed a supervised
    // restart may complete the marker; do not erase an unclaimed handoff.
    const requested = new Set((marker.restart_requested_node_names as string[] | undefined) ?? []);
    if (!requested.has(nodeName)) continue;
    const affected = new Set((marker.affected_node_names as string[] | undefined) ?? []);
    const completed = new Set((marker.completed_node_names as string[] | undefined) ?? []);
    completed.add(nodeName);
    try {
      if ([...affected].every((name) => completed.has(name))) fs.unlinkSync(file);
      else fs.writeFileSync(file, `${JSON.stringify({ ...marker, completed_node_names: [...completed] }, null, 2)}\n`, { mode: 0o600 });
    } catch { /* best effort only */ }
  }
}

function scheduleSupervisedHandoffRestart(nodeName: string | undefined): NodeJS.Timeout | null {
  if (!nodeName || !envBool("IICP_SUPERVISED")) return null;
  let checking = false;
  const check = (): void => {
    if (checking) return;
    checking = true;
    try {
      for (const file of handoffMarkerPaths()) {
        const marker = readHandoffMarker(file);
        if (!marker || handoffRestartDelay(marker, nodeName, Math.floor(Date.now() / 1000)) !== 0) continue;
        const requested = new Set((marker.restart_requested_node_names as string[] | undefined) ?? []);
        requested.add(nodeName);
        try {
          fs.writeFileSync(file, `${JSON.stringify({ ...marker, restart_requested_node_names: [...requested] }, null, 2)}\n`, { mode: 0o600 });
          console.error(`[iicp-node] operator handoff grace period complete — exiting with code ${TUNNEL_DEAD_EXIT_CODE} so the supervisor reloads the successor identity.`);
          process.exit(TUNNEL_DEAD_EXIT_CODE);
        } catch { /* retry on the next monitor pass */ }
      }
    } finally {
      checking = false;
    }
  };
  // The marker is written by a separate `operator key rotate` invocation,
  // so it can appear after `serve` has already started. Re-check redacted
  // local state rather than assuming startup saw every future handoff.
  check();
  return setInterval(check, 15_000);
}

async function runOperatorKey(argv: string[]): Promise<number> {
  const { values, positionals } = safeParseArgs({
    args: argv,
    options: { "directory-url": { type: "string" }, yes: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write("usage: iicp-node operator key <rotate|revoke> --yes [--directory-url URL]\n");
    return 0;
  }
  const action = positionals[0];
  if (action !== "rotate" && action !== "revoke") return 2;
  if (!values.yes) {
    process.stderr.write("This changes the cryptographic operator identity used by saved nodes. Re-run with --yes.\n");
    return 2;
  }
  const stored = loadOperator();
  if (!stored || !operatorIsKeyBacked(stored)) {
    process.stderr.write("ERROR: a key-backed local operator identity is required.\n");
    return 1;
  }
  const unlock = operatorIsEncrypted(stored) ? await operatorPassphrase("Operator passphrase: ", false) : undefined;
  let old;
  try { old = operatorIsEncrypted(stored) ? operatorDecryptAtRest(stored, unlock ?? "") : stored; }
  catch (e) { process.stderr.write(`ERROR: ${e instanceof Error ? e.message : String(e)}\n`); return 1; }
  let successor: typeof old | undefined;
  let backupPath: string | undefined;
  try {
    if (action === "rotate") {
      const backupPw = unlock ?? process.env["IICP_OPERATOR_BACKUP_PASSPHRASE"] ?? await operatorPassphrase("New backup passphrase: ", true);
      if (!backupPw) return 1;
      backupPath = operatorArtifactPath("before-rotation");
      writePrivateJsonNew(backupPath, operatorEncryptAtRest(old, backupPw));
      successor = generateOperator({ display_name: old.display_name, contact: old.contact });
    }
    const directoryUrl = (values["directory-url"] as string | undefined) ?? process.env["IICP_DIRECTORY_URL"] ?? "https://iicp.network/api";
    const base = `${directoryUrl.replace(/\/+$/, "")}/v1/operator`;
    const challenge = await fetch(`${base}/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operator_pub: old.operator_id }), signal: AbortSignal.timeout(15000) });
    const challengeBody = await challenge.json() as { nonce?: unknown; error?: { message?: string } };
    if (!challenge.ok || typeof challengeBody.nonce !== "string") throw new Error(challengeBody.error?.message ?? "directory challenge was incomplete");
    const ts = Math.floor(Date.now() / 1000);
    let payload: Record<string, unknown>;
    let response: Response;
    if (action === "rotate") {
      if (!successor) throw new Error("successor identity missing");
      payload = { operator_pub: old.operator_id, new_operator_pub: successor.operator_id, nonce: challengeBody.nonce, ts, reason_class: "operator_rotation" };
      payload.sig = signOperatorSelfService(operatorSigningKey(old), "key_rotate", payload);
      payload.new_key_sig = signOperatorSelfService(operatorSigningKey(successor), "key_rotate_successor", { operator_pub: old.operator_id, new_operator_pub: successor.operator_id, nonce: challengeBody.nonce, ts, rotation_epoch: null });
      response = await fetch(`${base}/key/rotate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    } else {
      payload = { operator_pub: old.operator_id, nonce: challengeBody.nonce, ts, confirm: true, reason_class: "operator_request" };
      payload.sig = signOperatorSelfService(operatorSigningKey(old), "key_revoke", payload);
      response = await fetch(`${base}/key/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    }
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error((body.error as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`);
    const receiptPath = operatorArtifactPath(`${action}-receipt`);
    writePrivateJsonNew(receiptPath, { schema: "iicp.operator-key-receipt.v1", action, status: body.status, operator_fingerprint: body.operator_fingerprint, linked_nodes: body.linked_nodes, receipt_id_prefix: body.receipt_id_prefix });
    if (action === "rotate" && successor) {
      saveOperator(successor);
      let migrated = 0;
      const nodeNames: string[] = [];
      for (const node of listNodes()) if (node.operator_id === old.operator_id) { node.operator_id = successor.operator_id; nodeNames.push(node.name); saveNode(node); migrated += 1; }
      const handoffPath = writeOperatorHandoffMarker(nodeNames);
      process.stdout.write(`Operator identity migrated; ${migrated} saved node(s) will re-register with the new key.\nEncrypted old-key backup: ${backupPath}\nRedacted receipt: ${receiptPath}\nSupervised handoff marker: ${handoffPath} (one restart pass after 5 minutes).\n`);
    } else process.stdout.write(`Operator identity revoked; redacted receipt: ${receiptPath}\n`);
    return 0;
  } catch (e) {
    if (backupPath) { try { fs.unlinkSync(backupPath); } catch {} }
    process.stderr.write(`ERROR: operator key ${action} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function printOperatorEncryptHelp(): void {
  process.stdout.write(
    `usage: iicp-node operator encrypt\n\n` +
      `Password-encrypt the operator secret at rest. The command prompts for a passphrase\n` +
      `unless $IICP_OPERATOR_PASSPHRASE is set for headless use.\n\n` +
      `Options:\n` +
      `  -h, --help                 Show this help and exit without prompting\n`,
  );
}

function printOperatorDecryptHelp(): void {
  process.stdout.write(
    `usage: iicp-node operator decrypt\n\n` +
      `Remove at-rest encryption and store the operator secret in plaintext again. The\n` +
      `command prompts for the passphrase unless $IICP_OPERATOR_PASSPHRASE is set.\n\n` +
      `Options:\n` +
      `  -h, --help                 Show this help and exit without prompting\n`,
  );
}

async function runOperator(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    printOperatorHelp();
    return sub === undefined ? 2 : 0;
  }
  if (sub === "encrypt") {
    const rest = argv.slice(1);
    if (argsHaveHelp(rest)) {
      printOperatorEncryptHelp();
      return 0;
    }
    if (rest.length > 0) throw new CliError(`unknown operator encrypt option '${rest[0]}'`);
    return runOperatorEncrypt();
  }
  if (sub === "decrypt") {
    const rest = argv.slice(1);
    if (argsHaveHelp(rest)) {
      printOperatorDecryptHelp();
      return 0;
    }
    if (rest.length > 0) throw new CliError(`unknown operator decrypt option '${rest[0]}'`);
    return runOperatorDecrypt();
  }
  if (sub === "dsr") return runOperatorDsr(argv.slice(1));
  if (sub === "key") return runOperatorKey(argv.slice(1));
  if (sub !== "rename") {
    process.stderr.write(`unknown operator subcommand: ${sub}\n`);
    printOperatorHelp();
    return 2;
  }
  const { values, positionals } = safeParseArgs({
    args: argv.slice(1),
    options: {
      "directory-url": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    printOperatorHelp();
    return 0;
  }
  const name = positionals[0];
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    process.stderr.write("ERROR: display name must be 1-64 chars with no control characters.\n");
    return 1;
  }
  const op = loadOperator();
  if (!op) {
    process.stderr.write("ERROR: no operator identity — run `iicp-node init` first.\n");
    return 1;
  }
  if (!operatorIsKeyBacked(op)) {
    process.stderr.write(
      "ERROR: legacy keyless operator identity (operator_id is a UUID, not a key) — " +
        "cannot sign a rename. Regenerate with a key-backed identity (#464).\n",
    );
    return 1;
  }

  const directoryUrl =
    (values["directory-url"] as string | undefined) ??
    process.env["IICP_DIRECTORY_URL"] ??
    "https://iicp.network/api";
  const ts = Math.floor(Date.now() / 1000);
  const sig = signRename(operatorSigningKey(op), name, op.operator_id, ts);
  const url = `${directoryUrl.replace(/\/+$/, "")}/v1/operator/rename`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operator_pub: op.operator_id, display_name: name, ts, sig }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    process.stderr.write(`ERROR: request failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  let body: Record<string, unknown>;
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!resp.ok) {
    const err = body["error"] as { message?: string } | undefined;
    process.stderr.write(`ERROR: HTTP ${resp.status}: ${err?.message ?? "request rejected"}\n`);
    return 1;
  }

  // Persist the new name locally so the next `serve` re-asserts it at register.
  op.display_name = (body["display_name"] as string | undefined) ?? name;
  saveOperator(op);
  process.stdout.write(`Renamed operator display_name to ${JSON.stringify(op.display_name)}.\n`);
  return 0;
}

// ── proxy (ADR-050) — local compat gateway; consumer, loopback, no registration ──
function printProxyHelp(): void {
  process.stdout.write(
    `usage: iicp-node proxy [options]\n\n` +
      `Run the local OpenAI/Ollama/Anthropic-compat gateway (consumer; loopback;\n` +
      `does NOT register with the directory).\n\n` +
      `options:\n` +
      `  --port N                   Listen port (env IICP_PROXY_PORT, default 9483)\n` +
      `  --host HOST                Bind host (env IICP_PROXY_HOST, default 127.0.0.1 — loopback)\n` +
      `  --directory-url URL        IICP_DIRECTORY_URL (default https://iicp.network/api)\n` +
      `  --region REGION            Preferred region (env IICP_PROXY_PREFERRED_REGION)\n` +
      `  --token TOKEN              Node token (env IICP_NODE_TOKEN)\n` +
      `  -h, --help                 Show this help and exit\n`,
  );
}

async function runProxyCmd(argv: string[]): Promise<number> {
  const { values } = safeParseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      "directory-url": { type: "string" },
      region: { type: "string" },
      token: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    printProxyHelp();
    return 0;
  }
  const port =
    values.port !== undefined
      ? parsePort(values.port as string, 9483)
      : parsePort(process.env["IICP_PROXY_PORT"], 9483);
  const host = (values.host as string | undefined) ?? envOr("IICP_PROXY_HOST", "127.0.0.1")!;
  return runProxy({
    host,
    port,
    directoryUrl:
      (values["directory-url"] as string | undefined) ?? envOr("IICP_DIRECTORY_URL", "https://iicp.network/api")!,
    region: (values.region as string | undefined) ?? envOr("IICP_PROXY_PREFERRED_REGION"),
    token: (values.token as string | undefined) ?? envOr("IICP_NODE_TOKEN"),
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printHelp();
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`iicp-node ${SDK_VERSION}\n`);
    return 0;
  }

  try {
    return await dispatch(argv);
  } catch (exc) {
    if (exc instanceof CliError) {
      process.stderr.write(`ERROR: ${exc.message}\n`);
      return 2;
    }
    throw exc;
  }
}

// ── mcp-gateway (#512) ───────────────────────────────────────────────────────

function _toolToIntent(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return `urn:iicp:intent:mcp:${safe}:v1`;
}

async function runMcpGateway(argv: string[]): Promise<number> {
  const helpFlag = argv.includes("--help") || argv.includes("-h");
  if (helpFlag) {
    process.stdout.write(
      `usage: iicp-node mcp-gateway [options]\n\n` +
        `Bridge a local MCP server into the IICP mesh as a registered provider node.\n\n` +
        `Options:\n` +
        `  --mcp-url URL        IICP_MCP_URL — MCP server base URL (default http://localhost:8001)\n` +
        `  --tools NAMES        IICP_MCP_TOOLS — comma-separated tool names to advertise (required)\n` +
        `  --node-id ID         IICP_NODE_ID — auto-generated if absent\n` +
        `  --public-endpoint U  IICP_PUBLIC_ENDPOINT — externally reachable URL of this gateway\n` +
        `  --directory-url URL  IICP_DIRECTORY_URL (default https://iicp.network/api/v1)\n` +
        `  --region REGION      IICP_REGION (default local)\n` +
        `  --port N             IICP_PORT (default 9484)\n` +
        `  --host HOST          IICP_HOST (default ::)\n` +
        `  --allow-dangerous-tools  IICP_MCP_ALLOW_DANGEROUS_TOOLS (requires all controls below)\n` +
        `  --authz-policy ID    IICP_MCP_AUTHZ_POLICY\n` +
        `  --sandbox PROFILE    IICP_MCP_SANDBOX (strict/container/sandbox)\n` +
        `  --audit-redaction    IICP_MCP_AUDIT_REDACTION\n` +
        `  --mcp-revision REV   IICP_MCP_REVISION (legacy default; 2026-07-28 is opt-in)\n` +
        `  --mcp-server-name N  IICP_MCP_SERVER_NAME (required for modern MCP)\n` +
        `  --mcp-extensions X   IICP_MCP_EXTENSIONS (tasks,skills,apps)\n`,
    );
    return 0;
  }

  const { values } = safeParseArgs({
    args: argv,
    options: {
      "mcp-url": { type: "string" },
      tools: { type: "string" },
      "node-id": { type: "string" },
      "public-endpoint": { type: "string" },
      "directory-url": { type: "string" },
      region: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "allow-dangerous-tools": { type: "boolean" },
      "authz-policy": { type: "string" },
      sandbox: { type: "string" },
      "audit-redaction": { type: "boolean" },
      "mcp-revision": { type: "string" },
      "mcp-server-name": { type: "string" },
      "mcp-extensions": { type: "string" },
    },
    allowPositionals: false,
  });

  const mcpUrl = ((values["mcp-url"] as string | undefined) ?? envOr("IICP_MCP_URL") ?? "http://localhost:8001").replace(/\/$/, "");
  const mcpRevision = (values["mcp-revision"] as string | undefined) ?? envOr("IICP_MCP_REVISION") ?? LEGACY_MCP_REVISION;
  const mcpServerName = ((values["mcp-server-name"] as string | undefined) ?? envOr("IICP_MCP_SERVER_NAME") ?? "").trim();
  const mcpExtensions = ((values["mcp-extensions"] as string | undefined) ?? envOr("IICP_MCP_EXTENSIONS") ?? "")
    .split(",").map((extension) => extension.trim().toLowerCase()).filter(Boolean);
  if (![...SUPPORTED_MCP_REVISIONS].includes(mcpRevision as typeof SUPPORTED_MCP_REVISIONS[number])) {
    process.stderr.write(`ERROR: unsupported MCP revision ${mcpRevision}.\n`);
    return 2;
  }
  if (mcpRevision === MODERN_MCP_REVISION && !mcpServerName) {
    process.stderr.write("ERROR: --mcp-server-name is required with MCP 2026-07-28.\n");
    return 2;
  }
  const rawTools = ((values["tools"] as string | undefined) ?? envOr("IICP_MCP_TOOLS") ?? "")
    .split(",").map((t) => t.trim()).filter(Boolean);
  const toolPolicy = new McpToolPolicy({
    allowDangerousTools: Boolean(values["allow-dangerous-tools"]) || envBool("IICP_MCP_ALLOW_DANGEROUS_TOOLS"),
    authzPolicy: (values["authz-policy"] as string | undefined) ?? envOr("IICP_MCP_AUTHZ_POLICY") ?? "",
    sandboxProfile: (values["sandbox"] as string | undefined) ?? envOr("IICP_MCP_SANDBOX") ?? "",
    auditRedaction: Boolean(values["audit-redaction"]) || envBool("IICP_MCP_AUDIT_REDACTION"),
  });
  const activeTools = rawTools.filter((t) => toolPolicy.allows(t));
  const deniedTools = rawTools.filter((t) => !toolPolicy.allows(t));
  if (deniedTools.length) {
    process.stderr.write(`WARNING: denied high-risk MCP tools until all authz, sandbox and redacted-audit controls are configured: ${deniedTools.join(", ")}\n`);
  }

  if (activeTools.length === 0) {
    const reason = rawTools.length > 0
      ? "all requested tools were denied by the MCP safety policy"
      : "--tools is required";
    process.stderr.write(
      `ERROR: ${reason}. Provide safe tool names, or configure every dangerous-tool control.\n` +
        `  Example: iicp-node mcp-gateway --tools summarize_text,lookup_status --mcp-url http://localhost:8001\n`,
    );
    return 2;
  }

  const nodeId = (values["node-id"] as string | undefined) ?? envOr("IICP_NODE_ID") ?? `gateway-mcp-${randomBytes(4).toString("hex")}`;
  const directoryUrl = ((values["directory-url"] as string | undefined) ?? envOr("IICP_DIRECTORY_URL") ?? "https://iicp.network/api/v1").replace(/\/$/, "");
  const region = (values["region"] as string | undefined) ?? envOr("IICP_REGION") ?? "local";
  const port = parsePort(values["port"] as string | undefined, 9484);
  const host = (values["host"] as string | undefined) ?? envOr("IICP_HOST") ?? "::";
  const publicEndpoint = (values["public-endpoint"] as string | undefined) ?? envOr("IICP_PUBLIC_ENDPOINT") ?? `http://localhost:${port}`;
  const intents = activeTools.map(_toolToIntent);
  const capabilities = activeTools.map((tool, index) => ({
    intent: intents[index], models: [`mcp:${tool}`], max_tokens: 65536,
  }));

  let nodeToken = envOr("IICP_NODE_TOKEN") ?? "";

  async function doRegister(): Promise<string> {
    const payload = {
      node_id: nodeId,
      region,
      endpoint: publicEndpoint,
      capabilities,
      limits: { max_concurrent: 1, tokens_per_min: 65536 },
      backend: "custom",
      policy: {
        allow_remote_inference: false,
        allow_tool_execution: true,
        allow_file_access: activeTools.some((tool) => ["file_read", "file_write"].includes(toolRiskLabel(tool))),
      },
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (nodeToken) headers["Authorization"] = `Bearer ${nodeToken}`;
    const resp = await fetch(`${directoryUrl}/register`, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`register ${resp.status}`);
    const data = await resp.json() as Record<string, unknown>;
    return (data["node_token"] as string | undefined) ?? nodeToken;
  }

  async function doHeartbeat(): Promise<void> {
    const payload = { node_id: nodeId, intents, load: 0.0, status: "active" };
    try {
      await fetch(`${directoryUrl}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${nodeToken}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // heartbeat failures are non-fatal
    }
  }

  let mcpRpcId = 0;
  let legacySessionId: string | undefined;
  let legacyInitialization: Promise<void> | undefined;

  class McpLegacySessionExpired extends Error {}

  async function mcpResponseJson(response: Response): Promise<Record<string, unknown>> {
    const raw = await response.text();
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const events = raw.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
      if (!events.length) throw new Error("MCP server returned an empty event stream");
      return JSON.parse(events.at(-1) ?? "") as Record<string, unknown>;
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }

  async function initializeLegacySession(): Promise<void> {
    if (legacyInitialization) return legacyInitialization;
    legacyInitialization = (async () => {
      const id = ++mcpRpcId;
      const headers = {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": LEGACY_MCP_REVISION,
        "Accept": "application/json, text/event-stream",
      };
      const init = await fetch(`${mcpUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0", id, method: "initialize",
          params: { protocolVersion: LEGACY_MCP_REVISION, capabilities: {}, clientInfo: { name: "iicp-mcp-gateway", version: "0.7" } },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!init.ok) throw new Error(`MCP legacy initialization failed: ${init.status}`);
      const initData = await mcpResponseJson(init);
      if (initData["error"]) throw new Error("MCP server rejected legacy initialization");
      const sessionId = init.headers.get("mcp-session-id");
      if (!sessionId) throw new Error("MCP server did not return a legacy session identifier");
      const initialized = await fetch(`${mcpUrl}/mcp`, {
        method: "POST",
        headers: { ...headers, "Mcp-Session-Id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!initialized.ok) throw new Error(`MCP legacy initialized notification failed: ${initialized.status}`);
      legacySessionId = sessionId;
    })();
    try { await legacyInitialization; } finally { legacyInitialization = undefined; }
  }

  async function legacyToolCall(rpc: Record<string, unknown>, replaySafe: boolean): Promise<Record<string, unknown>> {
    if (!legacySessionId) await initializeLegacySession();
    const send = async (): Promise<Record<string, unknown>> => {
      if (!legacySessionId) throw new Error("legacy MCP session identifier is unavailable");
      const response = await fetch(`${mcpUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": LEGACY_MCP_REVISION,
          "Mcp-Session-Id": legacySessionId,
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(rpc),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 404) {
        legacySessionId = undefined;
        throw new McpLegacySessionExpired("MCP legacy session expired");
      }
      if (!response.ok) throw new Error(`MCP server unreachable: ${response.status}`);
      return mcpResponseJson(response);
    };
    try { return await send(); }
    catch (error) {
      if (!(error instanceof McpLegacySessionExpired)) throw error;
      if (!replaySafe) throw new McpLegacySessionExpired("MCP legacy session expired; caller retry required");
      await initializeLegacySession();
      try { return await send(); }
      catch (retryError) {
        if (retryError instanceof McpLegacySessionExpired) throw new Error("MCP legacy session expired after one reinitialization");
        throw retryError;
      }
    }
  }

  async function callMcp(toolName: string, args: Record<string, unknown>, replaySafe = false): Promise<unknown> {
    mcpRpcId += 1;
    const params = { name: toolName, arguments: args };
    const modern = mcpRevision === MODERN_MCP_REVISION
      ? buildModernMcpRequest({ requestId: mcpRpcId, method: "tools/call", name: toolName, params, extensions: mcpExtensions })
      : null;
    const rpc = modern?.body ?? { jsonrpc: "2.0", id: mcpRpcId, method: "tools/call", params };
    const data = modern
      ? await (async () => {
          const resp = await fetch(`${mcpUrl}/mcp`, {
            method: "POST", headers: { "Content-Type": "application/json", ...modern.headers },
            body: JSON.stringify(rpc), signal: AbortSignal.timeout(30_000),
          });
          if (!resp.ok) throw new Error(`MCP server unreachable: ${resp.status}`);
          return resp.json() as Promise<Record<string, unknown>>;
        })()
      : await legacyToolCall(rpc, replaySafe);
    if (modern) validateModernMcpResponse(data, mcpServerName);
    if (data["error"]) throw new Error("MCP tool returned an error");
    return data["result"];
  }

  try {
    nodeToken = await doRegister();
    process.stdout.write(
      `iicp-node mcp-gateway registered as '${nodeId}' with ${activeTools.length} tool(s): ${activeTools.join(", ")}\n` +
        `  IICP endpoint: ${publicEndpoint}\n  MCP server:    ${mcpUrl}\n`,
    );
  } catch (err) {
    process.stderr.write(`WARNING: directory registration failed (${(err as Error).message}) — running without listing\n`);
  }

  const hbInterval = setInterval(() => { void doHeartbeat(); }, 30_000);

  const stopAutoUpdate = startProviderAutoUpdate();

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/iicp/health") {
      const body = JSON.stringify({
        status: "ok", node_id: nodeId, active_tools: activeTools, mcp_server: mcpUrl,
        mcp_policy: {
          dangerous_tools_enabled: toolPolicy.dangerousReady,
          authz_policy: toolPolicy.authzPolicy || null,
          sandbox_profile: toolPolicy.sandboxProfile || null,
          audit_redacted: toolPolicy.auditRedaction,
        },
        timestamp: Math.floor(Date.now() / 1000),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    if (req.method === "POST" && req.url === "/v1/task") {
      const auth = req.headers["authorization"] ?? "";
      if (!nodeToken || auth !== `Bearer ${nodeToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; }
      catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "invalid JSON" })); return; }

      const payload = (body["payload"] ?? {}) as Record<string, unknown>;
      let toolName = (payload["tool_name"] as string | undefined) ?? "";
      if (!toolName) {
        const m = /urn:iicp:intent:mcp:([^:]+):v1/.exec((body["intent"] as string | undefined) ?? "");
        if (m) toolName = m[1];
      }
      if (!toolName) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Cannot determine tool name" })); return; }
      const args = (payload["arguments"] ?? {}) as Record<string, unknown>;
      const argumentCount = args && typeof args === "object" ? Object.keys(args).length : 0;
      if (!toolPolicy.allows(toolName)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Tool not permitted by MCP risk policy", policy_receipt: toolPolicy.receipt(toolName, "denied", argumentCount) }));
        return;
      }
      if (activeTools.length && !activeTools.includes(toolName)) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Tool not available" })); return; }
      const taskId = (body["task_id"] as string | undefined) ?? randomUUID();
      try {
        const result = await callMcp(toolName, args, payload["mcp_replay_safe"] === true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ task_id: taskId, status: "completed", result, policy_receipt: toolPolicy.receipt(toolName, "allowed", argumentCount) }));
      } catch (err) {
        const msg = (err as Error).message ?? "error";
        const code = err instanceof McpLegacySessionExpired ? 409 : msg.includes("unreachable") ? 502 : 422;
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(err instanceof McpLegacySessionExpired ? { error: "mcp_session_expired_retry_required", retryable: true } : { error: msg }));
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host === "::" ? "::" : host, () => {
      process.stdout.write(`  Listening on ${host}:${port}\n`);
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => { clearInterval(hbInterval); stopAutoUpdate(); server.close(); resolve(); });
    process.on("SIGTERM", () => { clearInterval(hbInterval); stopAutoUpdate(); server.close(); resolve(); });
  });

  return 0;
}

/** Command dispatch — separated so main() can wrap parse failures as clean CliError output. */
// #521 P1 — read-only version check. Exit 10 when a newer release exists
// (so cron/scripts can act), 0 when current/unreachable. Never installs.
async function runUpdate(argv: string[] = []): Promise<number> {
  const { values } = safeParseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printUpdateHelp();
    return 0;
  }
  const { checkUpdate, latestNpmVersion } = await import("./updater.js");
  const latest = await latestNpmVersion();
  const v = checkUpdate(SDK_VERSION, latest);
  if (latest === null) {
    process.stdout.write(`@iicp/client ${v.current} — could not reach npm to check for updates.\n`);
    return 0;
  }
  if (v.outdated) {
    process.stdout.write(
      `@iicp/client ${v.current} — a newer release is available: ${v.latest}\n  upgrade:  ${v.command}\n`,
    );
    return 10;
  }
  process.stdout.write(`@iicp/client ${v.current} — up to date (latest: ${v.latest}).\n`);
  return 0;
}

async function runService(argv: string[]): Promise<number> {
  const subcmd = argv[0];
  if (!subcmd || subcmd === "--help" || subcmd === "-h" || subcmd === "help") {
    process.stdout.write(
      `usage: iicp-node service <install|status|restart|uninstall> --node NAME [options]\n\n` +
        `Generate user-level launchd/systemd supervisor units. The service runs foreground:\n` +
        `  iicp-node serve --node <NAME>\n\n` +
        `Options:\n` +
        `  --node NAME        Saved node name to serve (required)\n` +
        `  --name NAME        Override service label/unit name\n` +
        `  --platform KIND    auto | launchd | systemd (default auto)\n` +
        `  --dry-run          For install: print the generated unit without writing files\n`,
    );
    return subcmd ? 0 : 2;
  }
  if (!["install", "status", "restart", "uninstall"].includes(subcmd)) {
    throw new CliError(`unknown service subcommand '${subcmd}'`);
  }
  const { values } = safeParseArgs({
    args: argv.slice(1),
    options: {
      node: { type: "string" },
      name: { type: "string" },
      platform: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) return runService(["help"]);
  const node = values.node as string | undefined;
  if (!node) throw new CliError("service requires --node NAME");
  const { renderServiceUnit } = await import("./service.js");
  const unit = renderServiceUnit(node, values.name as string | undefined, (values.platform as string | undefined) ?? "auto");

  if (subcmd === "install") {
    if (values["dry-run"]) {
      process.stdout.write(`# ${unit.platform} service: ${unit.name}\n# path: ${unit.path}\n${unit.content}`);
    } else {
      fs.mkdirSync(path.dirname(unit.path), { recursive: true });
      fs.writeFileSync(unit.path, unit.content);
      process.stdout.write(`Installed ${unit.platform} service unit: ${unit.path}\n`);
    }
    process.stdout.write(`status:   ${unit.statusHint}\n`);
    process.stdout.write(`restart:  ${unit.restartHint}\n`);
    process.stdout.write(`logs:     ${unit.logHint}\n`);
    process.stdout.write("Note: no classic --daemon fork is used; the OS supervisor runs foreground `iicp-node serve`.\n");
    return 0;
  }
  if (subcmd === "status") process.stdout.write(`${unit.statusHint}\n`);
  if (subcmd === "restart") process.stdout.write(`${unit.restartHint}\n`);
  if (subcmd === "uninstall") process.stdout.write(`${unit.uninstallHint}\n`);
  return 0;
}

async function dispatch(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === "init") return runInit();
  if (cmd === "list") return runList(argv.slice(1));
  if (cmd === "query") return runQuery(argv.slice(1));
  if (cmd === "credits") return runCredits(argv.slice(1));
  if (cmd === "doctor") return runDoctor(argv.slice(1));
  if (cmd === "operator") return runOperator(argv.slice(1));
  if (cmd === "proxy") return runProxyCmd(argv.slice(1));
  if (cmd === "mcp-gateway") return runMcpGateway(argv.slice(1));
  if (cmd === "update") return runUpdate(argv.slice(1));
  if (cmd === "service") return runService(argv.slice(1));
  if (cmd !== "serve") {
    process.stderr.write(`unknown command: ${cmd}\n`);
    printHelp();
    return 2;
  }

  const { values } = safeParseArgs({
    args: argv.slice(1),
    options: {
      node: { type: "string" },
      "backend-url": { type: "string" },
      "policy-manifest": { type: "string" },
      "receipt-profile": { type: "string", multiple: true },
      "backend-type": { type: "string" },
      "backend-api-key": { type: "string" },
      experimental: { type: "boolean" },
      model: { type: "string" },
      "public-endpoint": { type: "string" },
      "directory-url": { type: "string" },
      region: { type: "string" },
      intent: { type: "string" },
      "max-concurrent": { type: "string" },
      "node-id": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "skip-registration": { type: "boolean" },
      tunnel: { type: "boolean" },
      "no-tunnel": { type: "boolean" },
      force: { type: "boolean" },
      "auto-detect-nat": { type: "boolean" },
      // Parity with Python's BooleanOptionalAction: an explicit off-switch for NAT
      // detection (`--auto-detect-nat=false` can't work — it's a no-arg boolean).
      "no-auto-detect-nat": { type: "boolean" },
      "external-ip-probe-url": { type: "string" },
      "relay-worker-endpoint": { type: "string" },
      "relay-capable": { type: "boolean" },
      "relay-accept-port": { type: "string" },
      "log-dir": { type: "string" },
      "with-proxy": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printServeHelp();
    return 0;
  }
  const opts: ServeOpts = {
    node: (values.node as string | undefined) ?? envOr("IICP_NODE_NAME") ?? "",
    backendUrl: (values["backend-url"] as string | undefined) ?? envOr("IICP_BACKEND_URL") ?? "",
    policyManifest: (values["policy-manifest"] as string | undefined) ?? envOr("IICP_POLICY_MANIFEST_FILE") ?? "",
    receiptProfiles:
      values["receipt-profile"] !== undefined || process.env.IICP_SUPPORTED_RECEIPT_PROFILES !== undefined
        ? resolveReceiptProfiles(
            values["receipt-profile"] as string[] | undefined,
            envOr("IICP_SUPPORTED_RECEIPT_PROFILES"),
          )
        : undefined,
    backendType:
      (values["backend-type"] as string | undefined) ??
      envOr("IICP_BACKEND_TYPE", "openai_compat")!,
    backendApiKey:
      (values["backend-api-key"] as string | undefined) ?? envOr("IICP_BACKEND_API_KEY") ?? "",
    experimental: Boolean(values.experimental) || envBool("IICP_EXPERIMENTAL"),
    model: (values.model as string | undefined) ?? envOr("IICP_BACKEND_MODEL") ?? "",
    publicEndpoint:
      (values["public-endpoint"] as string | undefined) ?? envOr("IICP_PUBLIC_ENDPOINT") ?? "",
    directoryUrl:
      (values["directory-url"] as string | undefined) ??
      envOr("IICP_DIRECTORY_URL") ?? "",
    region: (values.region as string | undefined) ?? envOr("IICP_REGION"),
    intent: (values.intent as string | undefined) ?? envOr("IICP_INTENT", "urn:iicp:intent:llm:chat:v1")!,
    maxConcurrent:
      values["max-concurrent"] !== undefined
        ? parseInt(values["max-concurrent"] as string, 10)
        : envInt("IICP_MAX_CONCURRENT", 4),
    nodeId: (values["node-id"] as string | undefined) ?? envOr("IICP_NODE_ID") ?? "",
    port:
      values.port !== undefined
        ? parsePort(values.port as string, 9484)
        : parsePort(process.env["IICP_PORT"], 9484),
    host: (values.host as string | undefined) ?? envOr("IICP_HOST", "::")!,
    skipRegistration:
      Boolean(values["skip-registration"]) || envBool("IICP_SKIP_REGISTRATION"),
    force: Boolean(values["force"]) || envBool("IICP_FORCE"),
    // Default ON — matches Python CLI behaviour. Off-switch precedence: explicit
    // --no-auto-detect-nat > --auto-detect-nat > IICP_AUTO_DETECT_NAT env > default on.
    autoDetectNat:
      values["no-auto-detect-nat"]
        ? false
        : values["auto-detect-nat"] !== undefined
          ? Boolean(values["auto-detect-nat"])
          : process.env.IICP_AUTO_DETECT_NAT !== undefined
            ? envBool("IICP_AUTO_DETECT_NAT")
            : true,
    // Default to api.ipify.org so FRITZ!Box/CGNAT detection works out of the box.
    externalIpProbeUrl:
      (values["external-ip-probe-url"] as string | undefined)
        ?? envOr("IICP_EXTERNAL_IP_PROBE_URL")
        ?? "https://api.ipify.org",
    relayWorkerEndpoint:
      (values["relay-worker-endpoint"] as string | undefined) ?? envOr("IICP_RELAY_WORKER_ENDPOINT") ?? "",
    // #520 rung 5 tri-state: --tunnel > --no-tunnel > IICP_TUNNEL env > auto (undefined).
    tunnel: values["tunnel"]
      ? true
      : values["no-tunnel"]
        ? false
        : process.env.IICP_TUNNEL !== undefined
          ? envBool("IICP_TUNNEL")
          : undefined,
    relayCapable:
      values["relay-capable"] !== undefined
        ? Boolean(values["relay-capable"])
        : envBool("IICP_RELAY_CAPABLE"),
    relayAcceptPort:
      values["relay-accept-port"] !== undefined
        ? parseInt(values["relay-accept-port"] as string, 10)
        : parseInt(envOr("IICP_RELAY_ACCEPT_PORT") ?? "9485", 10),
    logDir: (values["log-dir"] as string | undefined) ?? envOr("IICP_LOG_DIR"),
    withProxy: Boolean(values["with-proxy"]) || envBool("IICP_WITH_PROXY"),
  };
  return runServe(opts);
}

// Direct invocation (node dist/cli.js or via the bin shim)
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Clean one-line error — never dump a raw Node stack trace at the user.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ERROR: ${msg}\n`);
      process.exit(1);
    });
}

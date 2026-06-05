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
import { execSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { IicpNode, deriveNativeEndpoint } from "./node.js";
import { IicpClient } from "./client.js";
import { writeNodeEvent } from "./node_log.js";
import { configureCipPolicy } from "./cip_policy.js";
import { InstanceLock, NodeAlreadyServingError } from "./instance_lock.js";
import { getBackendHandler, BACKEND_TYPES } from "./backends/index.js";
import {
  configDir,
  generateNode,
  generateOperator,
  listNodes,
  loadNode,
  loadOperator,
  operatorDecryptAtRest,
  operatorEncryptAtRest,
  operatorIsEncrypted,
  operatorIsKeyBacked,
  operatorSigningKey,
  saveNode,
  saveOperator,
  type NodeIdentity,
} from "./identity.js";
import { issueDelegation, signRename } from "./delegation.js";

export interface ServeOpts {
  backendUrl: string;
  backendType: string;
  /** #5 — Bearer key for an auth-requiring OpenAI-compat backend (LM Studio, hosted). Empty = none. */
  backendApiKey: string;
  model: string;
  publicEndpoint: string;
  directoryUrl: string;
  region: string;
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
  node: string;
  logDir?: string;
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
  return v.toLowerCase() === "true" || v === "1";
}

function printHelp(): void {
  process.stdout.write(
    `usage: iicp-node <command> [options]\n\n` +
      `Commands:\n` +
      `  init                       Interactive wizard — set up operator + first node config\n` +
      `  list                       List node configs saved under ~/.iicp/nodes/\n` +
      `  serve                      Register and serve a node\n` +
      `  query <prompt>             Discover mesh nodes and submit a chat task\n` +
      `  credits                    Show this node's earned / spent / balance credits\n` +
      `  operator rename <name>     Change your public display_name (signed by your operator key)\n\n` +
      `Run an IICP provider node backed by an OpenAI-compatible server.\n\n` +
      `serve required (flag or env):\n` +
      `  --model NAME               IICP_BACKEND_MODEL — model name (e.g. qwen2.5:0.5b)\n` +
      `  (or --node NAME            load both from ~/.iicp/nodes/<NAME>.json after \`iicp-node init\`)\n\n` +
      `serve optional:\n` +
      `  --backend-url URL          IICP_BACKEND_URL — Ollama / vLLM / LM Studio (default http://localhost:11434; anthropic → https://api.anthropic.com)\n` +
      `  --backend-type TYPE        IICP_BACKEND_TYPE — openai_compat | vllm | llamacpp | anthropic (default openai_compat)\n` +
      `  --backend-api-key KEY      IICP_BACKEND_API_KEY — Bearer key for an auth'd backend (LM Studio, hosted); anthropic uses it as x-api-key\n` +
      `  --public-endpoint URL      IICP_PUBLIC_ENDPOINT — externally reachable URL of this node\n` +
      `  --directory-url URL        IICP_DIRECTORY_URL (default https://iicp.network/api)\n` +
      `  --region REGION            IICP_REGION (default eu-central)\n` +
      `  --intent URN               IICP_INTENT (default urn:iicp:intent:llm:chat:v1)\n` +
      `  --max-concurrent N         IICP_MAX_CONCURRENT (default 4)\n` +
      `  --node-id ID               IICP_NODE_ID (auto-generated if absent)\n` +
      `  --port N                   IICP_PORT (default 9484)\n` +
      `  --host HOST                IICP_HOST (default :: — dual-stack IPv4+IPv6)\n` +
      `  --skip-registration        IICP_SKIP_REGISTRATION — register-free dev mode\n` +
      `  --auto-detect-nat          IICP_AUTO_DETECT_NAT — run NAT detection at startup\n` +
      `  --external-ip-probe-url U  IICP_EXTERNAL_IP_PROBE_URL — fallback IPv4 probe\n\n` +
      `query optional:\n` +
      `  --directory-url URL        IICP_DIRECTORY_URL (default https://iicp.network/api)\n` +
      `  --intent URN               IICP_INTENT (default urn:iicp:intent:llm:chat:v1)\n` +
      `  --model NAME               Pin to a specific model on the remote node\n` +
      `  --max-tokens N             Limit response length\n` +
      `  --timeout-ms N             Request timeout (default 60000)\n`,
  );
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
  if (backendType === "anthropic" || backendType === "vllm" || backendType === "llamacpp") return backendType;
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
    const region = await ask(rl, "Region tag", "eu-central");
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

function runList(): number {
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
      (n) => n.relay_capable && n.endpoint,
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
    host: opts.host === "0.0.0.0" ? saved.host : opts.host,
    autoDetectNat: opts.autoDetectNat || saved.auto_detect_nat,
    externalIpProbeUrl: opts.externalIpProbeUrl || saved.external_ip_probe_url,
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

  if (opts.node) {
    const saved = loadNode(opts.node);
    if (!saved) {
      process.stderr.write(
        `ERROR: no saved config at ~/.iicp/nodes/${opts.node}.json. Run \`iicp-node init\` first.\n`,
      );
      return 2;
    }
    opts = applySavedNode(opts, saved);
  }

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

      // Tier ≥ 3 (CGNAT + no usable IPv6 path) and no relay configured:
      // auto-elect a relay from the directory so we can register via relay.
      if (natProfile.tier >= 3 && !opts.relayWorkerEndpoint) {
        // eslint-disable-next-line no-console
        console.log(`[iicp-node] NAT tier=${natProfile.tier}: auto-electing relay from directory…`);
        const elected = await _autoElectRelay(
          opts.directoryUrl ?? "https://iicp.network/api",
          opts.intent,
          nodeId,
        );
        if (elected) {
          const [relayHost, relayPort] = elected;
          opts = { ...opts, relayWorkerEndpoint: `${relayHost}:${relayPort}` };
          // eslint-disable-next-line no-console
          console.log(`[iicp-node] auto-elected relay: ${relayHost}:${relayPort}`);
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            `[iicp-node] NAT tier=${natProfile.tier}: no relay-capable peers in directory. ` +
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
  if (_op && operatorIsKeyBacked(_op)) {
    _opDelegation = issueDelegation(operatorSigningKey(_op), nodeId);
    _opDisplayName = _op.display_name || undefined;
    _opCreatedAt = _op.created_at;
    _opIntegrityHash = _op.operator_integrity_hash || undefined;
  }

  const node = new IicpNode({
    nodeId,
    endpoint: publicEndpoint,
    intent: opts.intent,
    model: opts.model,
    backend: backendFlavor,
    region: opts.region,
    directoryUrl: opts.directoryUrl,
    maxConcurrent: opts.maxConcurrent,
    relayWorkerEndpoint: opts.relayWorkerEndpoint || undefined,
    operatorDelegation: _opDelegation,
    operatorDisplayName: _opDisplayName,
    operatorCreatedAt: _opCreatedAt,
    operatorIntegrityHash: _opIntegrityHash,
  });

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
    const extra = allModels.filter((m) => m !== opts.model);
    if (extra.length > 0) {
      node["_cfg"].capabilities = extra;
      // eslint-disable-next-line no-console
      console.log(`[iicp-node] GAP-6: advertising ${extra.length} additional model(s): ${extra.slice(0, 6).join(", ")}`);
    }
  } catch {
    // best-effort; no-op on error
  }

  // NAT-4 guard: if endpoint is non-routable and no relay configured, skip
  // registration to avoid a confusing 422 from the directory's RoutableEndpoint check.
  const epLocal =
    publicEndpoint.startsWith("http://localhost") ||
    publicEndpoint.startsWith("http://127.") ||
    publicEndpoint.startsWith("http://0.0.0.0") ||
    publicEndpoint.startsWith("http://192.168.") ||
    publicEndpoint.startsWith("http://10.");
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
        // #456 — cache the token in the saved config so `iicp-node credits` can
        // authenticate later without re-registering (best-effort).
        if (opts.node && token) {
          const saved = loadNode(opts.node);
          if (saved) {
            saved.node_token = token;
            try {
              saveNode(saved);
            } catch {
              /* best-effort cache */
            }
          }
        }
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
  // serve() returns a stop() handle but never resolves on its own; we wait for
  // SIGINT/SIGTERM to terminate.
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
      stop();
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

async function runQuery(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "directory-url": { type: "string" },
      intent: { type: "string" },
      model: { type: "string" },
      "max-tokens": { type: "string" },
      "timeout-ms": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    process.stderr.write("Usage: iicp-node query <prompt> [flags]\n");
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

  const client = new IicpClient({ directory_url: directoryUrl, timeout_ms: timeoutMs, tls_verify: true });
  process.stderr.write(`[iicp-node] Discovering nodes for ${intent}...\n`);

  try {
    const resp = await client.submit({
      task_id: randomUUID(),
      intent,
      payload,
    });
    if (resp.status === "completed" && resp.result) {
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
            ? payload["amount"]
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
 * `iicp-node credits` (#456) — earned / spent / balance from the directory's
 * reconcile-checked GET /v1/credits/summary. Figures come authenticated from the
 * directory (not the local config), so editing the saved file cannot inflate them;
 * `reconciles` flags a ledger that does not add up.
 */
async function runCredits(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      node: { type: "string" },
      "node-id": { type: "string" },
      token: { type: "string" },
      "directory-url": { type: "string" },
      json: { type: "boolean" },
      verify: { type: "boolean" },
    },
    allowPositionals: false,
  });

  const nodeName = values["node"] as string | undefined;
  let directoryUrl = values["directory-url"] as string | undefined;
  let nodeId = values["node-id"] as string | undefined;
  let token = (values["token"] as string | undefined) ?? process.env["IICP_NODE_TOKEN"];

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

  const url = `${directoryUrl.replace(/\/+$/, "")}/v1/credits/summary`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "X-Node-Id": nodeId },
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
    process.stderr.write(`ERROR: bad response (HTTP ${resp.status})\n`);
    return 1;
  }
  if (!resp.ok) {
    const err = body["error"] as { message?: string } | undefined;
    process.stderr.write(`ERROR: HTTP ${resp.status}: ${err?.message ?? "request rejected"}\n`);
    return 1;
  }

  if (values["json"]) {
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
  process.stdout.write(`IICP credits — ${nodeName ?? nodeId}\n`);
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
  if (values["verify"]) {
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
async function runOperator(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "encrypt") return runOperatorEncrypt();
  if (sub === "decrypt") return runOperatorDecrypt();
  if (sub !== "rename") {
    process.stderr.write(`unknown operator subcommand: ${sub ?? "(none)"}\n`);
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: { "directory-url": { type: "string" } },
    allowPositionals: true,
  });
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`iicp-node ${SDK_VERSION}\n`);
    return 0;
  }

  const cmd = argv[0];
  if (cmd === "init") return runInit();
  if (cmd === "list") return runList();
  if (cmd === "query") return runQuery(argv.slice(1));
  if (cmd === "credits") return runCredits(argv.slice(1));
  if (cmd === "operator") return runOperator(argv.slice(1));
  if (cmd !== "serve") {
    process.stderr.write(`unknown command: ${cmd}\n`);
    printHelp();
    return 2;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      node: { type: "string" },
      "backend-url": { type: "string" },
      "backend-type": { type: "string" },
      "backend-api-key": { type: "string" },
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
      force: { type: "boolean" },
      "auto-detect-nat": { type: "boolean" },
      "external-ip-probe-url": { type: "string" },
      "relay-worker-endpoint": { type: "string" },
      "log-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printHelp();
    return 0;
  }
  const opts: ServeOpts = {
    node: (values.node as string | undefined) ?? envOr("IICP_NODE_NAME") ?? "",
    backendUrl: (values["backend-url"] as string | undefined) ?? envOr("IICP_BACKEND_URL") ?? "",
    backendType:
      (values["backend-type"] as string | undefined) ??
      envOr("IICP_BACKEND_TYPE", "openai_compat")!,
    backendApiKey:
      (values["backend-api-key"] as string | undefined) ?? envOr("IICP_BACKEND_API_KEY") ?? "",
    model: (values.model as string | undefined) ?? envOr("IICP_BACKEND_MODEL") ?? "",
    publicEndpoint:
      (values["public-endpoint"] as string | undefined) ?? envOr("IICP_PUBLIC_ENDPOINT") ?? "",
    directoryUrl:
      (values["directory-url"] as string | undefined) ??
      envOr("IICP_DIRECTORY_URL", "https://iicp.network/api")!,
    region: (values.region as string | undefined) ?? envOr("IICP_REGION", "eu-central")!,
    intent: (values.intent as string | undefined) ?? envOr("IICP_INTENT", "urn:iicp:intent:llm:chat:v1")!,
    maxConcurrent:
      values["max-concurrent"] !== undefined
        ? parseInt(values["max-concurrent"] as string, 10)
        : envInt("IICP_MAX_CONCURRENT", 4),
    nodeId: (values["node-id"] as string | undefined) ?? envOr("IICP_NODE_ID") ?? "",
    port:
      values.port !== undefined
        ? parseInt(values.port as string, 10)
        : envInt("IICP_PORT", 9484),
    host: (values.host as string | undefined) ?? envOr("IICP_HOST", "::")!,
    skipRegistration:
      Boolean(values["skip-registration"]) || envBool("IICP_SKIP_REGISTRATION"),
    force: Boolean(values["force"]) || envBool("IICP_FORCE"),
    // Default ON — matches Python CLI behaviour; operator must set IICP_AUTO_DETECT_NAT=false to opt out.
    autoDetectNat:
      values["auto-detect-nat"] !== undefined
        ? Boolean(values["auto-detect-nat"])
        : (process.env.IICP_AUTO_DETECT_NAT !== undefined ? envBool("IICP_AUTO_DETECT_NAT") : true),
    // Default to api.ipify.org so FRITZ!Box/CGNAT detection works out of the box.
    externalIpProbeUrl:
      (values["external-ip-probe-url"] as string | undefined)
        ?? envOr("IICP_EXTERNAL_IP_PROBE_URL")
        ?? "https://api.ipify.org",
    relayWorkerEndpoint:
      (values["relay-worker-endpoint"] as string | undefined) ?? envOr("IICP_RELAY_WORKER_ENDPOINT") ?? "",
    logDir: (values["log-dir"] as string | undefined) ?? envOr("IICP_LOG_DIR"),
  };
  return runServe(opts);
}

// Direct invocation (node dist/cli.js or via the bin shim)
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}

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
import { randomBytes, randomUUID } from "node:crypto";
import * as net from "node:net";
import { execSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { IicpNode } from "./node.js";
import { configureCipPolicy } from "./cip_policy.js";
import { getBackendHandler, BACKEND_TYPES } from "./backends/index.js";
import {
  configDir,
  generateNode,
  generateOperator,
  listNodes,
  loadNode,
  loadOperator,
  saveNode,
  saveOperator,
  type NodeIdentity,
} from "./identity.js";

interface ServeOpts {
  backendUrl: string;
  backendType: string;
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
  autoDetectNat: boolean;
  externalIpProbeUrl: string;
  relayWorkerEndpoint: string;
  node: string;
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
      `  serve                      Register and serve a node\n\n` +
      `Run an IICP provider node backed by an OpenAI-compatible server.\n\n` +
      `serve required (flag or env):\n` +
      `  --model NAME               IICP_BACKEND_MODEL — model name (e.g. qwen2.5:0.5b)\n` +
      `  (or --node NAME            load both from ~/.iicp/nodes/<NAME>.json after \`iicp-node init\`)\n\n` +
      `serve optional:\n` +
      `  --backend-url URL          IICP_BACKEND_URL — Ollama / vLLM / LM Studio (default http://localhost:11434)\n` +
      `  --backend-type TYPE        IICP_BACKEND_TYPE — openai_compat | vllm | llamacpp (default openai_compat)\n` +
      `  --public-endpoint URL      IICP_PUBLIC_ENDPOINT — externally reachable URL of this node\n` +
      `  --directory-url URL        IICP_DIRECTORY_URL (default https://iicp.network/api)\n` +
      `  --region REGION            IICP_REGION (default eu-central)\n` +
      `  --intent URN               IICP_INTENT (default urn:iicp:intent:llm:chat:v1)\n` +
      `  --max-concurrent N         IICP_MAX_CONCURRENT (default 4)\n` +
      `  --node-id ID               IICP_NODE_ID (auto-generated if absent)\n` +
      `  --port N                   IICP_PORT (default 9484)\n` +
      `  --host HOST                IICP_HOST (default 0.0.0.0)\n` +
      `  --skip-registration        IICP_SKIP_REGISTRATION — register-free dev mode\n` +
      `  --auto-detect-nat          IICP_AUTO_DETECT_NAT — run NAT detection at startup\n` +
      `  --external-ip-probe-url U  IICP_EXTERNAL_IP_PROBE_URL — fallback IPv4 probe\n`,
  );
}

// ── #346 — dependency checker + auto-install ────────────────────────────────

interface DepIssue {
  name: string;
  severity: "ok" | "warn" | "missing";
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
      out.push({ name: mod, severity: "missing", message: `${purpose} (not installed)`, installable: true, npmExtra: npmName });
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

function printDepStatus(issues: DepIssue[]): void {
  const glyph: Record<string, string> = { ok: "  ✓", warn: "  !", missing: "  ✗" };
  for (const i of issues) {
    process.stdout.write(`${glyph[i.severity] ?? "  ?"} ${i.name.padEnd(18)}  ${i.message}\n`);
  }
}

function installMissing(issues: DepIssue[]): void {
  const extras = Array.from(
    new Set(
      issues
        .filter((i) => i.severity === "missing" && i.installable && i.npmExtra)
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
    const missingCount = issues.filter((i) => i.severity === "missing" && i.installable).length;
    if (missingCount > 0) {
      const yn = (await ask(rl, `\nInstall ${missingCount} missing optional package(s)? [Y/n]`, "y")).toLowerCase();
      if (yn === "" || yn === "y" || yn === "yes") {
        installMissing(issues);
      } else {
        process.stdout.write(`  ! skipping — install later with: npm install <pkg>\n`);
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

function applySavedNode(opts: ServeOpts, saved: NodeIdentity): ServeOpts {
  return {
    ...opts,
    // Onboarding: default to Ollama's well-known local port so only --model is required.
    backendUrl: opts.backendUrl || saved.backend_url || "http://localhost:11434",
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
  const nodeId = (opts.nodeId || crypto.randomUUID()).slice(0, 36);

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

  const node = new IicpNode({
    nodeId,
    endpoint: publicEndpoint,
    intent: opts.intent,
    model: opts.model,
    region: opts.region,
    directoryUrl: opts.directoryUrl,
    maxConcurrent: opts.maxConcurrent,
    relayWorkerEndpoint: opts.relayWorkerEndpoint || undefined,
  });

  // Apply collected NAT profile (covers both auto-detect and tier-0 IPv6 cases).
  if (natProfile) {
    node.applyNatProfile(natProfile);
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
  });

  // GAP-6: probe backend for all available models so the registration advertises
  // the full list — not just the single configured model. Best-effort; fall back
  // to the single configured model on any error.
  try {
    const tagsUrl = opts.backendUrl.replace(/\/$/, "") + "/api/tags";
    const tagsResp = await fetch(tagsUrl, { signal: AbortSignal.timeout(3000) });
    if (tagsResp.ok) {
      const tagsData = await tagsResp.json() as { models?: Array<{ name: string }> };
      const extra = (tagsData.models ?? [])
        .map((m) => m.name)
        .filter((m) => m !== opts.model);
      if (extra.length > 0) {
        node["_cfg"].capabilities = extra;
        // eslint-disable-next-line no-console
        console.log(`[iicp-node] GAP-6: advertising ${extra.length} additional model(s): ${extra.slice(0, 6).join(", ")}`);
      }
    }
  } catch {
    // best-effort; no-op on error
  }

  let token: string | undefined;
  if (!opts.skipRegistration) {
    try {
      token = await node.register();
      // eslint-disable-next-line no-console
      console.log(`[iicp-node] registered as ${nodeId} (token=${(token ?? "").slice(0, 8)}…)`);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      // eslint-disable-next-line no-console
      console.warn(`[iicp-node] registration failed: ${msg} — continuing without heartbeat`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[iicp-node] serving ${opts.intent} on ${opts.host}:${opts.port} — ` +
      `backend ${opts.backendUrl} (model=${opts.model}, max_concurrent=${opts.maxConcurrent})`,
  );
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
        }
      } catch (exc) {
        // eslint-disable-next-line no-console
        console.warn(`[iicp-node] deregister failed: ${exc instanceof Error ? exc.message : exc}`);
      }
      stop();
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
  // generate unused nodeId silently to keep the helper imported in --help-only paths
  void randomUUID;
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return argv.length === 0 ? 2 : 0;
  }

  const cmd = argv[0];
  if (cmd === "init") return runInit();
  if (cmd === "list") return runList();
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
      "auto-detect-nat": { type: "boolean" },
      "external-ip-probe-url": { type: "string" },
      "relay-worker-endpoint": { type: "string" },
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
    host: (values.host as string | undefined) ?? envOr("IICP_HOST", "0.0.0.0")!,
    skipRegistration:
      Boolean(values["skip-registration"]) || envBool("IICP_SKIP_REGISTRATION"),
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

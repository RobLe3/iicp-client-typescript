#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * iicp-node — turn @iicp/client into a runnable provider node.
 *
 * Usage:
 *   iicp-node serve --model qwen2.5:0.5b --backend-url http://localhost:11434
 *
 * All flags also read from env (IICP_BACKEND_URL, IICP_BACKEND_MODEL,
 * IICP_PUBLIC_ENDPOINT, IICP_DIRECTORY_URL, IICP_REGION,
 * IICP_MAX_CONCURRENT, IICP_NODE_ID, IICP_INTENT, IICP_PORT, IICP_HOST).
 *
 * Mirrors iicp_client.cli (Python) so operators choosing TypeScript get the
 * same one-liner setup path.
 */
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { IicpNode } from "./node.js";
import { openaiCompatHandler } from "./backends/openai_compat.js";

interface ServeOpts {
  backendUrl: string;
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

function printHelp(): void {
  process.stdout.write(
    `usage: iicp-node serve [options]\n\n` +
      `Run an IICP provider node backed by an OpenAI-compatible server.\n\n` +
      `Required (flag or env):\n` +
      `  --backend-url URL         IICP_BACKEND_URL — Ollama / vLLM / LM Studio endpoint\n` +
      `  --model NAME              IICP_BACKEND_MODEL — model name (e.g. qwen2.5:0.5b)\n\n` +
      `Optional:\n` +
      `  --public-endpoint URL     IICP_PUBLIC_ENDPOINT — externally reachable URL of this node\n` +
      `  --directory-url URL       IICP_DIRECTORY_URL (default https://iicp.network/api)\n` +
      `  --region REGION           IICP_REGION (default eu-central)\n` +
      `  --intent URN              IICP_INTENT (default urn:iicp:intent:llm:chat:v1)\n` +
      `  --max-concurrent N        IICP_MAX_CONCURRENT (default 4)\n` +
      `  --node-id ID              IICP_NODE_ID (auto-generated if absent)\n` +
      `  --port N                  IICP_PORT (default 8020)\n` +
      `  --host HOST               IICP_HOST (default 0.0.0.0)\n` +
      `  --skip-registration       IICP_SKIP_REGISTRATION — register-free dev mode\n`,
  );
}

async function runServe(opts: ServeOpts): Promise<number> {
  if (!opts.backendUrl || !opts.model) {
    process.stderr.write(
      "ERROR: --backend-url and --model are required (or IICP_BACKEND_URL / IICP_BACKEND_MODEL).\n",
    );
    return 2;
  }
  const nodeId =
    opts.nodeId ||
    `sdk-${opts.model.replace(/:/g, "-")}-${randomBytes(4).toString("hex")}`;
  const publicEndpoint = opts.publicEndpoint || `http://localhost:${opts.port}`;

  const node = new IicpNode({
    nodeId,
    endpoint: publicEndpoint,
    intent: opts.intent,
    model: opts.model,
    region: opts.region,
    directoryUrl: opts.directoryUrl,
    maxConcurrent: opts.maxConcurrent,
  });
  const handler = openaiCompatHandler({
    baseUrl: opts.backendUrl,
    model: opts.model,
  });

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
    const shutdown = (sig: string) => {
      // eslint-disable-next-line no-console
      console.log(`[iicp-node] ${sig} received — shutting down`);
      stop();
      resolve();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] !== "serve") {
    process.stderr.write(`unknown command: ${argv[0]}\n`);
    printHelp();
    return 2;
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      "backend-url": { type: "string" },
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
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    printHelp();
    return 0;
  }
  const opts: ServeOpts = {
    backendUrl: (values["backend-url"] as string | undefined) ?? envOr("IICP_BACKEND_URL") ?? "",
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
        : envInt("IICP_PORT", 8020),
    host: (values.host as string | undefined) ?? envOr("IICP_HOST", "0.0.0.0")!,
    skipRegistration:
      Boolean(values["skip-registration"]) ||
      (envOr("IICP_SKIP_REGISTRATION", "false") ?? "").toLowerCase() === "true",
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

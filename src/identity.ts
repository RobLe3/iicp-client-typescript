// SPDX-License-Identifier: Apache-2.0
/**
 * Persistent on-disk identity for the IICP TypeScript SDK CLI.
 *
 * Mirrors iicp_client.identity (Python) so operators get the same
 * persisted operator + node files regardless of which SDK they pick.
 *
 *  - Operator identity at ~/.iicp/operator.json (one per machine)
 *  - Node identity at ~/.iicp/nodes/<name>.json (one per provider node)
 *
 * Stable node_id survives restarts (#215). Files are chmod 0600 on
 * creation so other local users can't read tokens / identity.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function chmod600(p: string): void {
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // Windows / WSL no-op
  }
}

export function configDir(): string {
  const base = process.env.IICP_HOME;
  const dir = base
    ? path.resolve(base.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), ".iicp");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "nodes"), { recursive: true });
  return dir;
}

export interface OperatorIdentity {
  operator_id: string;
  created_at: string;
  display_name: string;
  contact: string;
}

export function generateOperator(opts: { display_name?: string; contact?: string } = {}): OperatorIdentity {
  return {
    operator_id: `op-${randomUUID()}`,
    created_at: nowIso(),
    display_name: opts.display_name ?? "",
    contact: opts.contact ?? "",
  };
}

export function operatorPath(): string {
  return path.join(configDir(), "operator.json");
}

export function loadOperator(): OperatorIdentity | null {
  const p = operatorPath();
  if (!fs.existsSync(p)) return null;
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  return {
    operator_id: data.operator_id,
    created_at: data.created_at,
    display_name: data.display_name ?? "",
    contact: data.contact ?? "",
  };
}

export function saveOperator(op: OperatorIdentity): string {
  const p = operatorPath();
  fs.writeFileSync(p, JSON.stringify(op, null, 2) + "\n");
  chmod600(p);
  return p;
}

export interface NodeIdentity {
  node_id: string;
  operator_id: string;
  name: string;
  backend_url: string;
  model: string;
  intent: string;
  region: string;
  directory_url: string;
  max_concurrent: number;
  port: number;
  host: string;
  public_endpoint: string;
  auto_detect_nat: boolean;
  external_ip_probe_url: string;
  /**
   * #456 — node_token cached after register so `iicp-node credits` can authenticate
   * without re-registering. Bearer credential (not a key); stored in the chmod-0600
   * config. Optional — absent until the node first registers via `serve`.
   */
  node_token?: string;
  created_at: string;
}

function validateName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid node name "${name}" — must match [a-z0-9][a-z0-9._-]{0,62}`);
  }
  return name;
}

export function generateNode(opts: {
  operator_id: string;
  name: string;
  backend_url: string;
  model: string;
  intent?: string;
  region?: string;
  directory_url?: string;
  max_concurrent?: number;
  port?: number;
  host?: string;
  public_endpoint?: string;
  auto_detect_nat?: boolean;
  external_ip_probe_url?: string;
}): NodeIdentity {
  return {
    node_id: randomUUID(),
    operator_id: opts.operator_id,
    name: validateName(opts.name),
    backend_url: opts.backend_url,
    model: opts.model,
    intent: opts.intent ?? "urn:iicp:intent:llm:chat:v1",
    region: opts.region ?? "eu-central",
    directory_url: opts.directory_url ?? "https://iicp.network/api",
    max_concurrent: opts.max_concurrent ?? 4,
    port: opts.port ?? 8020,
    host: opts.host ?? "0.0.0.0",
    public_endpoint: opts.public_endpoint ?? "",
    auto_detect_nat: opts.auto_detect_nat ?? false,
    external_ip_probe_url: opts.external_ip_probe_url ?? "",
    created_at: nowIso(),
  };
}

export function nodePath(name: string): string {
  return path.join(configDir(), "nodes", `${validateName(name)}.json`);
}

export function loadNode(name: string): NodeIdentity | null {
  const p = nodePath(name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as NodeIdentity;
}

export function saveNode(node: NodeIdentity): string {
  const p = nodePath(node.name);
  fs.writeFileSync(p, JSON.stringify(node, null, 2) + "\n");
  chmod600(p);
  return p;
}

export function listNodes(): NodeIdentity[] {
  const nodesDir = path.join(configDir(), "nodes");
  if (!fs.existsSync(nodesDir)) return [];
  const out: NodeIdentity[] = [];
  const files = fs.readdirSync(nodesDir).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(nodesDir, f), "utf-8")) as NodeIdentity);
    } catch {
      // Malformed — skip
    }
  }
  return out;
}

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
import {
  randomUUID,
  generateKeyPairSync,
  createPrivateKey,
  createHash,
  type KeyObject,
} from "node:crypto";
import {
  decryptSeed,
  encryptSeed,
  passphraseFromEnv,
  type EncryptedSecret,
} from "./operator_crypto.js";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

// #464 — PKCS8 DER prefix for an ed25519 private key (16 bytes); + 32 raw seed bytes = 48.
// Lets us reconstruct the signing KeyObject from the stored base64 seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

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

/**
 * #464 — the operator identity is an ed25519 keypair: `operator_id` IS the base64 public
 * key (== the directory's `operator_pubkey` via the ADR-045 delegation), so it is
 * cryptographically verifiable rather than a random UUID. `operator_secret` is the base64
 * 32-byte private seed — LOCAL ONLY (0600 file), never sent to the directory (password-at-rest
 * = #460). `operator_integrity_hash` binds the immutable fields (pinned by the directory on
 * first-use; the directory's own clock — not `created_at` — is authoritative for founder
 * ordinals). `display_name` is the public, mutable handle; `contact` is private.
 */
export interface OperatorIdentity {
  operator_id: string;
  created_at: string;
  display_name: string;
  contact: string;
  operator_secret?: string;
  operator_integrity_hash?: string;
  // #460 — AES-256-GCM-sealed seed when the operator opts into at-rest encryption.
  operator_secret_enc?: EncryptedSecret;
}

export function computeOperatorIntegrityHash(operatorId: string, createdAt: string): string {
  return createHash("sha256").update(`${operatorId}:${createdAt}`).digest("hex");
}

export function generateOperator(opts: { display_name?: string; contact?: string } = {}): OperatorIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privDer = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  const operator_id = Buffer.from(pubDer.subarray(pubDer.length - 32)).toString("base64");
  const operator_secret = Buffer.from(privDer.subarray(privDer.length - 32)).toString("base64");
  const created_at = nowIso();
  return {
    operator_id,
    created_at,
    display_name: opts.display_name ?? "",
    contact: opts.contact ?? "",
    operator_secret,
    operator_integrity_hash: computeOperatorIntegrityHash(operator_id, created_at),
  };
}

/** True when operator_id is a real ed25519 pubkey (not a legacy op-<uuid>). */
export function operatorIsKeyBacked(op: OperatorIdentity): boolean {
  return (!!op.operator_secret || !!op.operator_secret_enc) && !op.operator_id.startsWith("op-");
}

/** #460 — true when the seed is sealed at rest and a passphrase is needed to sign. */
export function operatorIsEncrypted(op: OperatorIdentity): boolean {
  return !!op.operator_secret_enc && !op.operator_secret;
}

/** Resolve the base64 seed: plaintext if present, else decrypt the sealed seed with
 *  `passphrase` (falling back to $IICP_OPERATOR_PASSPHRASE for headless serve). */
function operatorSeedB64(op: OperatorIdentity, passphrase?: string): string {
  if (op.operator_secret) return op.operator_secret;
  if (op.operator_secret_enc) {
    const pw = passphrase ?? passphraseFromEnv();
    if (!pw) {
      throw new Error(
        "operator secret is encrypted — set $IICP_OPERATOR_PASSPHRASE (or pass a passphrase) to unlock it (#460)",
      );
    }
    return decryptSeed(pw, op.operator_secret_enc, op.operator_id);
  }
  throw new Error(
    "legacy operator identity has no key (operator_id is a UUID, not a public key) — regenerate (#464)",
  );
}

/** The ed25519 signing key (KeyObject) for delegations / mutations. Decrypts the sealed seed
 *  when the identity is encrypted (#460). Throws on a legacy keyless identity (regenerate). */
export function operatorSigningKey(op: OperatorIdentity, passphrase?: string): KeyObject {
  const seed = operatorSeedB64(op, passphrase);
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed, "base64")]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** #460 — return a copy with the seed sealed under `passphrase` (operator_secret cleared). */
export function operatorEncryptAtRest(op: OperatorIdentity, passphrase: string): OperatorIdentity {
  const enc = encryptSeed(passphrase, operatorSeedB64(op), op.operator_id);
  return { ...op, operator_secret: "", operator_secret_enc: enc };
}

/** #460 — return a copy with the plaintext seed restored (operator_secret_enc cleared). */
export function operatorDecryptAtRest(op: OperatorIdentity, passphrase: string): OperatorIdentity {
  const seed = operatorSeedB64(op, passphrase);
  const copy = { ...op, operator_secret: seed };
  delete copy.operator_secret_enc;
  return copy;
}

/** Directory-safe view: never includes operator_secret or contact (private). */
export function operatorPublicView(op: OperatorIdentity): Record<string, string> {
  return {
    operator_id: op.operator_id,
    created_at: op.created_at,
    display_name: op.display_name,
    operator_integrity_hash: op.operator_integrity_hash ?? "",
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
    // #464 — present on key-backed identities; absent on legacy op-<uuid> files.
    operator_secret: data.operator_secret ?? undefined,
    operator_integrity_hash: data.operator_integrity_hash ?? undefined,
    // #460 — sealed seed when the operator opted into at-rest encryption.
    operator_secret_enc: data.operator_secret_enc ?? undefined,
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
  /**
   * TC-9c — HMAC key for CIPWorkerReceipt signing. Returned by the directory on
   * registration and persisted here so receipts work immediately on restart without
   * waiting for the next re-registration cycle. Absent until first `serve`.
   */
  node_hmac_key?: string;
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
    region: opts.region ?? "unknown",
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

// #503 — printed to stderr when serve/register runs without a key-backed operator
// identity. An anonymous node accrues NO founder/recognition standing and nothing
// else in the flow would ever tell the operator (the first external operator was
// silently invisible to the founders program for 3 days).
export const NO_IDENTITY_NOTICE =
  "NOTICE: no operator identity - this node is registering anonymously.\n" +
  "        You will NOT accrue founder or recognition standing.\n" +
  "        Run `iicp-node init` (takes 30 seconds), then restart, to start\n" +
  "        your founder clock. Docs: https://iicp.network/docs/operator-identity";

/**
 * The #503 anonymous-registration notice, or null when the identity is fine.
 * Fires for BOTH the no-identity case and the legacy keyless case (a UUID
 * identity cannot sign a delegation, so the node is anonymous either way).
 */
export function noIdentityNotice(op: OperatorIdentity | null): string | null {
  if (op === null || !operatorIsKeyBacked(op)) return NO_IDENTITY_NOTICE;
  return null;
}

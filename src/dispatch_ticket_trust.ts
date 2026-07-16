import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  lstatSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const DISPATCH_TICKET_V2_PROFILE = "dispatch_ticket_v2";
const DOMAIN = Buffer.from("IICP-DISPATCH-TICKET-V2\0", "utf8");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface DispatchTrustKey {
  key_id: string;
  public_key_b64url: string;
  state: "active" | "retiring" | "revoked";
  valid_from: number;
  valid_until: number;
  allowed_profiles?: string[];
  issuers?: string[];
  audiences?: string[];
}

export interface DispatchTrustBundle {
  bundle_version: number;
  keys: DispatchTrustKey[];
  issuer?: string;
  valid_from?: number;
  valid_until?: number;
}

export interface DispatchTicketBindings {
  issuer: string;
  provider_id: string;
  intent: string;
  constraints_digest: string;
  audience?: string;
}

export interface DispatchTrustDecision {
  accepted: boolean;
  code: string;
  anchored: boolean;
  key_id?: string;
}

export interface StoredDispatchTrustBundle {
  bundle: DispatchTrustBundle;
  canonical_bytes: Buffer;
  digest: string;
  high_water: number;
}

export type TrustBundleInstallStatus = "installed" | "unchanged" | "stale" | "conflict" | "recovered" | "recovery_required";

export interface TrustBundleInstallResult {
  status: TrustBundleInstallStatus;
  state?: StoredDispatchTrustBundle;
}

export interface AdminRecoveryAuthorization {
  reason: string;
  minimum_high_water?: number;
}

export interface TrustBundleStore {
  load(): StoredDispatchTrustBundle | undefined;
  install(bundle: DispatchTrustBundle, expectedCurrentVersion?: number): TrustBundleInstallResult;
  recover(bundle: DispatchTrustBundle, authorization?: AdminRecoveryAuthorization): TrustBundleInstallResult;
}

export class TrustBundleStoreError extends Error {}
export class TrustBundleStoreCorrupt extends TrustBundleStoreError {}
export class TrustBundleStoreLocked extends TrustBundleStoreError {}

export class LocalDispatchReplayCache {
  private readonly seen = new Map<string, number>();

  contains(jti: string, now: number): boolean {
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
    return this.seen.has(jti);
  }

  remember(jti: string, expiresAt: number): void {
    this.seen.set(jti, expiresAt);
  }
}

export function canonicalTicketClaims(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTicketClaims).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalTicketClaims(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalDispatchTrustBundle(bundle: DispatchTrustBundle): Buffer {
  const normalized: Record<string, Json> = {
    bundle_version: bundle.bundle_version,
    keys: [...bundle.keys]
      .sort((a, b) => a.key_id.localeCompare(b.key_id))
      .map((key) => ({
        key_id: key.key_id,
        public_key_b64url: key.public_key_b64url,
        state: key.state,
        valid_from: key.valid_from,
        valid_until: key.valid_until,
        allowed_profiles: [...(key.allowed_profiles ?? [DISPATCH_TICKET_V2_PROFILE])].sort(),
        issuers: [...(key.issuers ?? [])].sort(),
        audiences: [...(key.audiences ?? [])].sort(),
      })),
  };
  if (bundle.issuer !== undefined) normalized.issuer = bundle.issuer;
  if (bundle.valid_from !== undefined) normalized.valid_from = bundle.valid_from;
  if (bundle.valid_until !== undefined) normalized.valid_until = bundle.valid_until;
  return Buffer.from(canonicalTicketClaims(normalized), "utf8");
}

function bundleDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sleepMilliseconds(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export class FileDispatchTrustBundleStore implements TrustBundleStore {
  readonly path: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;

  constructor(path: string, options: { lockTimeoutMs?: number } = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.lockTimeoutMs = Math.max(0, options.lockTimeoutMs ?? 2_000);
  }

  private prepareDirectory(): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if ((statSync(directory).mode & 0o077) !== 0) throw new TrustBundleStoreError("trust store directory must be owner-only");
  }

  private acquireLock(): number {
    this.prepareDirectory();
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        const fd = openSync(this.lockPath, "wx", 0o600);
        writeFileSync(fd, `${process.pid}\n`);
        fsyncSync(fd);
        return fd;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new TrustBundleStoreLocked("trust store lock is held");
        sleepMilliseconds(10);
      }
    }
  }

  private releaseLock(fd: number): void {
    closeSync(fd);
    try { unlinkSync(this.lockPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  load(): StoredDispatchTrustBundle | undefined {
    if (!existsSync(this.path)) return undefined;
    const metadata = lstatSync(this.path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new TrustBundleStoreCorrupt("trust store must be a regular file, not a link");
    if ((metadata.mode & 0o077) !== 0) throw new TrustBundleStoreCorrupt("trust store file must be owner-only");
    try {
      const raw = readFileSync(this.path);
      if (raw.length > 4 * 1024 * 1024) throw new Error("state exceeds size limit");
      const state = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      if (typeof state.bundle_b64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(state.bundle_b64)) {
        throw new Error("invalid bundle base64");
      }
      const canonicalBytes = Buffer.from(state.bundle_b64, "base64");
      const digest = bundleDigest(canonicalBytes);
      if (digest !== state.bundle_digest) throw new Error("bundle digest mismatch");
      const bundle = JSON.parse(canonicalBytes.toString("utf8")) as DispatchTrustBundle;
      const highWater = Number(state.high_water);
      if (!Number.isSafeInteger(bundle.bundle_version) || bundle.bundle_version < 0 || state.bundle_version !== bundle.bundle_version || !Number.isSafeInteger(highWater) || highWater < bundle.bundle_version) {
        throw new Error("bundle version/high-water mismatch");
      }
      if (!canonicalDispatchTrustBundle(bundle).equals(canonicalBytes)) throw new Error("bundle is not canonical");
      return { bundle, canonical_bytes: canonicalBytes, digest, high_water: highWater };
    } catch (error) {
      if (error instanceof TrustBundleStoreCorrupt) throw error;
      throw new TrustBundleStoreCorrupt(`invalid trust store: ${(error as Error).message}`);
    }
  }

  private commit(bundle: DispatchTrustBundle, highWater: number): StoredDispatchTrustBundle {
    if (!Number.isSafeInteger(bundle.bundle_version) || bundle.bundle_version < 0 || !Number.isSafeInteger(highWater) || highWater < bundle.bundle_version) {
      throw new TrustBundleStoreError("bundle version and high-water mark must be non-negative safe integers");
    }
    const canonicalBytes = canonicalDispatchTrustBundle(bundle);
    const digest = bundleDigest(canonicalBytes);
    const state = {
      bundle_b64: canonicalBytes.toString("base64"),
      bundle_digest: digest,
      bundle_version: bundle.bundle_version,
      high_water: highWater,
    };
    const payload = Buffer.from(canonicalTicketClaims(state as unknown as Json), "utf8");
    const temporary = join(dirname(this.path), `${basename(this.path)}.tmp-${process.pid}-${randomUUID()}`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
      try {
        const directoryFd = openSync(dirname(this.path), "r");
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      } catch {
        // Some platforms do not allow fsync on a directory; atomic rename still applies.
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return { bundle, canonical_bytes: canonicalBytes, digest, high_water: highWater };
  }

  install(bundle: DispatchTrustBundle, expectedCurrentVersion?: number): TrustBundleInstallResult {
    if (!Number.isSafeInteger(bundle.bundle_version) || bundle.bundle_version < 0) {
      throw new TrustBundleStoreError("bundle version must be a non-negative safe integer");
    }
    const fd = this.acquireLock();
    try {
      const current = this.load();
      const currentVersion = current?.bundle.bundle_version;
      if (expectedCurrentVersion !== undefined && expectedCurrentVersion !== currentVersion) return { status: "conflict", state: current };
      const candidateDigest = bundleDigest(canonicalDispatchTrustBundle(bundle));
      const highWater = current?.high_water ?? 0;
      if (bundle.bundle_version < highWater) return { status: "stale", state: current };
      if (current && bundle.bundle_version === currentVersion) {
        return { status: candidateDigest === current.digest ? "unchanged" : "conflict", state: current };
      }
      return { status: "installed", state: this.commit(bundle, Math.max(highWater, bundle.bundle_version)) };
    } finally {
      this.releaseLock(fd);
    }
  }

  recover(bundle: DispatchTrustBundle, authorization?: AdminRecoveryAuthorization): TrustBundleInstallResult {
    if (!Number.isSafeInteger(bundle.bundle_version) || bundle.bundle_version < 0) {
      throw new TrustBundleStoreError("bundle version must be a non-negative safe integer");
    }
    if (!authorization?.reason.trim()) return { status: "recovery_required" };
    const fd = this.acquireLock();
    try {
      let current: StoredDispatchTrustBundle | undefined;
      try { current = this.load(); } catch (error) {
        if (!(error instanceof TrustBundleStoreCorrupt)) throw error;
      }
      const highWater = Math.max(bundle.bundle_version, authorization.minimum_high_water ?? 0, current?.high_water ?? 0);
      return { status: "recovered", state: this.commit(bundle, highWater) };
    } finally {
      this.releaseLock(fd);
    }
  }
}

function decision(code: string, keyId?: string, accepted = false): DispatchTrustDecision {
  return { accepted, code, anchored: accepted, ...(keyId ? { key_id: keyId } : {}) };
}

export function verifyDispatchTicketV2(
  claims: Record<string, Json>,
  signatureB64url: string,
  bundle: DispatchTrustBundle,
  bindings: DispatchTicketBindings,
  options: { now: number; minimumBundleVersion?: number; replayCache?: LocalDispatchReplayCache },
): DispatchTrustDecision {
  const minimum = options.minimumBundleVersion ?? 0;
  if (!Number.isSafeInteger(bundle.bundle_version) || bundle.bundle_version < minimum) return decision("reject_bundle_rollback");
  if (bundle.valid_from !== undefined && options.now < bundle.valid_from) return decision("reject_bundle_not_yet_valid");
  if (bundle.valid_until !== undefined && options.now > bundle.valid_until) return decision("reject_bundle_expired");
  if (claims.profile !== DISPATCH_TICKET_V2_PROFILE) return decision("reject_required_profile_downgrade");
  const keyId = typeof claims.key_id === "string" ? claims.key_id : undefined;
  const key = keyId ? bundle.keys.find((candidate) => candidate.key_id === keyId) : undefined;
  if (!key) return decision("reject_unknown_key", keyId);
  if (key.state === "revoked") return decision("reject_key_revoked", keyId);
  if (options.now < key.valid_from || options.now > key.valid_until) return decision("reject_key_expired", keyId);
  if (!(key.allowed_profiles ?? [DISPATCH_TICKET_V2_PROFILE]).includes(DISPATCH_TICKET_V2_PROFILE)) return decision("reject_profile_not_allowed", keyId);
  if (key.issuers?.length && !key.issuers.includes(String(claims.issuer))) return decision("reject_issuer", keyId);
  if (key.audiences?.length && !key.audiences.includes(String(claims.audience))) return decision("reject_audience", keyId);
  const expected: Record<string, string> = {
    issuer: bindings.issuer,
    provider_id: bindings.provider_id,
    intent: bindings.intent,
    constraints_digest: bindings.constraints_digest,
  };
  if (Object.entries(expected).some(([name, value]) => claims[name] !== value)) return decision("reject_claim_mismatch", keyId);
  if (bindings.audience !== undefined && claims.audience !== bindings.audience) return decision("reject_claim_mismatch", keyId);
  const expiresAt = claims.expires_at;
  const jti = claims.jti;
  if (!Number.isSafeInteger(expiresAt) || Number(expiresAt) <= options.now || typeof jti !== "string" || !jti) return decision("reject_claim_mismatch", keyId);
  try {
    const raw = Buffer.from(key.public_key_b64url, "base64url");
    if (raw.length !== 32) return decision("reject_signature", keyId);
    const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    const message = Buffer.concat([DOMAIN, Buffer.from(canonicalTicketClaims(claims), "utf8")]);
    if (!verify(null, message, publicKey, Buffer.from(signatureB64url, "base64url"))) return decision("reject_signature", keyId);
  } catch {
    return decision("reject_signature", keyId);
  }
  if (options.replayCache?.contains(jti, options.now)) return decision("reject_local_replay", keyId);
  options.replayCache?.remember(jti, Number(expiresAt));
  return decision("accept_anchored", keyId, true);
}

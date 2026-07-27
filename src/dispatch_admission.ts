// SPDX-License-Identifier: Apache-2.0
/**
 * Provider-local admission for the pre-normative dispatch-v2 profile.
 *
 * This module is deliberately not mounted by IicpNode. A caller must verify
 * dispatch-ticket trust first, then explicitly invoke this adapter. The store
 * retains content-free redemption state and never contacts a Directory,
 * relay, or inference backend.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

interface SqliteStatement {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface DatabaseSyncConstructor {
  new(path: string, options?: { timeout?: number }): SqliteDatabase;
}

const load = createRequire(__filename);

export const DISPATCH_ADMISSION_V2_PROFILE = "urn:iicp:profile:dispatch-admission:v2";
export const TERMINAL_ADMISSION_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
  "rejected",
]);

const JTI = /^[A-Za-z0-9._:-]{16,256}$/;

export interface DispatchAdmissionClaim {
  jti: string;
  provider_id: string;
  intent: string;
  not_before: number;
  expires_at: number;
}

export interface DispatchAdmissionDecision {
  code: string;
  accepted: boolean;
  state?: string;
}

export interface DispatchAdmissionRecord {
  jti: string;
  provider_digest: string;
  intent_digest: string;
  state: string;
  expires_at: number;
  consumed_at: number;
  updated_at: number;
}

export interface DispatchAdmissionStore {
  consume(
    claim: DispatchAdmissionClaim,
    expectedProviderId: string,
    expectedIntent: string,
    now: number,
    clockSkewSeconds?: number,
  ): DispatchAdmissionDecision;
  transition(jti: string, state: string, now: number): DispatchAdmissionRecord;
  cleanup(now: number, retentionSeconds: number, limit: number): number;
  lookup(jti: string): DispatchAdmissionRecord | undefined;
}

export class DispatchAdmissionStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchAdmissionStorageError";
  }
}

export function evaluateDispatchAdmission(
  store: DispatchAdmissionStore,
  claim: DispatchAdmissionClaim,
  options: {
    expectedProviderId: string;
    expectedIntent: string;
    now: number;
    trustVerified: boolean;
    clockSkewSeconds?: number;
  },
): DispatchAdmissionDecision {
  if (!options.trustVerified) {
    return rejected("reject_issuer_key");
  }
  try {
    return store.consume(
      claim,
      options.expectedProviderId,
      options.expectedIntent,
      options.now,
      options.clockSkewSeconds ?? 0,
    );
  } catch (error) {
    if (error instanceof DispatchAdmissionStorageError) {
      return rejected("reject_store_unavailable");
    }
    throw error;
  }
}

export class SqliteDispatchAdmissionStore implements DispatchAdmissionStore {
  static readonly SCHEMA_VERSION = 1;

  readonly path: string;
  readonly busyTimeoutMs: number;

  constructor(path: string, options: { busyTimeoutMs?: number } = {}) {
    this.path = resolve(path);
    this.busyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5_000));
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const db = this.connect();
      try {
        const version = Number(
          (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        );
        if (version !== 0 && version !== SqliteDispatchAdmissionStore.SCHEMA_VERSION) {
          throw new DispatchAdmissionStorageError(
            `unsupported dispatch admission database version ${version}`,
          );
        }
        db.exec(`
          CREATE TABLE IF NOT EXISTS dispatch_admissions (
            jti TEXT PRIMARY KEY,
            provider_digest TEXT NOT NULL,
            intent_digest TEXT NOT NULL,
            state TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            consumed_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS dispatch_admissions_expiry
            ON dispatch_admissions(expires_at);
          PRAGMA user_version=1;
        `);
      } finally {
        db.close();
      }
      if (process.platform !== "win32") {
        chmodSync(this.path, 0o600);
      }
    } catch (error) {
      if (error instanceof DispatchAdmissionStorageError) throw error;
      throw storageError(error);
    }
  }

  consume(
    claim: DispatchAdmissionClaim,
    expectedProviderId: string,
    expectedIntent: string,
    now: number,
    clockSkewSeconds = 0,
  ): DispatchAdmissionDecision {
    const skew = Math.max(0, Math.trunc(clockSkewSeconds));
    if (!JTI.test(claim.jti)) return rejected("reject_invalid_jti");
    if (claim.provider_id !== expectedProviderId) return rejected("reject_provider_binding");
    if (claim.intent !== expectedIntent) return rejected("reject_intent_binding");
    if (now + skew < claim.not_before) return rejected("reject_not_yet_valid");
    if (now - skew >= claim.expires_at) return rejected("reject_expired");

    const db = this.connect();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare("SELECT * FROM dispatch_admissions WHERE jti=?")
          .get(claim.jti) as DispatchAdmissionRecord | undefined;
        if (existing) {
          db.exec("COMMIT");
          return {
            code: TERMINAL_ADMISSION_STATES.has(existing.state)
              ? "reject_terminal"
              : "reject_replay",
            accepted: false,
            state: existing.state,
          };
        }
        db.prepare(
          "INSERT INTO dispatch_admissions VALUES(?,?,?,?,?,?,?)",
        ).run(
          claim.jti,
          digest(claim.provider_id),
          digest(claim.intent),
          "accepted",
          claim.expires_at,
          now,
          now,
        );
        db.exec("COMMIT");
        return { code: "accepted", accepted: true, state: "accepted" };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      throw storageError(error);
    } finally {
      db.close();
    }
  }

  transition(jti: string, state: string, now: number): DispatchAdmissionRecord {
    if (!TERMINAL_ADMISSION_STATES.has(state)) {
      throw new RangeError(`unsupported terminal admission state: ${state}`);
    }
    const db = this.connect();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare("SELECT * FROM dispatch_admissions WHERE jti=?")
          .get(jti) as DispatchAdmissionRecord | undefined;
        if (!existing) throw new RangeError(`unknown dispatch admission: ${jti}`);
        if (TERMINAL_ADMISSION_STATES.has(existing.state) && existing.state !== state) {
          throw new RangeError(`admission already terminal as ${existing.state}`);
        }
        if (existing.state !== state) {
          db.prepare(
            "UPDATE dispatch_admissions SET state=?,updated_at=? WHERE jti=?",
          ).run(state, now, jti);
        }
        const record = db
          .prepare("SELECT * FROM dispatch_admissions WHERE jti=?")
          .get(jti) as DispatchAdmissionRecord;
        db.exec("COMMIT");
        return record;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (error instanceof RangeError) throw error;
      throw storageError(error);
    } finally {
      db.close();
    }
  }

  cleanup(now: number, retentionSeconds: number, limit: number): number {
    const cutoff = now - Math.max(0, Math.trunc(retentionSeconds));
    const boundedLimit = Math.max(1, Math.trunc(limit));
    const db = this.connect();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const changes = db.prepare(`
          DELETE FROM dispatch_admissions WHERE jti IN (
            SELECT jti FROM dispatch_admissions
            WHERE expires_at < ? ORDER BY expires_at LIMIT ?
          )
        `).run(cutoff, boundedLimit).changes;
        db.exec("COMMIT");
        return Number(changes);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      throw storageError(error);
    } finally {
      db.close();
    }
  }

  lookup(jti: string): DispatchAdmissionRecord | undefined {
    const db = this.connect();
    try {
      return db
        .prepare("SELECT * FROM dispatch_admissions WHERE jti=?")
        .get(jti) as DispatchAdmissionRecord | undefined;
    } catch (error) {
      throw storageError(error);
    } finally {
      db.close();
    }
  }

  private connect(): SqliteDatabase {
    try {
      const sqlite = load("node:sqlite") as {
        DatabaseSync: DatabaseSyncConstructor;
      };
      const db = new sqlite.DatabaseSync(this.path, { timeout: this.busyTimeoutMs });
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=FULL");
      db.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs}`);
      return db;
    } catch (error) {
      throw storageError(error);
    }
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function rejected(code: string): DispatchAdmissionDecision {
  return { code, accepted: false };
}

function storageError(error: unknown): DispatchAdmissionStorageError {
  return error instanceof DispatchAdmissionStorageError
    ? error
    : new DispatchAdmissionStorageError(error instanceof Error ? error.message : String(error));
}

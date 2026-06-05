// SPDX-License-Identifier: Apache-2.0
/**
 * #460 — at-rest encryption of the operator secret (ed25519 seed) in `operator.json`.
 *
 * The operator_secret is the private key behind the operator_id; by default it is stored as
 * plaintext base64 in a 0600 file. An operator may opt in to passphrase encryption: the seed
 * is sealed with AES-256-GCM, the key derived from the passphrase with PBKDF2-HMAC-SHA256
 * (OWASP-2023 iteration count). Both primitives are Node built-ins (`node:crypto`) — no new
 * dependency, so this never trips the third-party due-diligence gate (TC-11).
 *
 * The encrypted record byte-shape is identical across the Python/TS/Rust SDKs — a file sealed
 * by one opens in another given the passphrase (pinned by a cross-language KAT). The
 * operator_id is bound as AES-GCM additional authenticated data (AAD): a sealed seed cannot be
 * transplanted onto a different identity. Unlock is headless via `$IICP_OPERATOR_PASSPHRASE`.
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

/** OWASP 2023 minimum for PBKDF2-HMAC-SHA256. Stored in the record so it can be raised later. */
export const PBKDF2_ITERATIONS = 600000;
const KDF = "pbkdf2-hmac-sha256";
const VERSION = 1;
export const ENV_PASSPHRASE = "IICP_OPERATOR_PASSPHRASE";

export interface EncryptedSecret {
  v: number;
  kdf: string;
  iter: number;
  salt: string;
  nonce: string;
  ct: string; // base64(ciphertext || 16-byte GCM tag) — matches Python cryptography AESGCM
}

function deriveKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, iterations, 32, "sha256");
}

/** Seal the raw 32-byte ed25519 seed (given as base64) under `passphrase`. operator_id is AAD. */
export function encryptSeed(passphrase: string, seedB64: string, operatorId: string): EncryptedSecret {
  if (!passphrase) throw new Error("passphrase must not be empty");
  const seed = Buffer.from(seedB64, "base64");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(operatorId, "utf8"));
  const body = Buffer.concat([cipher.update(seed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: VERSION,
    kdf: KDF,
    iter: PBKDF2_ITERATIONS,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ct: Buffer.concat([body, tag]).toString("base64"),
  };
}

/** Open an encrypted record → base64 seed. Throws on wrong passphrase / tamper / wrong AAD. */
export function decryptSeed(passphrase: string, enc: EncryptedSecret, operatorId: string): string {
  if (enc.kdf !== KDF || enc.v !== VERSION) {
    throw new Error(`unsupported operator_secret_enc format: ${enc.kdf} v${enc.v}`);
  }
  const salt = Buffer.from(enc.salt, "base64");
  const nonce = Buffer.from(enc.nonce, "base64");
  const blob = Buffer.from(enc.ct, "base64");
  const body = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const key = deriveKey(passphrase, salt, enc.iter);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(operatorId, "utf8"));
  decipher.setAuthTag(tag);
  try {
    const seed = Buffer.concat([decipher.update(body), decipher.final()]);
    return seed.toString("base64");
  } catch {
    throw new Error("operator secret decryption failed (wrong passphrase or corrupt file)");
  }
}

/** Headless unlock source — never an interactive prompt for a serving node. */
export function passphraseFromEnv(): string | undefined {
  return process.env[ENV_PASSPHRASE] || undefined;
}

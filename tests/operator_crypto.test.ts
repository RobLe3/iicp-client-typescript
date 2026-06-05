// SPDX-License-Identifier: Apache-2.0
/**
 * #460 — at-rest encryption of the operator secret (AES-256-GCM / PBKDF2-HMAC-SHA256).
 *
 * Pins the cross-language KAT (a record sealed by any SDK must open in any other), the
 * identity round-trip (encrypt → sign still works → decrypt restores plaintext), AAD binding,
 * wrong-passphrase failure, and that legacy plaintext identities keep loading.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { decryptSeed, encryptSeed, type EncryptedSecret } from "../src/operator_crypto.js";
import {
  generateOperator,
  operatorDecryptAtRest,
  operatorEncryptAtRest,
  operatorIsEncrypted,
  operatorIsKeyBacked,
  operatorSigningKey,
} from "../src/identity.js";

// Cross-language KAT — MUST decrypt identically in the Python and Rust SDKs (same fixed inputs).
const PASSPHRASE = "correct horse battery staple";
const OPERATOR_ID = "T3BQdWI="; // AAD
const SEED_B64 = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";
const KAT_RECORD: EncryptedSecret = {
  v: 1,
  kdf: "pbkdf2-hmac-sha256",
  iter: 600000,
  salt: "AAECAwQFBgcICQoLDA0ODw==",
  nonce: "EBESExQVFhcYGRob",
  ct: "LDNf5jTajlDjk7Pj4N5a1SEJqNeyUuCc+wkh0fSEftCq1ypsedl8nLMPuMZQ7Xvl",
};

describe("#460 operator secret at-rest encryption (TS)", () => {
  it("opens the cross-language KAT record to the known seed", () => {
    assert.equal(decryptSeed(PASSPHRASE, KAT_RECORD, OPERATOR_ID), SEED_B64);
  });

  it("encrypt → decrypt round-trip (fresh salt/nonce differs from KAT)", () => {
    const enc = encryptSeed("hunter2", SEED_B64, OPERATOR_ID);
    assert.equal(enc.kdf, "pbkdf2-hmac-sha256");
    assert.notEqual(enc.ct, KAT_RECORD.ct);
    assert.equal(decryptSeed("hunter2", enc, OPERATOR_ID), SEED_B64);
  });

  it("wrong passphrase fails cleanly", () => {
    const enc = encryptSeed("right", SEED_B64, OPERATOR_ID);
    assert.throws(() => decryptSeed("WRONG", enc, OPERATOR_ID));
  });

  it("AAD binds the operator_id (cannot transplant a sealed seed)", () => {
    const enc = encryptSeed("pw", SEED_B64, OPERATOR_ID);
    assert.throws(() => decryptSeed("pw", enc, "different-operator-id"));
  });

  it("identity encrypt → sign (unlocked) → decrypt cycle", () => {
    const op = generateOperator({ display_name: "Padme" });
    assert.ok(!operatorIsEncrypted(op));
    const pub = op.operator_id;

    const enc = operatorEncryptAtRest(op, "s3cret");
    assert.ok(operatorIsEncrypted(enc));
    assert.equal(enc.operator_secret, "");
    assert.ok(operatorIsKeyBacked(enc));

    // Signs once unlocked (explicit passphrase here; serve uses $IICP_OPERATOR_PASSPHRASE).
    // The unlocked seed must re-derive the same operator_id pubkey.
    const sk = operatorSigningKey(enc, "s3cret");
    const pubDer = createPublicKey(sk).export({ type: "spki", format: "der" }) as Buffer;
    assert.equal(Buffer.from(pubDer.subarray(pubDer.length - 32)).toString("base64"), pub);

    const back = operatorDecryptAtRest(enc, "s3cret");
    assert.ok(!operatorIsEncrypted(back));
    assert.equal(back.operator_secret, op.operator_secret);
    assert.equal(back.operator_id, pub);
  });
});

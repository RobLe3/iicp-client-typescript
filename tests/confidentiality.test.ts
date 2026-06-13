/**
 * IICP-CX S.16 Tier-1 confidentiality tests.
 * Tests: encrypt_payload, decrypt_payload, roundtrip, error cases.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { encryptPayload, decryptPayload } from "../src/confidentiality.js";
import type { CxPublicKey } from "../src/types.js";

function generateTestKeypair(): { cxPublicKey: CxPublicKey; privBytes: Buffer; pubBytes: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  const pubBytes = Buffer.from(pubJwk.x, "base64url");
  const privBytes = Buffer.from(privJwk.d, "base64url");
  const keyId = pubBytes.slice(0, 8).toString("hex");
  return {
    cxPublicKey: { algorithm: "X25519", key: pubJwk.x, key_id: keyId },
    privBytes,
    pubBytes,
  };
}

describe("IICP-CX confidentiality", () => {
  it("encrypt produces valid envelope with all required fields", () => {
    const { cxPublicKey } = generateTestKeypair();
    const env = encryptPayload({ msg: "hello" }, cxPublicKey, "task-001", "urn:iicp:intent:llm:chat:v1");
    assert.equal(env["version"], 1);
    assert.equal(env["recipient_key_id"], cxPublicKey.key_id);
    assert.ok(env["kem_ciphertext"]);
    assert.ok(env["encrypted_body"]);
    assert.ok(env["nonce"]);
    assert.ok(env["aad"]);
    assert.ok((env["plaintext_size"] as number) > 0);
  });

  it("encrypt-decrypt roundtrip recovers original payload", () => {
    const { cxPublicKey, privBytes, pubBytes } = generateTestKeypair();
    const payload = { messages: [{ role: "user", content: "hello world" }] };
    const env = encryptPayload(payload, cxPublicKey, "task-rt1", "urn:iicp:intent:llm:chat:v1");
    const recovered = decryptPayload(env, privBytes, pubBytes);
    assert.deepEqual(recovered, payload);
  });

  it("each call produces a unique nonce", () => {
    const { cxPublicKey } = generateTestKeypair();
    const env1 = encryptPayload({ x: 1 }, cxPublicKey, "t1", "urn:iicp:intent:llm:chat:v1");
    const env2 = encryptPayload({ x: 1 }, cxPublicKey, "t1", "urn:iicp:intent:llm:chat:v1");
    assert.notEqual(env1["nonce"], env2["nonce"]);
  });

  it("decrypting with wrong key throws", () => {
    const { cxPublicKey } = generateTestKeypair();
    const { privBytes: wrongPriv, pubBytes: wrongPub } = generateTestKeypair();
    const env = encryptPayload({ x: 1 }, cxPublicKey, "t1", "urn:iicp:intent:llm:chat:v1");
    assert.throws(() => decryptPayload(env, wrongPriv, wrongPub));
  });

  it("unsupported algorithm throws", () => {
    const badKey: CxPublicKey = { algorithm: "RSA", key: "abc", key_id: "00000000" };
    assert.throws(() => encryptPayload({}, badKey, "t1", "urn:iicp:intent:llm:chat:v1"), /Unsupported/);
  });
});

describe("IICP-CX Tier-2 §5a.3 response encryption", () => {
  it("response round-trips under a shared secret", () => {
    const { randomBytes } = require("node:crypto");
    const { encryptResponse, decryptResponse } = require("../src/confidentiality.js");
    const shared = randomBytes(32);
    const resp = { choices: [{ message: { role: "assistant", content: "answer" } }] };
    const env = encryptResponse(resp, shared, "task-resp-1");
    assert.deepEqual(Object.keys(env).sort(), ["encrypted_body", "nonce", "version"]);
    assert.deepEqual(decryptResponse(env, shared, "task-resp-1"), resp);
  });
});

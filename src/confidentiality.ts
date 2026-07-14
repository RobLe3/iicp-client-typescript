/**
 * IICP-CX S.16 Tier-1 confidentiality: X25519-HKDF-SHA256 + AES-256-GCM.
 * CX-Consumer side — encrypts task payloads for nodes advertising cx_public_key.
 * Uses Node.js built-in crypto only (no external dependencies).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  diffieHellman,
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  createHash,
  randomBytes,
} from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CxPublicKey } from "./types.js";

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function cxKeyDir(): string {
  if (process.env.IICP_CX_KEY_DIR) return path.resolve(process.env.IICP_CX_KEY_DIR);
  return path.join(process.env.IICP_HOME ?? path.join(os.homedir(), ".iicp"), "cx");
}

function cxKeyPath(nodeId: string, endpoint = ""): string {
  const stable = nodeId || endpoint || "default";
  const digest = createHash("sha256").update(stable, "utf8").digest("hex").slice(0, 24);
  return path.join(cxKeyDir(), `${digest}.json`);
}

function publicKeyFromRaw(publicKeyBytes: Buffer): CxPublicKey {
  return {
    algorithm: "X25519",
    encoding: "base64url",
    key: b64urlEncode(publicKeyBytes),
    key_id: `cx-${createHash("sha256").update(publicKeyBytes).digest("hex").slice(0, 16)}`,
  };
}

export function loadOrCreateNodeCxKey(nodeId: string, endpoint = ""): {
  publicKey: CxPublicKey;
  privateKeyBytes: Buffer;
  publicKeyBytes: Buffer;
} {
  const file = cxKeyPath(nodeId, endpoint);
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { private_key: string; public_key: CxPublicKey };
    const privateKeyBytes = b64urlDecode(data.private_key);
    const publicKeyBytes = b64urlDecode(data.public_key.key);
    return { publicKey: publicKeyFromRaw(publicKeyBytes), publicKeyBytes, privateKeyBytes };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const privateKeyBytes = b64urlDecode(jwk.d);
  const publicKeyBytes = b64urlDecode(jwk.x);
  const publicKey = publicKeyFromRaw(publicKeyBytes);
  fs.writeFileSync(
    file,
    JSON.stringify(
      { version: 1, algorithm: "X25519", private_key: b64urlEncode(privateKeyBytes), public_key: publicKey },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { publicKey, publicKeyBytes, privateKeyBytes };
}

/** HKDF-SHA256 with HMAC-based extract+expand (RFC 5869). */
function hkdfSha256(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  let t = Buffer.alloc(0);
  let output = Buffer.alloc(0);
  for (let i = 1; output.length < length; i++) {
    t = createHmac("sha256", prk)
      .update(t)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    output = Buffer.concat([output, t]);
  }
  return output.slice(0, length);
}

/** Encrypt a task payload using the node's X25519 public key (CX-Consumer). */
export function encryptPayload(
  payload: unknown,
  cxPublicKey: CxPublicKey,
  taskId: string,
  intent: string,
): Record<string, unknown> {
  return encryptPayloadWithContext(payload, cxPublicKey, taskId, intent).envelope;
}

export function encryptPayloadWithContext(
  payload: unknown,
  cxPublicKey: CxPublicKey,
  taskId: string,
  intent: string,
): { envelope: Record<string, unknown>; sharedSecret: Buffer } {
  if (cxPublicKey.algorithm !== "X25519") {
    throw new Error(`Unsupported cx_public_key algorithm: ${cxPublicKey.algorithm}`);
  }

  // Import node's static public key from base64url-encoded raw bytes (JWK format)
  const nodeX = cxPublicKey.key; // already base64url
  const nodePub = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: nodeX },
    format: "jwk",
  });

  // Generate ephemeral X25519 keypair
  const { privateKey: ephemPriv, publicKey: ephemPub } = generateKeyPairSync("x25519");
  const ephemPubJwk = ephemPub.export({ format: "jwk" }) as { x: string };
  const ephemPubBytes = b64urlDecode(ephemPubJwk.x);

  // ECDH shared secret
  const sharedSecret = diffieHellman({ privateKey: ephemPriv, publicKey: nodePub });

  // HKDF-SHA256
  const nonce = randomBytes(12);
  const info = Buffer.from(`IICP-CX-v1${taskId}${intent}`);
  const keyMaterial = hkdfSha256(sharedSecret, nonce, info, 32);

  // AES-256-GCM encrypt
  const payloadJson = Buffer.from(JSON.stringify(payload));
  const aad = Buffer.from(`${taskId}|${intent}`);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(payloadJson), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { envelope: {
    version: 1,
    recipient_key_id: cxPublicKey.key_id,
    kem_ciphertext: b64urlEncode(ephemPubBytes),
    encrypted_body: b64urlEncode(Buffer.concat([ciphertext, tag])),
    nonce: b64urlEncode(nonce),
    aad: b64urlEncode(aad),
    plaintext_size: payloadJson.length,
  }, sharedSecret };
}

/**
 * Decrypt an iicp_conf envelope (CX-Provider side — for testing/adapter use).
 * privKeyBytes: raw 32-byte X25519 private key; pubKeyBytes: corresponding public key.
 */
export function decryptPayload(
  iicpConf: Record<string, unknown>,
  privKeyBytes: Buffer,
  pubKeyBytes: Buffer,
): unknown {
  return decryptPayloadWithContext(iicpConf, privKeyBytes, pubKeyBytes).payload;
}

export function decryptPayloadWithContext(
  iicpConf: Record<string, unknown>,
  privKeyBytes: Buffer,
  pubKeyBytes: Buffer,
): { payload: unknown; sharedSecret: Buffer } {
  const privX = b64urlEncode(privKeyBytes);
  const pubX = b64urlEncode(pubKeyBytes);
  const nodePriv = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: pubX, d: privX },
    format: "jwk",
  });

  const ephemPubBytes = b64urlDecode(String(iicpConf["kem_ciphertext"]));
  const ephemPub = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: b64urlEncode(ephemPubBytes) },
    format: "jwk",
  });

  const sharedSecret = diffieHellman({ privateKey: nodePriv, publicKey: ephemPub });

  const nonce = b64urlDecode(String(iicpConf["nonce"]));
  const aadBytes = b64urlDecode(String(iicpConf["aad"]));
  const aadStr = aadBytes.toString();
  const pipeIdx = aadStr.indexOf("|");
  const taskId = aadStr.slice(0, pipeIdx);
  const intent = aadStr.slice(pipeIdx + 1);

  const info = Buffer.from(`IICP-CX-v1${taskId}${intent}`);
  const keyMaterial = hkdfSha256(sharedSecret, nonce, info, 32);

  const encBody = b64urlDecode(String(iicpConf["encrypted_body"]));
  const ciphertext = encBody.slice(0, -16);
  const tag = encBody.slice(-16);

  const decipher = createDecipheriv("aes-256-gcm", keyMaterial, nonce);
  decipher.setAAD(aadBytes);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { payload: JSON.parse(plaintext.toString()), sharedSecret };
}

// ── Tier-2 §5a.3: bidirectional (response) encryption ────────────────────────
// Byte-compatible with the adapter/Python response primitives: response sealed under
// the request's session shared secret with a distinct HKDF label so request/response
// keys differ. Pure primitives (take the shared secret); wiring is a later step.
const RESP_INFO_PREFIX = "IICP-CX-RESP-v1";

/** Seal a node's RESPONSE under the request's session shared secret (IICP-CX §5a.3). */
export function encryptResponse(response: unknown, sharedSecret: Buffer, taskId: string): Record<string, unknown> {
  const nonce = randomBytes(12);
  const key = hkdfSha256(sharedSecret, nonce, Buffer.from(`${RESP_INFO_PREFIX}${taskId}`), 32);
  const aad = Buffer.from(`${taskId}|resp`);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(response))), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { version: 1, nonce: b64urlEncode(nonce), encrypted_body: b64urlEncode(Buffer.concat([ct, tag])) };
}

/** Open a node's encrypted RESPONSE (CX-Consumer side, IICP-CX §5a.3). */
export function decryptResponse(env: Record<string, unknown>, sharedSecret: Buffer, taskId: string): unknown {
  const nonce = b64urlDecode(String(env["nonce"]));
  const key = hkdfSha256(sharedSecret, nonce, Buffer.from(`${RESP_INFO_PREFIX}${taskId}`), 32);
  const aad = Buffer.from(`${taskId}|resp`);
  const encBody = b64urlDecode(String(env["encrypted_body"]));
  const ct = encBody.slice(0, -16);
  const tag = encBody.slice(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString());
}

import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function decision(vector: any, keys: Map<string, any>, signatureValid: boolean): string {
  const keyId = vector.claims.key_id;
  if (!vector.trust_bundle_key_ids.includes(keyId)) return "reject_unknown_key";
  const key = keys.get(keyId);
  if (key.state === "revoked") return "reject_key_revoked";
  if (vector.now < key.valid_from || vector.now > key.valid_until) return "reject_key_expired";
  if (!signatureValid) return "reject_signature";
  if (vector.jti_seen) return "reject_local_replay";
  return "accept_anchored";
}

function assertFixtureDecision(vectorId: string, expected: string): void {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const fixture = JSON.parse(readFileSync(join(here, "../parity/dispatch-ticket-trust-v2-crypto.json"), "utf8"));
  const domain = Buffer.from(fixture.domain_separator_b64url, "base64url");
  const keys = new Map<string, any>(fixture.keys.map((key: any) => [key.key_id, key]));
  const vector = fixture.vectors.find((value: any) => value.id === vectorId);
  const key = keys.get(vector.claims.key_id)!;
  const rawEd25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const publicKey = createPublicKey({
    key: Buffer.concat([rawEd25519SpkiPrefix, Buffer.from(key.public_key_b64url, "base64url")]),
    format: "der",
    type: "spki",
  });
  const message = Buffer.concat([domain, Buffer.from(canonical(vector.claims), "utf8")]);
  const signatureValid = verify(null, message, publicKey, Buffer.from(vector.signature_b64url, "base64url"));
  assert.equal(decision(vector, keys, signatureValid), expected);
}

test("expired dispatch-ticket key fails closed", () => {
  assertFixtureDecision("expired_key_refused", "reject_key_expired");
});

test("replayed dispatch ticket fails closed", () => {
  assertFixtureDecision("local_replay_refused", "reject_local_replay");
});

test("revoked dispatch-ticket key fails closed after rotation", () => {
  assertFixtureDecision("revoked_key_refused", "reject_key_revoked");
});

test("tampered dispatch-ticket signature fails closed", () => {
  assertFixtureDecision("tampered_claim_refused", "reject_signature");
});

test("dispatch-ticket v2 signed vectors are portable", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const fixture = JSON.parse(readFileSync(join(here, "../parity/dispatch-ticket-trust-v2-crypto.json"), "utf8"));
  const domain = Buffer.from(fixture.domain_separator_b64url, "base64url");
  const keys = new Map(fixture.keys.map((key: any) => [key.key_id, key]));
  const rawEd25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

  for (const vector of fixture.vectors) {
    const key = keys.get(vector.claims.key_id)!;
    const publicKey = createPublicKey({
      key: Buffer.concat([rawEd25519SpkiPrefix, Buffer.from(key.public_key_b64url, "base64url")]),
      format: "der",
      type: "spki",
    });
    const message = Buffer.concat([domain, Buffer.from(canonical(vector.claims), "utf8")]);
    const signatureValid = verify(null, message, publicKey, Buffer.from(vector.signature_b64url, "base64url"));
    assert.equal(signatureValid, vector.expected_signature_valid, vector.id);
    assert.equal(decision(vector, keys, signatureValid), vector.expected, vector.id);
  }
});

// SPDX-License-Identifier: Apache-2.0
/** Pre-normative restricted trust-domain membership verification. */

import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalizeJcs } from "./jcs.js";

export const MEMBERSHIP_SCHEMA = "iicp.restricted-trust-domain.membership-assertion.v0";
export const RESTRICTED_PROFILE = "urn:iicp:profile:restricted-trust-domain:v1";
const MEMBERSHIP_DOMAIN = Buffer.from("IICP-RTD-MEMBERSHIP-V0\n");
const GOSSIP_DOMAIN = Buffer.from("IICP-RTD-GOSSIP-V0\n");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MembershipRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface MembershipPolicy {
  domain_id: string;
  authority_id: string;
  authority_key_id: string;
  authority_public_key_ed25519: string;
  minimum_generation: number;
  maximum_clock_skew_seconds: number;
}

type JsonObject = Record<string, unknown>;

function refuse(code: string): never { throw new MembershipRefusal(code); }
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("membership_malformed");
  return value as JsonObject;
}
function exact(value: JsonObject, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) refuse("membership_malformed");
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function uint(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.every(text); }
function b64url(value: unknown, length: number): Buffer {
  if (typeof value !== "string") refuse("membership_malformed");
  const raw = Buffer.from(value, "base64url");
  if (raw.length !== length || raw.toString("base64url") !== value) refuse("membership_malformed");
  return raw;
}
function publicKey(raw: unknown) {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, b64url(raw, 32)]), format: "der", type: "spki" });
}

function shape(envelopeValue: unknown): { envelope: JsonObject; assertion: JsonObject; signature: JsonObject; subject: JsonObject; issuer: JsonObject } {
  const envelope = object(envelopeValue);
  exact(envelope, ["assertion", "signature"]);
  const assertion = object(envelope.assertion);
  const signature = object(envelope.signature);
  exact(assertion, ["schema", "profile", "assertion_id", "domain_id", "subject", "issuer", "issued_at", "expires_at", "generation", "scopes", "audience"]);
  const subject = object(assertion.subject);
  const issuer = object(assertion.issuer);
  exact(subject, ["kind", "id", "key_id", "public_key_ed25519"]);
  exact(issuer, ["id", "key_id"]);
  const signatureKeys = Object.keys(signature).sort().join(",");
  if (signatureKeys !== "algorithm,value" && signatureKeys !== "algorithm,key_id,value") refuse("membership_malformed");
  if (!text(assertion.assertion_id) || !UUID.test(assertion.assertion_id) || !text(assertion.domain_id)
    || !text(subject.id) || !text(subject.key_id) || !text(issuer.id) || !text(issuer.key_id)
    || !uint(assertion.issued_at) || !uint(assertion.expires_at) || !uint(assertion.generation)
    || !strings(assertion.scopes) || !strings(assertion.audience)
    || assertion.expires_at <= assertion.issued_at) refuse("membership_malformed");
  return { envelope, assertion, signature, subject, issuer };
}

export function verifyMembership(envelopeValue: unknown, policy: MembershipPolicy, expectedSubject: string, requiredScope: string, now: number): void {
  const { assertion, signature, subject, issuer } = shape(envelopeValue);
  if (assertion.schema !== MEMBERSHIP_SCHEMA || assertion.profile !== RESTRICTED_PROFILE || signature.algorithm !== "Ed25519") refuse("membership_unsupported");
  if (issuer.id !== policy.authority_id || issuer.key_id !== policy.authority_key_id) refuse("membership_authority_invalid");
  if (assertion.domain_id !== policy.domain_id || !(assertion.audience as string[]).includes(policy.domain_id)) refuse("membership_domain_mismatch");
  if (subject.kind !== "node" || subject.id !== expectedSubject) refuse("membership_subject_mismatch");
  if ((assertion.issued_at as number) > now + policy.maximum_clock_skew_seconds) refuse("membership_not_yet_valid");
  if ((assertion.expires_at as number) <= now) refuse("membership_expired");
  if ((assertion.generation as number) < policy.minimum_generation) refuse("membership_generation_revoked");
  if (!(assertion.scopes as string[]).includes(requiredScope)) refuse("membership_scope_missing");
  const message = Buffer.concat([MEMBERSHIP_DOMAIN, Buffer.from(canonicalizeJcs(assertion))]);
  if (!verify(null, message, publicKey(policy.authority_public_key_ed25519), b64url(signature.value, 64))) refuse("membership_signature_invalid");
}

export function verifyGossip(gossipValue: unknown, membershipValue: unknown, policy: MembershipPolicy, payload: Buffer, now: number, replaySeen = false): void {
  const gossip = object(gossipValue);
  exact(gossip, ["proof", "signature"]);
  const proof = object(gossip.proof);
  const signature = object(gossip.signature);
  exact(proof, ["sender_id", "domain_id", "sent_at", "replay_id", "payload_sha256", "membership_assertion_id"]);
  exact(signature, ["algorithm", "key_id", "value"]);
  verifyMembership(membershipValue, policy, String(proof.sender_id ?? ""), "peers", now);
  const { assertion, subject } = shape(membershipValue);
  if (!text(proof.replay_id) || !UUID.test(proof.replay_id)) refuse("membership_malformed");
  if (signature.algorithm !== "Ed25519" || signature.key_id !== subject.key_id) refuse("membership_unsupported");
  if (proof.domain_id !== policy.domain_id) refuse("membership_domain_mismatch");
  if (proof.membership_assertion_id !== assertion.assertion_id) refuse("membership_subject_mismatch");
  if (replaySeen) refuse("gossip_replay");
  if (!uint(proof.sent_at) || proof.sent_at > now + policy.maximum_clock_skew_seconds || now - proof.sent_at > policy.maximum_clock_skew_seconds) refuse("gossip_stale");
  if (proof.payload_sha256 !== createHash("sha256").update(payload).digest("hex")) refuse("gossip_payload_mismatch");
  const message = Buffer.concat([GOSSIP_DOMAIN, Buffer.from(canonicalizeJcs(proof))]);
  if (!verify(null, message, publicKey(subject.public_key_ed25519), b64url(signature.value, 64))) refuse("membership_signature_invalid");
}

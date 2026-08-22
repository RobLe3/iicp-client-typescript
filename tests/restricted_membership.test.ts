// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { MembershipRefusal, verifyGossip, verifyMembership, type MembershipPolicy } from "../src/index.js";

const path = fileURLToPath(new URL("fixtures/restricted-trust-domain-membership-v0.json", import.meta.url));
const bytes = readFileSync(path);
const fixture = JSON.parse(bytes.toString("utf8"));
const policy: MembershipPolicy = {
  domain_id: "domain-test-a",
  authority_id: "did:iicp:test:directory-a",
  authority_key_id: "did:iicp:test:directory-a#key-1",
  authority_public_key_ed25519: fixture.authority_public_key_ed25519,
  minimum_generation: 7,
  maximum_clock_skew_seconds: 60,
};

function reason(run: () => void): string {
  try { run(); } catch (error) { if (error instanceof MembershipRefusal) return error.code; throw error; }
  throw new Error("expected refusal");
}

test("restricted membership vectors match the shared fixture", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "78cb70b19dabed5be0175555cf2b4bb123dd4bc77ce36b67b745f311f3d941d4");
  for (const vector of fixture.vectors) {
    const run = () => verifyMembership(vector.envelope, policy, "did:iicp:test:node-a", "peers", 1_800_000_010);
    if (vector.expected === "valid") run();
    else assert.equal(reason(run), "membership_domain_mismatch");
  }
});

test("restricted gossip vectors preserve replay refusal", () => {
  for (const vector of fixture.gossip_vectors) {
    const run = () => verifyGossip(vector.gossip, vector.membership, policy, Buffer.from(vector.payload_utf8), 1_800_000_010, Boolean(vector.seen_replay_ids?.length));
    if (vector.expected === "valid") run();
    else assert.equal(reason(run), "gossip_replay");
  }
});

test("restricted membership lifecycle and scope fail closed", () => {
  const valid = fixture.vectors[0].envelope;
  assert.equal(reason(() => verifyMembership(valid, policy, "other", "peers", 1_800_000_010)), "membership_subject_mismatch");
  assert.equal(reason(() => verifyMembership(valid, policy, "did:iicp:test:node-a", "missing", 1_800_000_010)), "membership_scope_missing");
  assert.equal(reason(() => verifyMembership(valid, policy, "did:iicp:test:node-a", "peers", 1_800_000_300)), "membership_expired");
});

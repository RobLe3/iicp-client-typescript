import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LocalDispatchReplayCache, verifyDispatchTicketV2 } from "../src/dispatch_ticket_trust.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../parity/dispatch-ticket-trust-v2-crypto.json"), "utf8"));
const keys = new Map(fixture.keys.map((key: any) => [key.key_id, key]));

test("runtime verifier consumes portable vectors", () => {
  for (const vector of fixture.vectors) {
    const replayCache = new LocalDispatchReplayCache();
    if (vector.jti_seen) replayCache.remember(vector.claims.jti, vector.claims.expires_at);
    const result = verifyDispatchTicketV2(
      vector.claims,
      vector.signature_b64url,
      { bundle_version: 4, keys: vector.trust_bundle_key_ids.map((id: string) => keys.get(id)) },
      {
        issuer: vector.claims.issuer,
        provider_id: vector.claims.provider_id,
        intent: vector.claims.intent,
        constraints_digest: vector.claims.constraints_digest,
      },
      { now: vector.now, minimumBundleVersion: 4, replayCache },
    );
    assert.equal(result.code, vector.expected, vector.id);
  }
});

test("bundle rollback and route mismatch fail closed", () => {
  const vector = fixture.vectors[0];
  const binding = { issuer: vector.claims.issuer, provider_id: "wrong", intent: vector.claims.intent, constraints_digest: vector.claims.constraints_digest };
  assert.equal(verifyDispatchTicketV2(vector.claims, vector.signature_b64url, { bundle_version: 3, keys: [fixture.keys[0]] }, binding, { now: vector.now, minimumBundleVersion: 4 }).code, "reject_bundle_rollback");
  assert.equal(verifyDispatchTicketV2(vector.claims, vector.signature_b64url, { bundle_version: 4, keys: [fixture.keys[0]] }, binding, { now: vector.now }).code, "reject_claim_mismatch");
});

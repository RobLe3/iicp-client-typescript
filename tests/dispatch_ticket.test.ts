import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { policyManifestBindingMatches, verifyDispatchRouteTicket } from "../src/dispatch_ticket";
test("canonical dispatch ticket fixture verifies and tampering fails", () => {
 const fixture=JSON.parse(readFileSync(new URL("../parity/dispatch-route-ticket-v1.json", import.meta.url),"utf8"));
 const c=fixture.valid.claims;
 assert.ok(verifyDispatchRouteTicket(fixture.valid.token,fixture.public_key_hex,c.iss,c.node_id,c.intent,1_800_000_000));
 assert.equal(verifyDispatchRouteTicket(fixture.valid.token+"0",fixture.public_key_hex,c.iss,c.node_id,c.intent,1_800_000_000),null);
});

test("canonical dispatch ticket vectors fail closed", () => {
 const fixture=JSON.parse(readFileSync(new URL("../parity/dispatch-route-ticket-v1.json", import.meta.url),"utf8"));
 for (const vector of fixture.validation_vectors) {
   const token = vector.token === "valid" ? fixture.valid.token : vector.token === "valid+0" ? `${fixture.valid.token}0` : vector.token === "wrong_audience" ? fixture.wrong_audience.token : vector.token;
   const result = verifyDispatchRouteTicket(token, fixture.public_key_hex, vector.issuer, vector.node_id, vector.intent, vector.now_s);
   assert.equal(Boolean(result), vector.expected === "valid", vector.name);
}

test("policy manifest binding is additive and fails closed when present", () => {
 const claims = { v:1 as const, typ:"dispatch-route-ticket" as const, iss:"https://directory.example", aud:"iicp.directory.dispatch", jti:"0".repeat(24), node_id:"node", intent:"urn:iicp:intent:llm:chat:v1", iat:1, exp:2, policy_manifest_sha256:"a".repeat(64) };
 const matching = { node_policy_manifest: { verification: { canonical_sha256: "a".repeat(64) } } };
 const altered = { node_policy_manifest: { verification: { canonical_sha256: "b".repeat(64) } } };
 assert.equal(policyManifestBindingMatches(claims, matching), true);
 assert.equal(policyManifestBindingMatches(claims, altered), false);
 assert.equal(policyManifestBindingMatches(claims, {}), false);
 assert.equal(policyManifestBindingMatches({ ...claims, policy_manifest_sha256: undefined }, {}), true);
});
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyDispatchRouteTicket } from "../src/dispatch_ticket";
test("canonical dispatch ticket fixture verifies and tampering fails", () => {
 const fixture=JSON.parse(readFileSync(new URL("../parity/dispatch-route-ticket-v1.json", import.meta.url),"utf8"));
 const c=fixture.valid.claims;
 assert.ok(verifyDispatchRouteTicket(fixture.valid.token,fixture.public_key_hex,c.iss,c.node_id,c.intent,1_800_000_000));
 assert.equal(verifyDispatchRouteTicket(fixture.valid.token+"0",fixture.public_key_hex,c.iss,c.node_id,c.intent,1_800_000_000),null);
});

test("canonical dispatch ticket vectors fail closed", () => {
 const fixture=JSON.parse(readFileSync(new URL("../parity/dispatch-route-ticket-v1.json", import.meta.url),"utf8"));
 for (const vector of fixture.validation_vectors) {
   if (vector.expected === "unsupported_pre_normative_profile") continue;
   const token = vector.token === "valid" ? fixture.valid.token : vector.token === "valid+0" ? `${fixture.valid.token}0` : vector.token;
   const result = verifyDispatchRouteTicket(token, fixture.public_key_hex, vector.issuer, vector.node_id, vector.intent, vector.now_s);
   assert.equal(Boolean(result), vector.expected === "valid", vector.name);
 }
});

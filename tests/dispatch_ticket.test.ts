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

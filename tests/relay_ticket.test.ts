import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";

import { verifyRelayBindTicket } from "../src/relay_ticket.js";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signedTicket(claims: Record<string, unknown>) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyHex = spki.subarray(-32).toString("hex");
  const payload = b64url(JSON.stringify(claims));
  const sigHex = sign(null, Buffer.from("iicp:relay-bind-ticket:v1\n" + payload), privateKey).toString("hex");
  return { token: `${payload}.${sigHex}`, publicKeyHex };
}

function tamperToken(token: string): string {
  const replacement = token.endsWith("0") ? "1" : "0";
  return `${token.slice(0, -1)}${replacement}`;
}

describe("relay bind ticket verification (#510)", () => {
  it("accepts a valid directory-signed ticket for worker and audience", () => {
    const { token, publicKeyHex } = signedTicket({
      v: 1, typ: "relay-bind-ticket", iss: "https://iicp.network",
      sub: "worker-1", aud: "relay-1", iat: 1, exp: 999_999,
    });
    const claims = verifyRelayBindTicket(token, publicKeyHex, "worker-1", "relay-1", 100);
    assert.equal(claims?.sub, "worker-1");
  });

  it("rejects wrong worker, wrong audience, expired and tampered tickets", () => {
    const { token, publicKeyHex } = signedTicket({
      v: 1, typ: "relay-bind-ticket", iss: "https://iicp.network",
      sub: "worker-1", aud: "relay-1", iat: 1, exp: 999_999,
    });
    assert.equal(verifyRelayBindTicket(token, publicKeyHex, "attacker", "relay-1", 100), null);
    assert.equal(verifyRelayBindTicket(token, publicKeyHex, "worker-1", "relay-2", 100), null);
    assert.equal(verifyRelayBindTicket(token, publicKeyHex, "worker-1", "relay-1", 1_000_000), null);
    assert.equal(verifyRelayBindTicket(tamperToken(token), publicKeyHex, "worker-1", "relay-1", 100), null);
  });
});

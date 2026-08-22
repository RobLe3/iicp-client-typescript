import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { IicpClient } from "../src/client.js";
import { RESTRICTED_DIRECTORY_PROFILE_ID, validateRestrictedDecision } from "../src/restricted_directory.js";
import type { RestrictedDirectoryContext } from "../src/types.js";

const context = (): RestrictedDirectoryContext => ({
  domain_id: "domain-a", authority_id: "did:iicp:test:directory-a", subject_id: "client-a",
  subject_kind: "client", minimum_membership_generation: 7,
  membership_credential: { kind: "provider", resolve: () => "member-token" },
});
const decision = (operation = "discovery", changes: Record<string, unknown> = {}) => ({
  restricted_domain_decision: {
    schema: "iicp.restricted-trust-domain.directory-decision.v0", profile: RESTRICTED_DIRECTORY_PROFILE_ID,
    decision: "eligible", operation, domain_id: "domain-a", authority_id: "did:iicp:test:directory-a",
    subject_kind: "client", membership_generation: 7, membership_expires_at: Math.floor(Date.now() / 1000) + 300,
    ...changes,
  },
});

describe("restricted directory boundary", () => {
  afterEach(() => mock.restoreAll());
  it("accepts only exact current decisions", () => {
    assert.equal(validateRestrictedDecision(decision(), context(), "discovery").membership_generation, 7);
    for (const invalid of [{}, decision("bootstrap"), decision("discovery", { domain_id: "domain-b" }), decision("discovery", { membership_generation: 6 }), decision("discovery", { membership_expires_at: 1 })]) {
      assert.throws(() => validateRestrictedDecision(invalid, context(), "discovery"));
    }
  });
  it("sends membership evidence and disables redirects", async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("X-IICP-Membership"), "member-token");
      assert.equal(headers.get("X-IICP-Subject-Id"), "client-a");
      assert.equal(init?.redirect, "manual");
      return new Response(JSON.stringify({ ...decision(), nodes: [] }), { status: 200 });
    });
    const client = new IicpClient({ directory_url: "https://directory.example", route_discovery_mode: "ticketed", restricted_directory: context() });
    await client.discoverWithNegotiation("urn:iicp:intent:llm:chat:v1");
    assert.equal(calls, 1);
  });
  it("refuses legacy fallback", () => {
    assert.throws(() => new IicpClient({ restricted_directory: context(), route_discovery_mode: "legacy" }), /legacy/);
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DISPATCH_ADMISSION_V2_PROFILE,
  DispatchAdmissionClaim,
  SqliteDispatchAdmissionStore,
  evaluateDispatchAdmission,
} from "../src/index.js";

interface FixtureCase {
  id: string;
  claim: DispatchAdmissionClaim;
  prior?: Array<{ now: number; terminal_state?: string }>;
  reopen?: boolean;
  trust_verified?: boolean;
  expected_provider_id: string;
  expected_intent: string;
  now: number;
  expected: string;
}

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, "../parity/dispatch-admission-v2.json"),
    "utf8",
  ),
) as {
  profile: string;
  defaults: { clock_skew_s: number; retention_s: number; cleanup_batch: number };
  cases: FixtureCase[];
};

function temporaryStore(): {
  dir: string;
  path: string;
  store: SqliteDispatchAdmissionStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "iicp-dispatch-admission-"));
  const path = join(dir, "admission.sqlite");
  return { dir, path, store: new SqliteDispatchAdmissionStore(path) };
}

test("shared dispatch admission vectors pass", () => {
  assert.equal(fixture.profile, DISPATCH_ADMISSION_V2_PROFILE);
  for (const vector of fixture.cases) {
    const { dir, path } = temporaryStore();
    try {
      let store = new SqliteDispatchAdmissionStore(path);
      for (const prior of vector.prior ?? []) {
        const decision = evaluateDispatchAdmission(store, vector.claim, {
          expectedProviderId: vector.claim.provider_id,
          expectedIntent: vector.claim.intent,
          now: prior.now,
          trustVerified: true,
          clockSkewSeconds: fixture.defaults.clock_skew_s,
        });
        assert.equal(decision.code, "accepted", `${vector.id} prior admission`);
        if (prior.terminal_state) {
          store.transition(vector.claim.jti, prior.terminal_state, prior.now);
        }
      }
      if (vector.reopen) store = new SqliteDispatchAdmissionStore(path);
      const decision = evaluateDispatchAdmission(store, vector.claim, {
        expectedProviderId: vector.expected_provider_id,
        expectedIntent: vector.expected_intent,
        now: vector.now,
        trustVerified: vector.trust_verified ?? true,
        clockSkewSeconds: fixture.defaults.clock_skew_s,
      });
      assert.equal(decision.code, vector.expected, vector.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("concurrent store instances admit a JTI exactly once", async () => {
  const { dir, path } = temporaryStore();
  try {
    const claim: DispatchAdmissionClaim = {
      jti: "admission-ticket-concurrent-0001",
      provider_id: "provider-a",
      intent: "urn:iicp:intent:llm:chat:v1",
      not_before: 1,
      expires_at: 10_000,
    };
    const stores = Array.from(
      { length: 8 },
      () => new SqliteDispatchAdmissionStore(path),
    );
    const decisions = await Promise.all(
      stores.map((store) =>
        Promise.resolve().then(() =>
          store.consume(claim, claim.provider_id, claim.intent, 100),
        ),
      ),
    );
    assert.equal(decisions.filter((decision) => decision.accepted).length, 1);
    assert.equal(
      decisions.filter((decision) => decision.code === "reject_replay").length,
      7,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal transitions persist and cleanup is bounded", () => {
  const { dir, path, store } = temporaryStore();
  try {
    for (let index = 0; index < 3; index += 1) {
      const claim: DispatchAdmissionClaim = {
        jti: `admission-ticket-cleanup-000${index}`,
        provider_id: "provider-a",
        intent: "urn:iicp:intent:llm:chat:v1",
        not_before: 1,
        expires_at: 10 + index,
      };
      assert.equal(
        store.consume(claim, claim.provider_id, claim.intent, 2).code,
        "accepted",
      );
    }
    const terminal = store.transition(
      "admission-ticket-cleanup-0000",
      "completed",
      20,
    );
    assert.equal(terminal.state, "completed");
    assert.equal(new SqliteDispatchAdmissionStore(path).lookup(terminal.jti)?.state, "completed");
    assert.equal(store.cleanup(1_000, fixture.defaults.retention_s, 2), 2);
    assert.equal(store.cleanup(1_000, fixture.defaults.retention_s, 2), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

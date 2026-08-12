import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  applyCandidateRanker,
  rankerReceiptProfile,
  type CandidateEvidenceV0,
  type CandidateRanker,
  type RankerDecision,
  type RankerRequest,
} from "../src/selection.js";
import type { Node, TaskRequest } from "../src/types.js";

type FixtureCase = {
  id: string;
  ranker: {
    outcome: "select" | "decline" | "error";
    candidate_ref?: string;
    policy_id?: string;
    mode?: "normal" | "exploration";
    message?: string;
  };
  expected_order?: string[];
  expected_primary_receipt?: string | null;
  expected_fallback_receipt?: string | null;
  expected_error_contains?: string;
};

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/candidate-ranker-v0.json", import.meta.url), "utf8"),
) as {
  evidence_schema: string;
  request: { task_id: string; request_ref: string; intent: string; payload_marker: string };
  nodes: Array<{
    node_id: string;
    endpoint: string;
    candidate_ref: string;
    models: string[];
    directory_score: number;
    load: number;
    health_label: string;
    directory_observed_reachable: boolean;
  }>;
  eligible_node_ids: string[];
  built_in_order: string[];
  excluded_evidence_terms: string[];
  cases: FixtureCase[];
};

const nodes = new Map<string, Node>(fixture.nodes.map((raw) => [raw.node_id, {
  node_id: raw.node_id,
  endpoint: raw.endpoint,
  score: raw.directory_score,
  load: raw.load,
  models: raw.models,
  available: true,
  region: "eu",
  health_label: raw.health_label,
  directory_observed_reachable: raw.directory_observed_reachable,
}]));
const request: TaskRequest = {
  intent: fixture.request.intent,
  payload: { marker: fixture.request.payload_marker },
};

class FixtureRanker implements CandidateRanker {
  observed: readonly CandidateEvidenceV0[] = [];

  constructor(private readonly fixtureCase: FixtureCase) {}

  rank(context: RankerRequest, candidates: readonly CandidateEvidenceV0[]): RankerDecision | undefined {
    assert.equal(context.request_ref, fixture.request.request_ref);
    assert.equal(context.intent, fixture.request.intent);
    assert.equal(context.request, request);
    this.observed = candidates;
    const definition = this.fixtureCase.ranker;
    if (definition.outcome === "decline") return undefined;
    if (definition.outcome === "error") throw new Error(definition.message);
    return {
      candidate_ref: definition.candidate_ref!,
      policy_id: definition.policy_id!,
      mode: definition.mode!,
    };
  }
}

async function run(fixtureCase: FixtureCase) {
  const eligible = fixture.eligible_node_ids.map((id) => nodes.get(id)!);
  const builtIn = fixture.built_in_order.map((id) => nodes.get(id)!);
  const ranker = new FixtureRanker(fixtureCase);
  const applied = await applyCandidateRanker(
    ranker,
    request,
    fixture.request.task_id,
    eligible,
    builtIn,
    3,
  );
  return { ranker, applied };
}

describe("candidate-ranker shared parity fixture", () => {
  for (const fixtureCase of fixture.cases.filter((entry) => entry.expected_order)) {
    it(fixtureCase.id, async () => {
      const { ranker, applied } = await run(fixtureCase);
      assert.deepEqual(applied.candidates.map((node) => node.node_id), fixtureCase.expected_order);
      assert.equal(ranker.observed.length, 2);
      assert.ok(ranker.observed.every((candidate) => candidate.schema_version === fixture.evidence_schema));
      if (applied.decision) {
        assert.equal(rankerReceiptProfile(applied.decision, 0), fixtureCase.expected_primary_receipt);
        assert.equal(rankerReceiptProfile(applied.decision, 1), fixtureCase.expected_fallback_receipt);
      } else {
        assert.equal(fixtureCase.expected_primary_receipt, null);
      }
    });
  }

  for (const fixtureCase of fixture.cases.filter((entry) => entry.expected_error_contains)) {
    it(fixtureCase.id, async () => {
      await assert.rejects(() => run(fixtureCase), new RegExp(fixtureCase.expected_error_contains!));
    });
  }

  it("redacts endpoints, identities, payloads and the ineligible candidate", async () => {
    const { ranker } = await run(fixture.cases[0]);
    const encoded = JSON.stringify(ranker.observed);
    for (const forbidden of fixture.excluded_evidence_terms) assert.ok(!encoded.includes(forbidden), forbidden);
    assert.deepEqual(ranker.observed.map((candidate) => candidate.models), [["model-a"], ["model-b"]]);
  });
});

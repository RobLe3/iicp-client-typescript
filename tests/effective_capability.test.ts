import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  EFFECTIVE_CAPABILITY_PROFILE_ID,
  matchEffectiveCapabilities,
  parseEffectiveCapabilityAdvertisement,
  resolveEffectiveCapabilities,
  type CapabilityRequirements,
  type EffectiveCapability,
} from "../src/effective_capability.js";

const parityRoot = new URL("../parity/effective-capability-v1/", import.meta.url);
const fixtureBytes = readFileSync(new URL("fixture.json", parityRoot));
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  profile_id: string;
  evaluation_time: string;
  vocabulary: Record<string, string[]>;
  advertisement: unknown;
  matching_scenarios: Array<{
    name: string;
    evaluation_time?: string;
    request: CapabilityRequirements;
    policy_denials?: Array<{ class: string; id: string }>;
    expected: {
      eligible: boolean;
      variant_ids?: string[];
      preference_unavailable?: boolean;
      preserved_extension?: string;
      refusal?: { code: string };
    };
  }>;
  invalid_advertisements: Array<{ name: string; value: unknown }>;
};

describe("effective-capability shared parity contract", () => {
  it("pins the exact shared fixture and schemas", () => {
    assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"), "e6e3c32aa7c4cf814e639d3a97cd1c1cb49ac020ed6ebe7e1e16bc2314e14761");
    assert.equal(fixture.profile_id, EFFECTIVE_CAPABILITY_PROFILE_ID);
    const schemaDigests: Record<string, string> = {
      "advertisement.schema.json": "707da7eebc5e8b55a720386ca713c977beeadd640f4b09eb48ea99573d2b1ab0",
      "requirements.schema.json": "0d234ef4de420b977661d3222c3c9f433332e8224a3320175318338c76e760e9",
      "refusal.schema.json": "5d35b57c31eeb176bd7db72bfaf1ccaa84defe864bc63a10c59b97d689e52f9e",
    };
    for (const [name, expected] of Object.entries(schemaDigests)) {
      assert.equal(createHash("sha256").update(readFileSync(new URL(name, parityRoot))).digest("hex"), expected);
    }
  });

  for (const scenario of fixture.matching_scenarios) {
    it(scenario.name, () => {
      const capabilities = parseEffectiveCapabilityAdvertisement(fixture.advertisement);
      const result = matchEffectiveCapabilities(
        capabilities,
        scenario.request,
        fixture.vocabulary,
        new Date(scenario.evaluation_time ?? fixture.evaluation_time),
        scenario.policy_denials,
      );
      assert.equal(result.eligible, scenario.expected.eligible);
      if (result.eligible) {
        assert.deepEqual(result.variant_ids, scenario.expected.variant_ids);
        assert.equal(result.preference_unavailable, scenario.expected.preference_unavailable ?? false);
        if (scenario.expected.preserved_extension) {
          assert.ok(result.preserved_extensions.includes(scenario.expected.preserved_extension));
        }
      } else {
        assert.equal(result.refusal, scenario.expected.refusal?.code);
      }
    });
  }

  for (const invalid of fixture.invalid_advertisements) {
    it(`rejects ${invalid.name}`, () => {
      assert.throws(() => parseEffectiveCapabilityAdvertisement(invalid.value));
    });
  }
});

describe("effective capability evidence precedence", () => {
  const explicit: EffectiveCapability = { intent: "urn:iicp:intent:llm:chat:v1", variant_id: "explicit" };
  const introspected: EffectiveCapability = { ...explicit, variant_id: "introspected" };
  const heuristic: EffectiveCapability = {
    ...explicit,
    variant_id: "heuristic",
    claim_provenance: { source: "heuristic_fallback" },
  };

  it("prefers explicit, then introspected, then labelled heuristic evidence", () => {
    assert.deepEqual(resolveEffectiveCapabilities({ explicit: [explicit], introspected: [introspected], heuristic: [heuristic] }), [explicit]);
    assert.deepEqual(resolveEffectiveCapabilities({ introspected: [introspected], heuristic: [heuristic] }), [introspected]);
    assert.deepEqual(resolveEffectiveCapabilities({ heuristic: [heuristic] }), [heuristic]);
  });

  it("rejects an unlabelled heuristic fallback", () => {
    assert.throws(() => resolveEffectiveCapabilities({ heuristic: [explicit] }), /heuristic_fallback/);
  });
});

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), `parity/${name}`), "utf8"));

function cip(value: Record<string, any>): Record<string, any> {
  const replicas = value.replicas;
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > 10) return { envelope: "reject", execution: "reject", error: "IICP-E028" };
  const quorum = value.quorum;
  if (quorum != null && (!Number.isInteger(quorum) || quorum < 1 || quorum > replicas)) return { envelope: "reject", execution: "reject", error: "IICP-E028" };
  const out = { envelope: "accept" };
  if (value.sensitivity === "high" && value.send_sensitive_prompts !== true) return { ...out, execution: "local", remote_eligible: false };
  if (String(value.intent ?? "").startsWith("urn:iicp:intent:mcp:") || String(value.intent ?? "").startsWith("urn:iicp:intent:tool:")) return { ...out, execution: "reject", remote_eligible: false };
  const operatorMax = Math.min(10, Math.max(1, value.operator_max_replicas ?? 10));
  if (value.policy == null) return replicas === 1 ? { ...out, execution: "accept", quorum: null } : { ...out, execution: "reject", error: "IICP-E028" };
  if (value.policy === "best_of_n") return replicas >= 2 && replicas <= operatorMax ? { ...out, execution: "accept", quorum: null } : { ...out, execution: "reject", error: "IICP-E028" };
  if (value.policy === "majority_vote") {
    if (replicas < 3 || replicas % 2 === 0) return { ...out, execution: "reject", error: "IICP-E025" };
    if (replicas > operatorMax) return { ...out, execution: "reject", error: "IICP-E028" };
    return { ...out, execution: "accept", quorum: quorum ?? Math.floor(replicas / 2) + 1 };
  }
  if (value.policy === "map_reduce" && !(value.implemented_modes ?? []).includes("map_reduce")) return { ...out, execution: "unsupported", advertise: false };
  return { ...out, execution: "reject", error: "IICP-E028" };
}

function schemaValid(value: any, schema: Record<string, any>): boolean {
  const type = schema.type;
  if (type === "object" && (value == null || Array.isArray(value) || typeof value !== "object")) return false;
  if (type === "array" && !Array.isArray(value)) return false;
  if (type === "string" && typeof value !== "string") return false;
  if (type === "integer" && !Number.isInteger(value)) return false;
  if (type === "number" && typeof value !== "number") return false;
  if (value != null && !Array.isArray(value) && typeof value === "object") {
    const properties = schema.properties ?? {};
    if ((schema.required ?? []).some((key: string) => !(key in value))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
    if (Object.entries(properties).some(([key, child]) => key in value && !schemaValid(value[key], child as Record<string, any>))) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

function evaluate(c: Record<string, any>): { passed: boolean; score: number } {
  const candidate = c.candidate;
  if (c.evaluator === "exact_match") {
    const passed = String(candidate).normalize("NFC").trim() === String(c.expected_value).normalize("NFC").trim(); return { passed, score: Number(passed) };
  }
  if (c.evaluator === "numeric_tolerance") {
    const actual = Number(candidate), expected = Number(c.expected_value);
    const passed = Math.abs(actual - expected) <= Math.max(Number(c.absolute_tolerance ?? 0), Math.abs(expected) * Number(c.relative_tolerance ?? 0)); return { passed, score: Number(passed) };
  }
  if (c.evaluator === "json_schema_subset") { const passed = schemaValid(candidate, c.schema); return { passed, score: Number(passed) }; }
  if (c.evaluator === "constraints") {
    const checks = c.constraints.map((constraint: Record<string, any>) => {
      const actual = candidate[constraint.path];
      if (constraint.op === "equals") return assert.deepEqual(actual, constraint.value) === undefined;
      if (constraint.op === "in") return constraint.value.includes(actual);
      if (constraint.op === "min_items") return Array.isArray(actual) && actual.length >= constraint.value;
      if (constraint.op === "max_items") return Array.isArray(actual) && actual.length <= constraint.value;
      return false;
    });
    const passed = checks.length > 0 && checks.every(Boolean); return { passed, score: Number(passed) };
  }
  if (c.evaluator === "unit_test_summary") {
    const total = candidate.passed + candidate.failed;
    return { passed: total > 0 && candidate.failed === 0 && Boolean(candidate.suite_digest), score: Number((total ? candidate.passed / total : 0).toFixed(6)) };
  }
  throw new Error(`unsupported evaluator ${c.evaluator}`);
}

function coordinatorTranscript(c: Record<string, any>): Record<string, any> {
  const dispatched = new Set<string>(), results = new Set<string>();
  let terminal = "running", settlement = "release_unspent", duplicates = 0;
  for (const event of c.events) {
    if (event.type === "dispatch" && terminal === "running") dispatched.add(event.worker);
    else if (event.type === "duplicate_result") duplicates += 1;
    else if (event.type === "result" && terminal === "running" && dispatched.has(event.worker) && !results.has(event.worker)) {
      if (event.attribution === "same_operator") { settlement = "exclude_self_dealing"; continue; }
      results.add(event.worker);
      if (results.size >= c.quorum) { terminal = "completed"; settlement = "settle_contributors"; }
    } else if (event.type === "cancel" && terminal === "running") terminal = "cancelled";
    else if (event.type === "timeout" && terminal === "running") terminal = c.strict_replicas ? "local_fallback" : "failed";
    else if (event.type === "coordinator_failure" && terminal === "running") terminal = "failed";
  }
  return { terminal, counted_results: results.size, duplicates_ignored: duplicates, settlement };
}

test("CIP conformance fixture is portable", () => {
  const data = fixture("cip-conformance-v0.json");
  for (const c of data.cases) assert.deepEqual(cip(c.input), c.expected, c.name);
  const v = data.canonical_receipt_vectors[0];
  assert.equal(createHash("sha256").update(v.canonical_result_json).digest("hex"), v.response_hash);
  assert.equal(createHmac("sha256", v.hmac_key_utf8).update(v.canonical_message).digest("hex"), v.signature_hmac_sha256);
});

test("ARCP evaluator fixture is portable", () => {
  const data = fixture("arcp-evaluator-v0.json");
  for (const c of data.cases) assert.deepEqual(evaluate(c), c.expected, c.name);
});

test("ARCP coordinator transcript fixture is portable", () => {
  const data = fixture("arcp-coordinator-transcript-v0.json");
  assert.equal(data.status, "pre-normative");
  for (const c of data.cases) assert.deepEqual(coordinatorTranscript(c), c.expected, c.name);
});

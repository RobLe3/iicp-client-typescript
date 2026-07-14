import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const data = JSON.parse(readFileSync(join(process.cwd(), "parity/cip-economic-attribution-v0.json"), "utf8"));

function attribution(v: Record<string, any>): Record<string, any> {
  const q = v.querying_node_id;
  if (!q) return { action: "award", attribution: "legacy_unattributed", trust_weight: 0 };
  if (q === v.serving_node_id) return { action: "exclude", attribution: "self_node", trust_weight: 0 };
  if (!v.querying_exists) return { action: "reject", attribution: "unknown_querying_node", trust_weight: 0, error: "IICP-E027" };
  if (v.serving_operator && v.querying_operator && v.serving_operator === v.querying_operator) return { action: "exclude", attribution: "self_operator", trust_weight: 0 };
  if (v.serving_operator && v.querying_operator) return { action: "award", attribution: "attributed_cross_operator", trust_weight: 1 };
  return { action: "award", attribution: "attributed_cross_node_unverified_operator", trust_weight: 0.5 };
}

function receiptTime(v: Record<string, string>): Record<string, string> {
  if (!v.completed_at || !v.observed_at || !v.expires_at) return { action: "reject", error: "IICP-E027" };
  const completed = Date.parse(v.completed_at), observed = Date.parse(v.observed_at), expires = Date.parse(v.expires_at);
  if ([completed, observed, expires].some(Number.isNaN) || expires > completed + 300_000 || observed > expires) return { action: "reject", error: "IICP-E027" };
  return { action: "accept" };
}

test("CIP economic attribution fixture is portable", () => {
  for (const c of data.attribution_cases) assert.deepEqual(attribution(c.input), c.expected, c.name);
  for (const c of data.heartbeat_cases) {
    const counted = Math.min(Math.max(0, c.input.tasks_success), 300), failed = Math.max(0, c.input.tasks_failed);
    assert.deepEqual({ counted_success: counted, completed_increment: counted, lifetime_jobs_increment: counted + failed }, c.expected, c.name);
  }
  for (const c of data.receipt_time_cases) assert.deepEqual(receiptTime(c.input), c.expected, c.name);
  for (const c of data.selection_tie_cases) {
    const selected = c.input.nodes.filter((n: any) => n.eligible).sort((a: any, b: any) => b.score - a.score || a.node_id.localeCompare(b.node_id))[0];
    assert.deepEqual({ selected_node_id: selected?.node_id ?? null }, c.expected, c.name);
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { evaluatePolicyDataHandling } from "../src/policy_data_handling.js";
const fixture=JSON.parse(fs.readFileSync(path.resolve("parity/policy-data-handling-v0.json"),"utf8"));
for(const item of fixture.cases) test(`policy/data ${item.id}`,()=>{
  const decision=evaluatePolicyDataHandling(item.requirement,item.declaration,item.context??{});
  assert.equal(decision.reason,item.expected);
  assert.equal(decision.eligible,item.expected==="compatible");
});

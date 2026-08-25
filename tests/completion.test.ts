import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { completionCandidates, completionScript } from "../src/completion.js";
const fixture = JSON.parse(readFileSync(new URL("../parity/cli-completion-v1.json", import.meta.url), "utf8"));
for (const entry of fixture.cases) test(`completion ${entry.tokens.join(" ")}`, () => {
  const got = completionCandidates(entry.tokens);
  for (const wanted of entry.contains) assert.ok(got.includes(wanted), `${wanted} missing`);
});
for (const shell of [...fixture.shells, "pwsh"]) test(`script ${shell}`, () => assert.match(completionScript(shell), /iicp-node __complete/));

import assert from "node:assert/strict";
import test from "node:test";
import { handoffRestartDelay } from "../src/cli.js";

test("operator handoff waits once and never restarts an already requested node", () => {
  const marker = {
    affected_node_names: ["ollama"],
    restart_requested_node_names: [],
    completed_node_names: [],
    created_at_unix: 100,
    grace_seconds: 300,
  };
  assert.equal(handoffRestartDelay(marker, "ollama", 200), 200);
  assert.equal(handoffRestartDelay(marker, "ollama", 400), 0);
  assert.equal(handoffRestartDelay({ ...marker, restart_requested_node_names: ["ollama"] }, "ollama", 400), null);
});

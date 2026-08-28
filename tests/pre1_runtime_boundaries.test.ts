import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateNode, loadNode, nodePath, saveNode } from "../src/identity.js";

function isolatedHome(): { root: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "iicp-pre1-config-"));
  const previous = process.env.IICP_HOME;
  process.env.IICP_HOME = root;
  return {
    root,
    restore: () => {
      if (previous === undefined) delete process.env.IICP_HOME;
      else process.env.IICP_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("malformed node configuration fails closed", () => {
  const home = isolatedHome();
  try {
    writeFileSync(nodePath("malformed"), "{not-json");
    assert.throws(() => loadNode("malformed"), SyntaxError);
  } finally {
    home.restore();
  }
});

test("missing node configuration is explicitly absent", () => {
  const home = isolatedHome();
  try {
    assert.equal(loadNode("missing"), null);
  } finally {
    home.restore();
  }
});

test("permission-denied config write leaves no file", () => {
  const home = isolatedHome();
  try {
    const node = generateNode({
      operator_id: "operator-test",
      name: "permission-denied",
      backend_url: "http://127.0.0.1:11434",
      model: "test-model",
    });
    const destination = nodePath(node.name);
    mkdirSync(destination);
    assert.throws(() => saveNode(node));
    assert.equal(statSync(destination).isFile(), false);
  } finally {
    home.restore();
  }
});

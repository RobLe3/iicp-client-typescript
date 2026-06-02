// #405 — single-instance lock per node_id
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { InstanceLock, NodeAlreadyServingError } from "../src/instance_lock.js";

describe("InstanceLock (#405)", () => {
  let tmp: string;
  let saved: string | undefined;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iicp-lock-"));
    saved = process.env.IICP_HOME;
    process.env.IICP_HOME = tmp;
  });
  after(() => {
    if (saved === undefined) delete process.env.IICP_HOME;
    else process.env.IICP_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses a second live process for the same node_id; --force overrides", () => {
    const child: ChildProcess = spawn("sleep", ["30"]);
    try {
      const run = path.join(tmp, "run");
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, "dup.pid"), String(child.pid));
      assert.throws(() => InstanceLock.acquire("dup", false), NodeAlreadyServingError);
      assert.ok(InstanceLock.acquire("dup", true), "force overrides");
    } finally {
      child.kill();
    }
  });

  it("distinct node_ids coexist; lock is re-acquirable after release", () => {
    const a = InstanceLock.acquire("node-a", false);
    const b = InstanceLock.acquire("node-b", false);
    assert.ok(a && b);
    a.release();
    assert.ok(InstanceLock.acquire("node-a", false));
  });
});

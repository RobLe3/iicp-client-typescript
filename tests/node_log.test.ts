// Tests for node_log — persistent node log writer.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeNodeEvent, resolveLogDir } from "../src/node_log.js";

let ctr = 0;
function tmpDir(): string {
  const d = path.join(
    os.tmpdir(),
    `iicp_log_test_${process.pid}_${++ctr}`,
  );
  fs.rmSync(d, { recursive: true, force: true });
  return d;
}

describe("writeNodeEvent", () => {
  it("creates events.jsonl on first write", () => {
    const dir = tmpDir();
    writeNodeEvent("n1", "register_ok", "endpoint=http://localhost:9484", dir);
    assert.ok(fs.existsSync(path.join(dir, "events.jsonl")));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates per-node text log on first write", () => {
    const dir = tmpDir();
    writeNodeEvent("mynode", "serve_start", "port=9484", dir);
    assert.ok(fs.existsSync(path.join(dir, "mynode.log")));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("events.jsonl line is valid JSON with correct fields", () => {
    const dir = tmpDir();
    writeNodeEvent("n2", "heartbeat_ok", "seq=1", dir);
    const line = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim();
    const obj = JSON.parse(line) as Record<string, unknown>;
    assert.equal(obj.event, "heartbeat_ok");
    assert.equal(obj.node_id, "n2");
    assert.equal(obj.details, "seq=1");
    assert.match(String(obj.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("multiple writes append to both files", () => {
    const dir = tmpDir();
    writeNodeEvent("n3", "register_ok", "", dir);
    writeNodeEvent("n3", "heartbeat_ok", "seq=1", dir);
    writeNodeEvent("n3", "heartbeat_ok", "seq=2", dir);
    const lines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    const events = lines.map((l) => (JSON.parse(l) as Record<string, unknown>).event);
    assert.deepEqual(events, ["register_ok", "heartbeat_ok", "heartbeat_ok"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rotation creates backup file when size exceeded", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "bignode.log");
    const padding = Buffer.alloc(10 * 1024 * 1024 + 1, 88); // 'X'
    fs.writeFileSync(logPath, padding);
    writeNodeEvent("bignode", "serve_start", "port=9484", dir);
    assert.ok(fs.existsSync(path.join(dir, "bignode.log.1")));
    const newContent = fs.readFileSync(logPath, "utf8");
    assert.ok(newContent.includes("serve_start"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolveLogDir", () => {
  it("uses IICP_LOG_DIR env var when set", () => {
    const orig = process.env.IICP_LOG_DIR;
    process.env.IICP_LOG_DIR = "/tmp/custom_log_dir_test";
    try {
      assert.equal(resolveLogDir(), "/tmp/custom_log_dir_test");
    } finally {
      if (orig === undefined) delete process.env.IICP_LOG_DIR;
      else process.env.IICP_LOG_DIR = orig;
    }
  });
});

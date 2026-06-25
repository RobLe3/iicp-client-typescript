// ADR-016: IICP client SDK conformance — #520 Quick-Tunnel escalation (rung 5)
// TypeScript parity with iicp-client-python tests/test_tunnel.py.
//
// Behavior tests (fail if #520 reverts): setup (binary detection), initiation
// (spawn + URL parse + timeout), teardown (close kills child, idempotent),
// supervision (watchdog respawn with NEW url; bounded → onDead).
// A fake `cloudflared` script stands in — no network, no Cloudflare.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  INSTALL_HINT,
  type TunnelState,
  cloudflaredPath,
  openQuickTunnel,
} from "../src/tunnel.js";

function fakeBin(opts: { name?: string; lifetimeMs?: number; silent?: boolean } = {}): string {
  const { name = "fake-fox-1234", lifetimeMs = 60_000, silent = false } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iicp-tunnel-"));
  const file = path.join(dir, "cloudflared");
  const body = silent
    ? `#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n`
    : `#!/usr/bin/env node\nconsole.error("INF | starting tunnel");\nconsole.error("INF | https://${name}.trycloudflare.com");\nsetTimeout(() => {}, ${lifetimeMs});\n`;
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

describe("setup", () => {
  it("cloudflaredPath returns null when absent", () => {
    const oldPath = process.env.PATH;
    process.env.PATH = "/nonexistent-dir-iicp-test";
    try {
      assert.equal(cloudflaredPath(), null);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("openQuickTunnel rejects with the install hint when absent", async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = "/nonexistent-dir-iicp-test";
    try {
      await assert.rejects(() => openQuickTunnel(9484), /brew install cloudflared/);
      assert.ok(INSTALL_HINT.startsWith("cloudflared not found"));
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe("initiation", () => {
  it("parses the URL from output", async () => {
    const t = await openQuickTunnel(9484, 10_000, fakeBin());
    try {
      assert.equal(t.url, "https://fake-fox-1234.trycloudflare.com");
      assert.equal(t.localPort, 9484);
      assert.equal(t.process.exitCode, null); // still running
    } finally {
      t.close();
    }
  });

  it("times out when the child prints no URL", async () => {
    await assert.rejects(
      () => openQuickTunnel(9484, 500, fakeBin({ silent: true })),
      /no tunnel URL within/,
    );
  });
});

describe("teardown", () => {
  it("close terminates the child and is idempotent", async () => {
    const t = await openQuickTunnel(9484, 10_000, fakeBin());
    assert.equal(t.process.exitCode, null);
    t.close();
    await new Promise((r) => t.process.once("exit", r));
    // Signal-terminated children report signalCode, not exitCode, in Node.
    assert.ok(t.process.exitCode !== null || t.process.signalCode !== null);
    t.close(); // second close must not throw
  });
});

describe("supervision", () => {
  it("watchdog respawns with a new url", async () => {
    const t = await openQuickTunnel(9484, 10_000, fakeBin({ lifetimeMs: 60_000 }));
    const newUrl = new Promise<string>((resolve) => {
      t.watch(resolve, () => {});
    });
    t.process.kill("SIGKILL"); // simulate unexpected death
    const url = await newUrl;
    assert.ok(url.startsWith("https://"));
    assert.equal(t.process.exitCode, null); // fresh child running
    t.close();
  });

  it("gives up after MAX_RESPAWNS", async () => {
    // Child dies ~instantly after printing → every respawn dies too.
    const t = await openQuickTunnel(9484, 10_000, fakeBin({ lifetimeMs: 10 }));
    const dead = new Promise<void>((resolve) => {
      t.watch(() => {}, resolve);
    });
    await dead;
    assert.ok(t.respawns >= 1);
    t.close();
  });

  it("close suppresses the watchdog", async () => {
    const t = await openQuickTunnel(9484, 10_000, fakeBin());
    let fired = false;
    t.watch(() => { fired = true; }, () => { fired = true; });
    t.close();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fired, false);
  });

  it("elastic watchdog marks twilight then rebuilds after public health recovers", async () => {
    const t = await openQuickTunnel(9484, 10_000, fakeBin({ name: "elastic", lifetimeMs: 60_000 }));
    let calls = 0;
    const states: TunnelState[] = [];
    const newUrl = new Promise<string>((resolve) => {
      t.watch(resolve, () => {}, {
        elastic: true,
        onState: (state) => states.push(state),
        probe: async () => {
          calls += 1;
          return calls >= 3;
        },
        healthIntervalMs: 20,
        verifyTimeoutMs: 2_000,
      });
    });
    const url = await newUrl;
    assert.equal(url, "https://elastic.trycloudflare.com");
    assert.ok(states.includes("twilight"), states.join(","));
    assert.ok(states.includes("recovering"), states.join(","));
    assert.ok(states.includes("ready"), states.join(","));
    t.close();
  });
});

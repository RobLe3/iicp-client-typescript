// ADR-016: IICP client SDK conformance — #520 Quick-Tunnel escalation (rung 5)
// TypeScript parity with iicp-client-python tests/test_tunnel.py.
//
// Behavior tests (fail if #520 reverts): setup (binary detection), initiation
// (spawn + URL parse + timeout), teardown (close kills child, idempotent),
// supervision (watchdog respawn with NEW url; bounded → onDead).
// A fake `cloudflared` script stands in — no network, no Cloudflare.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  INSTALL_HINT,
  type TunnelState,
  __resetQuickTunnelRateLimitForTests,
  cloudflaredPath,
  openQuickTunnel,
} from "../src/tunnel.js";

function fakeBin(opts: { name?: string; lifetimeMs?: number; silent?: boolean; rateLimited?: boolean } = {}): string {
  const { name = "fake-fox-1234", lifetimeMs = 60_000, silent = false, rateLimited = false } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iicp-tunnel-"));
  const file = path.join(dir, "cloudflared");
  const body = rateLimited
    ? `#!/usr/bin/env node\nconsole.error('ERR Error unmarshaling QuickTunnel response: error code: 1015');\nconsole.error('status_code="429 Too Many Requests"');\nprocess.exit(1);\n`
    : silent
    ? `#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n`
    : `#!/usr/bin/env node\nconsole.error("INF | starting tunnel");\nconsole.error("INF | https://${name}.trycloudflare.com");\nsetTimeout(() => {}, ${lifetimeMs});\n`;
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function useTempIicpHome(): () => void {
  const oldHome = process.env.IICP_HOME;
  const oldStateFile = process.env.IICP_TUNNEL_RATE_LIMIT_STATE_FILE;
  const oldCreateStateFile = process.env.IICP_TUNNEL_CREATE_STATE_FILE;
  const oldCreateLockFile = process.env.IICP_TUNNEL_CREATE_LOCK_FILE;
  const oldCreateMinInterval = process.env.IICP_TUNNEL_CREATE_MIN_INTERVAL_S;
  const oldCreateLease = process.env.IICP_TUNNEL_CREATE_LEASE_S;
  const oldWaitForCapacity = process.env.IICP_TUNNEL_WAIT_FOR_CAPACITY;
  const oldCreateJitter = process.env.IICP_TUNNEL_CREATE_JITTER_MAX_S;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iicp-home-"));
  process.env.IICP_HOME = dir;
  delete process.env.IICP_TUNNEL_RATE_LIMIT_STATE_FILE;
  delete process.env.IICP_TUNNEL_CREATE_STATE_FILE;
  delete process.env.IICP_TUNNEL_CREATE_LOCK_FILE;
  process.env.IICP_TUNNEL_CREATE_MIN_INTERVAL_S = "0";
  process.env.IICP_TUNNEL_CREATE_LEASE_S = "45";
  // Unit cases assert raw coordinator errors; production defaults to waiting
  // in the opener so supervised services do not restart-storm.
  process.env.IICP_TUNNEL_WAIT_FOR_CAPACITY = "0";
  __resetQuickTunnelRateLimitForTests({ clearPersistent: true });
  return () => {
    __resetQuickTunnelRateLimitForTests({ clearPersistent: true });
    if (oldHome === undefined) delete process.env.IICP_HOME;
    else process.env.IICP_HOME = oldHome;
    if (oldStateFile === undefined) delete process.env.IICP_TUNNEL_RATE_LIMIT_STATE_FILE;
    else process.env.IICP_TUNNEL_RATE_LIMIT_STATE_FILE = oldStateFile;
    if (oldCreateStateFile === undefined) delete process.env.IICP_TUNNEL_CREATE_STATE_FILE;
    else process.env.IICP_TUNNEL_CREATE_STATE_FILE = oldCreateStateFile;
    if (oldCreateLockFile === undefined) delete process.env.IICP_TUNNEL_CREATE_LOCK_FILE;
    else process.env.IICP_TUNNEL_CREATE_LOCK_FILE = oldCreateLockFile;
    if (oldCreateMinInterval === undefined) delete process.env.IICP_TUNNEL_CREATE_MIN_INTERVAL_S;
    else process.env.IICP_TUNNEL_CREATE_MIN_INTERVAL_S = oldCreateMinInterval;
    if (oldCreateLease === undefined) delete process.env.IICP_TUNNEL_CREATE_LEASE_S;
    else process.env.IICP_TUNNEL_CREATE_LEASE_S = oldCreateLease;
    if (oldWaitForCapacity === undefined) delete process.env.IICP_TUNNEL_WAIT_FOR_CAPACITY;
    else process.env.IICP_TUNNEL_WAIT_FOR_CAPACITY = oldWaitForCapacity;
    if (oldCreateJitter === undefined) delete process.env.IICP_TUNNEL_CREATE_JITTER_MAX_S;
    else process.env.IICP_TUNNEL_CREATE_JITTER_MAX_S = oldCreateJitter;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

let restoreTempIicpHome: (() => void) | null = null;

beforeEach(() => {
  restoreTempIicpHome = useTempIicpHome();
});

afterEach(() => {
  restoreTempIicpHome?.();
  restoreTempIicpHome = null;
});

describe("setup", () => {
  it("uses only an absolute executable IICP_CLOUDFLARED_PATH override", () => {
    const binary = fakeBin();
    const oldOverride = process.env.IICP_CLOUDFLARED_PATH;
    const oldPath = process.env.PATH;
    try {
      process.env.IICP_CLOUDFLARED_PATH = binary;
      assert.equal(cloudflaredPath(), fs.realpathSync(binary));

      process.env.IICP_CLOUDFLARED_PATH = "relative/cloudflared";
      process.env.PATH = path.dirname(binary);
      assert.equal(cloudflaredPath(), null);

      delete process.env.IICP_CLOUDFLARED_PATH;
      assert.equal(cloudflaredPath(), fs.realpathSync(binary));
    } finally {
      if (oldOverride === undefined) delete process.env.IICP_CLOUDFLARED_PATH;
      else process.env.IICP_CLOUDFLARED_PATH = oldOverride;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      fs.rmSync(path.dirname(binary), { recursive: true, force: true });
    }
  });

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

  it("detects Cloudflare Quick Tunnel rate limits and pauses follow-up creation", async () => {
    await assert.rejects(
      () => openQuickTunnel(9484, 5_000, fakeBin({ rateLimited: true })),
      /rate limit detected/,
    );
    await assert.rejects(
      () => openQuickTunnel(9484, 1_000, fakeBin()),
      /creation paused/,
    );
  });

  it("persists rate-limit cooldown across supervised restarts", async () => {
    await assert.rejects(
      () => openQuickTunnel(9484, 5_000, fakeBin({ rateLimited: true })),
      /rate limit detected/,
    );

    // Simulate process restart: in-memory state is gone, but the node state
    // directory still carries the cooldown marker.
    __resetQuickTunnelRateLimitForTests();

    await assert.rejects(
      () => openQuickTunnel(9484, 1_000, fakeBin()),
      /creation paused/,
    );
  });

  it("spaces local services before creating another accountless Quick Tunnel", async () => {
    process.env.IICP_TUNNEL_CREATE_MIN_INTERVAL_S = "60";
    const t = await openQuickTunnel(9484, 10_000, fakeBin({ name: "paced-one" }));
    t.close();

    await assert.rejects(
      () => openQuickTunnel(9485, 1_000, fakeBin({ name: "paced-two" })),
      /creation paced/,
    );
  });

  it("waits through shared capacity with jitter instead of failing", async () => {
    process.env.IICP_TUNNEL_WAIT_FOR_CAPACITY = "1";
    process.env.IICP_TUNNEL_CREATE_MIN_INTERVAL_S = "2";
    process.env.IICP_TUNNEL_CREATE_JITTER_MAX_S = "0";
    const first = await openQuickTunnel(9484, 10_000, fakeBin({ name: "wait-one" }));
    const gate = JSON.parse(
      fs.readFileSync(path.join(process.env.IICP_HOME ?? "", "state", "quick_tunnel_create_gate.json"), "utf8"),
    ) as { quick_tunnel_create_not_before: number };
    const started = Date.now();
    const remainingBeforeOpen = Math.max(0, gate.quick_tunnel_create_not_before * 1000 - started);
    assert.ok(remainingBeforeOpen > 0, "the first opener must leave an observable pacing interval");
    const second = await openQuickTunnel(9485, 10_000, fakeBin({ name: "wait-two" }));
    try {
      // Process startup time varies by runtime and host. Assert against the
      // persisted remaining gate instead of a fixed wall-clock guess.
      assert.ok(Date.now() - started >= remainingBeforeOpen - 100);
      assert.match(second.url, /wait-two\.trycloudflare\.com$/);
    } finally {
      first.close();
      second.close();
    }
  });

  it("serializes parallel accountless Quick Tunnel creation with a host-wide lease", async () => {
    const lockPath = path.join(process.env.IICP_HOME ?? "", "state", "quick_tunnel_create.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        expires_at: (Date.now() + 60_000) / 1000,
        pid: 12345,
        reason: "test",
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      () => openQuickTunnel(9484, 1_000, fakeBin({ name: "lease-blocked" })),
      /another local IICP node/,
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

  it("elastic watchdog can retry after dead policy", async () => {
    const t = await openQuickTunnel(9484, 10_000, fakeBin({ name: "dead-retry", lifetimeMs: 10 }));
    let deadCalls = 0;
    let stopped!: () => void;
    const stoppedPromise = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    t.watch(() => {}, () => {
      deadCalls += 1;
      if (deadCalls > 1) stopped();
    }, {
      elastic: true,
      onDeadAction: () => deadCalls === 1 ? "retry" : "stop",
      probe: async () => false,
      healthIntervalMs: 20,
      verifyTimeoutMs: 0,
      deadRetryDelayMs: () => 0,
    });
    await stoppedPromise;
    assert.ok(deadCalls >= 2);
    t.close();
  });
});

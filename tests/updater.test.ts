// ADR-016: IICP client SDK conformance — #521 self-updater P1 (TS parity)
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUpdate, isOutdated, npmInstallArgs, parseVersion } from "../src/updater.js";

const updaterTempDir = mkdtempSync(join(tmpdir(), "iicp-updater-test-"));
const updaterStateFile = join(updaterTempDir, "update-status.json");
process.env.IICP_UPDATE_STATE_FILE = updaterStateFile;
beforeEach(() => rmSync(updaterStateFile, { force: true }));
after(() => rmSync(updaterTempDir, { recursive: true, force: true }));

describe("version compare", () => {
  it("isOutdated is numeric, not lexicographic", () => {
    assert.equal(isOutdated("0.7.56", "0.7.57"), true);
    assert.equal(isOutdated("0.7.57", "0.7.57"), false);
    assert.equal(isOutdated("0.7.57", "0.7.56"), false);
    assert.equal(isOutdated("0.7.9", "0.7.10"), true); // not lexicographic
    assert.equal(isOutdated("1.0.0", "0.9.9"), false);
    assert.equal(isOutdated("v0.7.56", "0.7.57"), false);
  });

  it("parseVersion rejects non-stable candidates", () => {
    assert.equal(parseVersion("1.2.3-rc1"), null);
    assert.equal(parseVersion("v1.2.3"), null);
    assert.deepEqual(parseVersion("0.7.57"), [0, 7, 57]);
  });
});

describe("checkUpdate", () => {
  it("flags outdated with the npm upgrade command", () => {
    const v = checkUpdate("0.7.56", "0.7.57");
    assert.equal(v.outdated, true);
    assert.equal(v.command, "npm install -g @iicp/client@0.7.57 --registry=https://registry.npmjs.org");
  });

  it("unknown latest is never outdated", () => {
    assert.equal(checkUpdate("0.7.57", null).outdated, false);
  });
});

describe("npm update command", () => {
  it("pins the candidate and official registry without lifecycle scripts", () => {
    assert.deepEqual(npmInstallArgs("0.7.108"), [
      "install", "-g", "@iicp/client@0.7.108",
      "--registry=https://registry.npmjs.org", "--ignore-scripts",
    ]);
    assert.equal(npmInstallArgs("0.7.108-rc.1"), null);
  });
});

// ── P2 auto-updater (#521) ──────────────────────────────────────────────────────
import { autoUpdateEnabled, autoUpdateInitialDelayMs, autoUpdateIntervalMs, autoUpdateStatusPayload, autoUpdateTick, candidateRetryBlocked, recordUpdateCheck, recordUpdateResult } from "../src/updater.js";

describe("autoUpdateTick (#521 P2)", () => {
  it("upgrades and re-execs when a newer release exists", async () => {
    let reexeced = 0;
    const r = await autoUpdateTick("0.7.59", "0.7.60", true,
      async (version) => version === "0.7.60", () => { reexeced += 1; }, () => {});
    assert.equal(r, "upgraded");
    assert.equal(reexeced, 1);
  });
  it("is a no-op when already current", async () => {
    const r = await autoUpdateTick("0.7.60", "0.7.60", true,
      async (_version) => { throw new Error("must not upgrade"); },
      () => { throw new Error("must not reexec"); }, () => {});
    assert.equal(r, "current");
  });
  it("respects the opt-out", async () => {
    assert.equal(await autoUpdateTick("0.7.59", "0.7.60", false, async (_version) => true, () => {}, () => {}), "disabled");
  });
  it("treats unknown latest as a no-op", async () => {
    assert.equal(await autoUpdateTick("0.7.59", null, true, async (_version) => true, () => {}, () => {}), "unknown");
  });
  it("does not re-exec when the upgrade fails", async () => {
    let reexeced = 0;
    const r = await autoUpdateTick("0.7.59", "0.7.60", true,
      async (_version) => false, () => { reexeced += 1; }, () => {});
    assert.equal(r, "upgrade-failed");
    assert.equal(reexeced, 0);
    assert.equal(candidateRetryBlocked("0.7.60"), true);
  });
  it("backs off the same failed candidate but permits a new candidate", async () => {
    recordUpdateResult("0.7.60", false, "package_install_failed");
    let attempts = 0;
    const r = await autoUpdateTick("0.7.59", "0.7.60", true,
      async () => { attempts += 1; return true; }, () => {}, () => {});
    assert.equal(r, "backoff");
    assert.equal(attempts, 0);
    assert.equal(candidateRetryBlocked("0.7.61"), false);
  });
  it("clears failure state after success", () => {
    recordUpdateResult("0.7.60", false, "package_install_failed");
    recordUpdateResult("0.7.60", true);
    const payload = autoUpdateStatusPayload();
    assert.equal(payload.sdk_update_last_result, "success");
    assert.equal(payload.sdk_update_consecutive_failures, 0);
    assert.equal(payload.sdk_update_next_retry_at, null);
  });
});

describe("autoUpdateInitialDelayMs", () => {
  it("checks within five minutes without changing the regular cadence", () => {
    assert.equal(autoUpdateInitialDelayMs(300_000), 300_000);
    assert.equal(autoUpdateInitialDelayMs(900_000), 300_000);
    assert.equal(autoUpdateInitialDelayMs(21_600_000), 300_000);
  });
});


describe("autoUpdate env controls", () => {
  it("defaults on and respects IICP_AUTO_UPDATE opt-out values", () => {
    const oldValue = process.env.IICP_AUTO_UPDATE;
    try {
      delete process.env.IICP_AUTO_UPDATE;
      assert.equal(autoUpdateEnabled(), true);
      for (const value of ["0", "false", "no", "off"]) {
        process.env.IICP_AUTO_UPDATE = value;
        assert.equal(autoUpdateEnabled(), false);
      }
      process.env.IICP_AUTO_UPDATE = "1";
      assert.equal(autoUpdateEnabled(), true);
    } finally {
      if (oldValue === undefined) delete process.env.IICP_AUTO_UPDATE;
      else process.env.IICP_AUTO_UPDATE = oldValue;
    }
  });
  it("floors interval to five minutes and falls back on bad values", () => {
    const oldValue = process.env.IICP_AUTO_UPDATE_INTERVAL_S;
    try {
      delete process.env.IICP_AUTO_UPDATE_INTERVAL_S;
      assert.equal(autoUpdateIntervalMs(), 3_600_000);
      process.env.IICP_AUTO_UPDATE_INTERVAL_S = "42";
      assert.equal(autoUpdateIntervalMs(), 300_000);
      process.env.IICP_AUTO_UPDATE_INTERVAL_S = "900";
      assert.equal(autoUpdateIntervalMs(), 900_000);
      process.env.IICP_AUTO_UPDATE_INTERVAL_S = "not-a-number";
      assert.equal(autoUpdateIntervalMs(), 3_600_000);
    } finally {
      if (oldValue === undefined) delete process.env.IICP_AUTO_UPDATE_INTERVAL_S;
      else process.env.IICP_AUTO_UPDATE_INTERVAL_S = oldValue;
    }
  });

  it("exposes heartbeat-safe update status", () => {
    const oldUpdate = process.env.IICP_AUTO_UPDATE;
    const oldInterval = process.env.IICP_AUTO_UPDATE_INTERVAL_S;
    try {
      delete process.env.IICP_AUTO_UPDATE;
      delete process.env.IICP_AUTO_UPDATE_INTERVAL_S;
      recordUpdateCheck("0.7.69");
      const payload = autoUpdateStatusPayload();
      assert.equal(payload.auto_update_enabled, true);
      assert.equal(payload.auto_update_interval_s, 3600);
      assert.equal(payload.sdk_latest_seen, "0.7.69");
      assert.ok(payload.sdk_update_last_checked_at);
      assert.equal(payload.sdk_update_error_class, null);
    } finally {
      if (oldUpdate === undefined) delete process.env.IICP_AUTO_UPDATE;
      else process.env.IICP_AUTO_UPDATE = oldUpdate;
      if (oldInterval === undefined) delete process.env.IICP_AUTO_UPDATE_INTERVAL_S;
      else process.env.IICP_AUTO_UPDATE_INTERVAL_S = oldInterval;
    }
  });
});

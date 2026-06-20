// ADR-016: IICP client SDK conformance — #521 self-updater P1 (TS parity)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkUpdate, isOutdated, parseVersion } from "../src/updater.js";

describe("version compare", () => {
  it("isOutdated is numeric, not lexicographic", () => {
    assert.equal(isOutdated("0.7.56", "0.7.57"), true);
    assert.equal(isOutdated("0.7.57", "0.7.57"), false);
    assert.equal(isOutdated("0.7.57", "0.7.56"), false);
    assert.equal(isOutdated("0.7.9", "0.7.10"), true); // not lexicographic
    assert.equal(isOutdated("1.0.0", "0.9.9"), false);
    assert.equal(isOutdated("v0.7.56", "0.7.57"), true); // leading v tolerated
  });

  it("parseVersion truncates pre-release suffixes", () => {
    assert.deepEqual(parseVersion("1.2.3-rc1"), [1, 2, 3]);
    assert.deepEqual(parseVersion("0.7.57"), [0, 7, 57]);
  });
});

describe("checkUpdate", () => {
  it("flags outdated with the npm upgrade command", () => {
    const v = checkUpdate("0.7.56", "0.7.57");
    assert.equal(v.outdated, true);
    assert.equal(v.command, "npm install -g @iicp/client@latest");
  });

  it("unknown latest is never outdated", () => {
    assert.equal(checkUpdate("0.7.57", null).outdated, false);
  });
});

// ── P2 auto-updater (#521) ──────────────────────────────────────────────────────
import { autoUpdateInitialDelayMs, autoUpdateTick } from "../src/updater.js";

describe("autoUpdateTick (#521 P2)", () => {
  it("upgrades and re-execs when a newer release exists", async () => {
    let reexeced = 0;
    const r = await autoUpdateTick("0.7.59", "0.7.60", true,
      async () => true, () => { reexeced += 1; }, () => {});
    assert.equal(r, "upgraded");
    assert.equal(reexeced, 1);
  });
  it("is a no-op when already current", async () => {
    const r = await autoUpdateTick("0.7.60", "0.7.60", true,
      async () => { throw new Error("must not upgrade"); },
      () => { throw new Error("must not reexec"); }, () => {});
    assert.equal(r, "current");
  });
  it("respects the opt-out", async () => {
    assert.equal(await autoUpdateTick("0.7.59", "0.7.60", false, async () => true, () => {}, () => {}), "disabled");
  });
  it("treats unknown latest as a no-op", async () => {
    assert.equal(await autoUpdateTick("0.7.59", null, true, async () => true, () => {}, () => {}), "unknown");
  });
  it("does not re-exec when the upgrade fails", async () => {
    let reexeced = 0;
    const r = await autoUpdateTick("0.7.59", "0.7.60", true,
      async () => false, () => { reexeced += 1; }, () => {});
    assert.equal(r, "upgrade-failed");
    assert.equal(reexeced, 0);
  });
});

describe("autoUpdateInitialDelayMs", () => {
  it("checks within five minutes without changing the regular cadence", () => {
    assert.equal(autoUpdateInitialDelayMs(300_000), 300_000);
    assert.equal(autoUpdateInitialDelayMs(900_000), 300_000);
    assert.equal(autoUpdateInitialDelayMs(21_600_000), 300_000);
  });
});

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

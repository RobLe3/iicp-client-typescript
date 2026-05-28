// ADR-016: IICP client SDK conformance
/** Unit tests for time-based availability windows (parity Block D). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AvailabilityEvaluator } from "../src/availability.js";

function at(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

describe("AvailabilityEvaluator", () => {
  it("no windows → always full", () => {
    const ev = new AvailabilityEvaluator();
    assert.equal(ev.currentShare(at("03:00")), 1.0);
    assert.equal(ev.effectiveMaxConcurrent(4, at("14:00")), 4);
  });

  it("inside a normal window uses its share", () => {
    const ev = new AvailabilityEvaluator([{ start: "08:00", end: "22:00", share: 0.5 }]);
    assert.equal(ev.currentShare(at("12:00")), 0.5);
    assert.equal(ev.effectiveMaxConcurrent(4, at("12:00")), 2);
  });

  it("outside all windows → 0.5", () => {
    const ev = new AvailabilityEvaluator([{ start: "08:00", end: "22:00", share: 1.0 }]);
    assert.equal(ev.currentShare(at("02:00")), 0.5);
  });

  it("effective floors at 1 when share > 0", () => {
    const ev = new AvailabilityEvaluator([{ start: "08:00", end: "22:00", share: 0.1 }]);
    assert.equal(ev.effectiveMaxConcurrent(4, at("10:00")), 1);
  });

  it("midnight-spanning window matches after midnight", () => {
    const ev = new AvailabilityEvaluator([{ start: "22:00", end: "06:00", share: 1.0 }]);
    assert.equal(ev.currentShare(at("23:30")), 1.0);
    assert.equal(ev.currentShare(at("02:00")), 1.0);
    assert.equal(ev.currentShare(at("12:00")), 0.5);
  });

  it("closed window → zero capacity, not within window", () => {
    const ev = new AvailabilityEvaluator([{ start: "00:00", end: "23:59", share: 0.0 }]);
    assert.equal(ev.effectiveMaxConcurrent(4, at("10:00")), 0);
    assert.equal(ev.isWithinWindow(at("10:00")), false);
  });
});

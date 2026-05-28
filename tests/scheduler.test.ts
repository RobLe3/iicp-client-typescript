// ADR-016: IICP client SDK conformance
/** Unit tests for the QoS-aware admission classifier (parity Block C). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  qosPriority,
  isQueueEligible,
  QUEUE_ELIGIBLE,
  QOS_PRIORITY,
} from "../src/scheduler.js";

describe("qosPriority", () => {
  it("orders realtime > interactive > batch", () => {
    assert.ok(qosPriority("realtime") < qosPriority("interactive"));
    assert.ok(qosPriority("interactive") < qosPriority("batch"));
    assert.ok(qosPriority("batch") <= qosPriority("best_effort"));
  });

  it("treats hyphen and underscore spellings the same", () => {
    assert.equal(qosPriority("best-effort"), qosPriority("best_effort"));
  });

  it("defaults unknown / null to lowest priority", () => {
    assert.equal(qosPriority("nonsense"), 3);
    assert.equal(qosPriority(null), 3);
    assert.equal(qosPriority(undefined), 3);
  });
});

describe("isQueueEligible", () => {
  it("makes realtime/interactive eligible", () => {
    assert.ok(isQueueEligible("realtime"));
    assert.ok(isQueueEligible("interactive"));
  });

  it("fails fast for everything else", () => {
    for (const q of ["batch", "best_effort", "best-effort", "unknown"]) {
      assert.ok(!isQueueEligible(q), `${q} should not be queue-eligible`);
    }
    assert.ok(!isQueueEligible(null));
    assert.ok(!isQueueEligible(undefined));
  });

  it("eligible set is exactly realtime+interactive", () => {
    assert.deepEqual([...QUEUE_ELIGIBLE].sort(), ["interactive", "realtime"]);
  });

  it("priority map covers all named tiers", () => {
    for (const tier of ["realtime", "interactive", "batch", "best_effort", "best-effort"]) {
      assert.ok(tier in QOS_PRIORITY);
    }
  });
});

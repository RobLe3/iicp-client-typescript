// SPDX-License-Identifier: Apache-2.0
// Region must never be silently mislabeled `eu-central`.
//
// Regression for the first external operator's report (@shaal, near Miami: set `us-east`, the
// directory showed `eu-central`). Root cause: `--region` defaulted to the truthy `"eu-central"`,
// which both mislabeled non-EU operators AND shadowed the saved-config restore in
// applySavedNode (`opts.region || saved.region`). The fix: undefined default → saved/explicit
// region honored; an unset region registers `"unknown"` (parity with Python/Rust). See #484.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applySavedNode, type ServeOpts } from "../src/cli.js";
import type { NodeIdentity } from "../src/identity.js";

const opts = (region?: string): ServeOpts =>
  ({ region, maxConcurrent: 4, port: 9484, host: "0.0.0.0" }) as ServeOpts;
const saved = (region?: string): NodeIdentity => ({ region }) as NodeIdentity;

test("saved region is honored when --region/IICP_REGION is unset", () => {
  const merged = applySavedNode(opts(undefined), saved("us-east"));
  assert.equal(merged.region, "us-east", "saved region must not be shadowed by a default");
});

test("explicit --region wins over a saved region", () => {
  const merged = applySavedNode(opts("us-west"), saved("us-east"));
  assert.equal(merged.region, "us-west");
});

test("no region anywhere is never silently 'eu-central'", () => {
  const merged = applySavedNode(opts(undefined), saved(undefined));
  // The merge leaves it unset; the node defaults it to "unknown" at registration — never eu-central.
  assert.notEqual(merged.region, "eu-central");
});

// Same class of bug for --host (fixed in Python, missed in TS): the saved-config restore
// sentinel checked `opts.host === "0.0.0.0"` but --host defaults to "::", so a saved host
// was never restored. 3-C parity.
const hostOpts = (host: string): ServeOpts =>
  ({ host, port: 9484, maxConcurrent: 4 }) as ServeOpts;

test("saved host is restored when --host is left at the default '::'", () => {
  const merged = applySavedNode(hostOpts("::"), { host: "10.0.0.5" } as NodeIdentity);
  assert.equal(merged.host, "10.0.0.5", "saved host must be restored (sentinel was '0.0.0.0' vs default '::')");
});

test("explicit --host wins over a saved host", () => {
  const merged = applySavedNode(hostOpts("1.2.3.4"), { host: "10.0.0.5" } as NodeIdentity);
  assert.equal(merged.host, "1.2.3.4");
});

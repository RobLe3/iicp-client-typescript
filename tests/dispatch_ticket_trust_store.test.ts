import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileDispatchTrustBundleStore,
  TrustBundleStoreCorrupt,
  TrustBundleStoreLocked,
  canonicalDispatchTrustBundle,
} from "../src/dispatch_ticket_trust.js";
import type { DispatchTrustBundle } from "../src/dispatch_ticket_trust.js";

const fixture = JSON.parse(readFileSync(new URL("../parity/dispatch-ticket-trust-store-v1.json", import.meta.url), "utf8"));
const bundle = (name: string): DispatchTrustBundle => structuredClone(fixture.bundles[name]);

test("canonical bundle digests match the shared fixture", () => {
  for (const [name, expected] of Object.entries(fixture.canonical_digests as Record<string, string>)) {
    const digest = createHash("sha256").update(canonicalDispatchTrustBundle(bundle(name))).digest("hex");
    assert.equal(`sha256:${digest}`, expected);
  }
});

test("durable trust store follows shared install and recovery sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "iicp-trust-store-"));
  try {
    const path = join(root, "trust", "bundle.state");
    const store = new FileDispatchTrustBundleStore(path);
    let result = store.install(bundle("v1"));
    assert.equal(result.status, "installed");
    assert.equal(result.state?.high_water, 1);
    assert.equal(new FileDispatchTrustBundleStore(path).load()?.bundle.bundle_version, 1);
    assert.equal(store.install(bundle("v1")).status, "unchanged");
    assert.equal(store.install(bundle("v1_conflict")).status, "conflict");
    assert.equal(store.install(bundle("v2"), 1).status, "installed");
    assert.equal(store.install(bundle("v1")).status, "stale");
    assert.equal(store.install(bundle("v2"), 1).status, "conflict");
    assert.equal(store.recover(bundle("v1")).status, "recovery_required");
    result = store.recover(bundle("v1"), { reason: "operator-approved-test-recovery", minimum_high_water: 2 });
    assert.equal(result.status, "recovered");
    assert.equal(result.state?.bundle.bundle_version, 1);
    assert.equal(result.state?.high_water, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corruption, orphan writes, permissions and held locks fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "iicp-trust-store-"));
  try {
    const path = join(root, "trust", "bundle.state");
    const store = new FileDispatchTrustBundleStore(path, { lockTimeoutMs: 0 });
    store.install(bundle("v1"));
    writeFileSync(`${path}.tmp-interrupted`, "partial");
    assert.equal(store.load()?.bundle.bundle_version, 1);
    writeFileSync(path, "{not-json", { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.throws(() => store.load(), TrustBundleStoreCorrupt);
    assert.equal(store.recover(bundle("v1"), { reason: "repair-test", minimum_high_water: 1 }).status, "recovered");
    if (process.platform === "win32") {
      // chmod does not change Windows DACLs. Grant real broad read access.
      execFileSync("icacls.exe", [path, "/grant", "*S-1-1-0:R"], { windowsHide: true });
    } else chmodSync(path, 0o644);
    assert.throws(() => store.load(), TrustBundleStoreCorrupt);

    if (process.platform === "win32") {
      execFileSync("icacls.exe", [path, "/remove:g", "*S-1-1-0"], { windowsHide: true });
    } else chmodSync(path, 0o600);
    writeFileSync(store.lockPath, "held", { mode: 0o600 });
    assert.throws(() => store.install(bundle("v2")), TrustBundleStoreLocked);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symbolic links and invalid versions fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "iicp-trust-store-"));
  try {
    const target = join(root, "target");
    writeFileSync(target, "{}", { mode: 0o600 });
    const path = join(root, "bundle.state");
    symlinkSync(target, path);
    assert.throws(() => new FileDispatchTrustBundleStore(path).load(), TrustBundleStoreCorrupt);
    assert.throws(
      () => new FileDispatchTrustBundleStore(join(root, "trust", "state")).install({ bundle_version: -1, keys: [] }),
      /non-negative/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

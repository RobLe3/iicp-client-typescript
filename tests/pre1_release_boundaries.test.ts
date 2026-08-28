import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
const quality = readFileSync(new URL("../scripts/run-sdk-quality.mjs", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

test("minimum Node version is declared and candidate remains pre-1", () => {
  assert.equal(pkg.engines.node, ">=18.0.0");
  assert.ok(Number(process.versions.node.split(".")[0]) >= 18);
  assert.equal(pkg.version.split(".")[0], "0");
});

test("package version self-report matches the candidate contract", () => {
  assert.equal(pkg.name, "@iicp/client");
  assert.equal(lock.packages[""].version, pkg.version);
  assert.match(cli, /const SDK_VERSION: string = \(require\("\.\.\/package\.json"\)/);
});

test("offline candidate contract pins locked release inputs", () => {
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.match(quality, /npm ci/);
  assert.match(release, /npm ci/);
  assert.match(release, /npm pack --silent --pack-destination release-artifact/);
  assert.match(release, /npm install --ignore-scripts/);
});

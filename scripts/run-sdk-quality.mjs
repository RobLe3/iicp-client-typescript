#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runtimes = ["18", "20", "22", "24"];
const minimum = 75;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  console.error("usage: run-sdk-quality.mjs --output PATH");
  process.exit(2);
}
const output = resolve(process.argv[outputIndex + 1]);
const run = (command, options = {}) => execSync(command, { stdio: "inherit", ...options });
const capture = (...args) => execFileSync(args[0], args.slice(1), { encoding: "utf8" }).trim();

if (capture("git", "status", "--porcelain=v1", "--untracked-files=all")) {
  console.error("SDK quality evidence stopped: worktree is not clean");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const commit = capture("git", "rev-parse", "HEAD");
const runtimeResults = [];
try {
  run("npm ci");
  for (const runtime of runtimes) {
    const command = [
      "node node_modules/typescript/bin/tsc --noEmit",
      "node scripts/check-repository-hygiene.mjs",
      "node scripts/check-dockerfile-security.mjs",
      "node node_modules/tsx/dist/cli.mjs --test tests/*.test.ts",
    ].join(" && ");
    run(`npx --yes --package=node@${runtime} --call '${command}'`);
    runtimeResults.push({ name: runtime, status: "pass" });
  }
  run("npm audit --omit=dev --audit-level=low");
  run("npm run coverage");
  const coverage = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8")).total.lines.pct;
  if (coverage < minimum) throw new Error("coverage below ratchet");
  run("npm run build");
  const temporary = mkdtempSync(join(tmpdir(), "iicp-ts-quality-"));
  const packed = capture("npm", "pack", "--silent", "--pack-destination", temporary).split("\n").at(-1);
  run("npm init -y >/dev/null", { cwd: temporary });
  run(`npm install --ignore-scripts ${JSON.stringify(join(temporary, packed))} >/dev/null`, { cwd: temporary });
  run('node -e \'require("@iicp/client")\' ', { cwd: temporary });

  const evidence = {
    schema: "iicp.sdk-quality-evidence.v1", sdk: "typescript", version: pkg.version,
    commit, generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), status: "pass",
    runtimes: runtimeResults,
    gates: {
      static_analysis: { status: "pass" },
      coverage: { status: "pass", percent: coverage, minimum_percent: minimum },
      dependency_audit: { status: "pass" }, locked_build: { status: "pass" }, clean_install: { status: "pass" },
    },
  };
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`TypeScript SDK quality evidence passed for ${pkg.version}`);
} catch (error) {
  console.error(`SDK quality evidence failed: ${error.message}`);
  process.exit(1);
}

// SPDX-License-Identifier: Apache-2.0
// Behavior tests for the 0.7.40 CLI usability fixes (commit 485e368).
//
// Each test spawns the REAL CLI (tsx src/cli.ts <args>) and asserts stdout /
// stderr / exit code — mirroring tests/proxy_e2e.test.ts. Every assertion would
// FAIL if its 0.7.40 fix were reverted (real behavior, not a smoke test):
//
//   1. `proxy` + the newly-documented serve flags appear in `--help`.
//   2. Subcommand `--help` prints usage and exits 0 with no ERR_PARSE_ARGS / stack.
//   3. Friendly parse errors: bad flag / non-numeric port → clean `ERROR:` (no stack).
//   4. `help` alias prints top-level usage, exit 0.
//   5. `serve --model x` (no --backend-url) gets PAST the model-required check.
//   6. `--no-auto-detect-nat` is accepted; `--auto-detect-nat=false` no longer crashes.
//
// Safety: every spawn uses a throwaway IICP_HOME (real ~/.iicp untouched), a
// dead directory URL (http://127.0.0.1:1) and --skip-registration, so nothing
// is ever registered to a live directory. The long-running serve test binds an
// ephemeral port (IICP_PORT=0) and is killed as soon as it gets past the check.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(repoRoot, "node_modules/.bin/tsx");

// Track every detached `serve` child so we can guarantee the whole tree is reaped
// even if a test throws before finish() — a leaked serve process would keep the
// runner's event loop alive and hang the suite (and `npm test` in the release gate).
const serveChildren = new Set<ReturnType<typeof spawn>>();
function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL"); // negative pid = the process group
  } catch {
    /* already gone */
  }
  serveChildren.delete(child);
}

let tmpHome: string;
before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "iicp-cliux-"));
});
after(() => {
  for (const c of [...serveChildren]) killTree(c); // sweep any survivors
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI to completion and capture stdout/stderr/exit. Safe (temp HOME, no prod). */
function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(TSX, ["src/cli.ts", ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        IICP_HOME: tmpHome,
        // Never let a developer's exported flags leak into the parse tests.
        IICP_AUTO_DETECT_NAT: "",
        IICP_NODE_TOKEN: "",
        IICP_BACKEND_URL: "",
        IICP_PORT: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Spawn `serve` and resolve once it either gets PAST the model-required check
 * (a "backend detected:" / "serving" line appears) or prints the model-required
 * error — then kill the process. Returns the captured streams.
 */
function runServeUntilSignal(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(TSX, ["src/cli.ts", "serve", ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        IICP_HOME: tmpHome,
        IICP_PORT: "0", // ephemeral — never bind the real 9484
        IICP_NODE_TOKEN: "",
        IICP_AUTO_DETECT_NAT: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Detached → the child is a process-group leader, so we can kill the WHOLE
      // tree (tsx → node → serve → http/tcp/NAT children). Killing only `child`
      // leaves those grandchildren alive, holding open handles that wedge the
      // test runner so it never exits (the 0.7.40-era hang). See finish().
      detached: true,
    });
    serveChildren.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      killTree(child);
      resolve({ code: null, stdout, stderr });
    };
    const onData = () => {
      // Past the required-field check once backend detection / serving begins,
      // or terminally on the model-required error.
      if (/backend detected:|\[iicp-node\] serving|--model is required/.test(stderr + stdout)) {
        finish();
      }
    };
    child.stdout.on("data", (c) => {
      stdout += c;
      onData();
    });
    child.stderr.on("data", (c) => {
      stderr += c;
      onData();
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });
    // Hard cap so a hung process can never wedge the suite.
    setTimeout(finish, 25000);
  });
}

const STACK_RE = /at\s+\S+\s+\(.*:\d+:\d+\)|ERR_PARSE_ARGS/;

describe("0.7.40 CLI-UX: top-level help completeness", () => {
  it("`--help` lists the proxy command and the new serve flags", async () => {
    const r = await runCli(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\bproxy\b/, "proxy command must appear in --help");
    assert.match(r.stdout, /--with-proxy/, "serve --with-proxy must be documented");
    assert.match(r.stdout, /--no-auto-detect-nat/, "--no-auto-detect-nat must be documented");
  });

  it("`help` alias prints top-level usage and exits 0", async () => {
    const r = await runCli(["help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout.toLowerCase(), /usage/);
    assert.match(r.stdout, /\bproxy\b/);
    assert.doesNotMatch(r.stderr, STACK_RE);
  });
});

describe("0.7.40 CLI-UX: per-subcommand --help never crashes", () => {
  for (const cmd of [
    ["proxy"],
    ["credits"],
    ["query"],
    ["list"],
    ["update"],
    ["serve"],
    ["operator", "rename"],
    ["operator", "encrypt"],
    ["operator", "decrypt"],
  ]) {
    it(`\`${cmd.join(" ")} --help\` prints usage, exits 0, no parse-arg crash`, async () => {
      const r = await runCli([...cmd, "--help"]);
      assert.equal(r.code, 0, `expected exit 0, got ${r.code} (stderr: ${r.stderr})`);
      assert.match(r.stdout.toLowerCase(), /usage/);
      // The pre-fix behavior crashed with ERR_PARSE_ARGS_UNKNOWN_OPTION + a stack.
      assert.doesNotMatch(r.stderr, STACK_RE, `unexpected stack/parse error: ${r.stderr}`);
    });
  }

  it("side-effectful help does not perform the command", async () => {
    const list = await runCli(["list", "--help"]);
    assert.doesNotMatch(list.stdout, /No saved node configs|Saved nodes/);

    const update = await runCli(["update", "--help"]);
    assert.doesNotMatch(update.stdout, /— up to date|— a newer release|— could not reach/i);

    const encrypt = await runCli(["operator", "encrypt", "--help"]);
    assert.doesNotMatch(encrypt.stdout + encrypt.stderr, /New operator passphrase:/);
  });
});

describe("0.7.40 CLI-UX: friendly parse errors (no raw stack traces)", () => {
  it("`serve --bogusflag` → clean ERROR, non-zero exit, no stack", async () => {
    const r = await runCli(["serve", "--bogusflag"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^ERROR:/m, "must emit a clean ERROR: line");
    assert.doesNotMatch(r.stderr, STACK_RE, `leaked a stack/parse error: ${r.stderr}`);
  });

  it("`serve --port abc` → clean ERROR about the bad port, no stack", async () => {
    const r = await runCli(["serve", "--port", "abc", "--model", "x"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^ERROR:/m);
    assert.match(r.stderr, /port/i, "error should mention the port");
    assert.doesNotMatch(r.stderr, STACK_RE);
  });

  it("`proxy --port abc` → clean ERROR, no stack", async () => {
    const r = await runCli(["proxy", "--port", "abc"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^ERROR:/m);
    assert.doesNotMatch(r.stderr, STACK_RE);
  });
});

describe("0.7.40 CLI-UX: serve --model parity + NAT off-switch", () => {
  it("`serve --model x` (no --backend-url) gets past the model-required check", async () => {
    const r = await runServeUntilSignal([
      "--model",
      "test-model",
      "--backend-type",
      "anthropic", // detectBackendFlavor short-circuits → fast, no backend probe
      "--skip-registration",
      "--no-auto-detect-nat",
      "--directory-url",
      "http://127.0.0.1:1", // dead — never reaches a real directory
    ]);
    const combined = r.stdout + r.stderr;
    // The fix applies the backend-url default unconditionally, so a bare
    // `serve --model x` must NOT die on the misleading "--model is required".
    assert.doesNotMatch(
      combined,
      /--model is required/,
      `serve --model x wrongly hit the model-required error: ${combined}`,
    );
    assert.match(
      combined,
      /backend detected:|\[iicp-node\] serving/,
      `serve did not get past the required-field check: ${combined}`,
    );
  });

  it("`serve --no-auto-detect-nat` is accepted (no unknown-option crash)", async () => {
    const r = await runServeUntilSignal([
      "--model",
      "test-model",
      "--backend-type",
      "anthropic",
      "--skip-registration",
      "--no-auto-detect-nat",
      "--directory-url",
      "http://127.0.0.1:1",
    ]);
    const combined = r.stdout + r.stderr;
    assert.doesNotMatch(combined, /unknown option/i, `--no-auto-detect-nat rejected: ${combined}`);
    assert.doesNotMatch(combined, STACK_RE);
    assert.match(combined, /backend detected:|\[iicp-node\] serving/);
  });

  it("`serve --auto-detect-nat=false` no longer crashes with a raw stack", async () => {
    // Pre-fix this surfaced as an ERR_PARSE_ARGS stack; post-fix it's a clean
    // friendly ERROR (boolean flags take no '=value'), never a raw trace.
    const r = await runCli(["serve", "--auto-detect-nat=false", "--model", "x"]);
    assert.doesNotMatch(r.stderr, STACK_RE, `leaked a raw stack: ${r.stderr}`);
  });
});

describe("WQ-066 CLI-UX: serve --relay-capable flag (0.7.45)", () => {
  it("`serve --relay-capable` is accepted without error (0.7.45)", async () => {
    // Pre-fix: parseArgs didn't include --relay-capable → ERR_PARSE_ARGS crash.
    // Post-fix: the flag is registered and serve proceeds past arg parsing.
    const r = await runServeUntilSignal([
      "--model",
      "test-model",
      "--backend-type",
      "anthropic",
      "--skip-registration",
      "--no-auto-detect-nat",
      "--relay-capable",
      "--directory-url",
      "http://127.0.0.1:1",
    ]);
    const combined = r.stdout + r.stderr;
    assert.doesNotMatch(combined, /unknown option|ERR_PARSE_ARGS/i,
      `--relay-capable was rejected: ${combined}`);
    assert.doesNotMatch(combined, /Error:.*relay/i,
      `unexpected relay error: ${combined}`);
  });

  it("`serve --relay-accept-port 9490` is accepted without error (0.7.45)", async () => {
    // Pre-fix: --relay-accept-port was not registered → parse crash.
    const r = await runServeUntilSignal([
      "--model",
      "test-model",
      "--backend-type",
      "anthropic",
      "--skip-registration",
      "--no-auto-detect-nat",
      "--relay-accept-port",
      "9490",
      "--directory-url",
      "http://127.0.0.1:1",
    ]);
    const combined = r.stdout + r.stderr;
    assert.doesNotMatch(combined, /unknown option|ERR_PARSE_ARGS/i,
      `--relay-accept-port was rejected: ${combined}`);
  });

  it("`serve --help` includes --relay-capable (0.7.45)", async () => {
    const r = await runCli(["serve", "--help"]);
    assert.match(r.stdout + r.stderr, /--relay-capable/,
      `--relay-capable missing from serve --help`);
  });
});

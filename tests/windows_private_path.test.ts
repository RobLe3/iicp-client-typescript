import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { privatePathCommand, windowsPrivatePath } from "../src/windows_private_path.js";

const windows = process.platform === "win32";

test("ACL commands encode paths and reject invalid operations", () => {
  const path = resolve("quoted '$; path");
  const command = privatePathCommand(path, "file-check");
  assert.ok(!command.includes(path));
  assert.ok(command.includes(Buffer.from(path).toString("base64")));
  assert.throws(() => privatePathCommand("relative", "file-check"));
  assert.throws(() => privatePathCommand(`${path}\0`, "file-check"));
  assert.throws(() => privatePathCommand(path, "bad'" as "file-check"));
});

test("Windows private paths create exclusive files and reject broadened ACLs", { skip: !windows }, () => {
  const root = mkdtempSync(join(tmpdir(), "iicp-acl-"));
  const directory = join(root, "private");
  const path = join(directory, "state");
  try {
    windowsPrivatePath(directory, "directory-create");
    windowsPrivatePath(directory, "directory-create"); // idempotent, not an ACL repair
    windowsPrivatePath(path, "file-create");
    writeFileSync(path, "preserved");
    windowsPrivatePath(path, "file-check");
    assert.throws(() => windowsPrivatePath(path, "file-create"), { code: "EEXIST" });
    assert.equal(readFileSync(path, "utf8"), "preserved");
    execFileSync("icacls.exe", [path, "/grant", "*S-1-1-0:R"]);
    assert.throws(() => windowsPrivatePath(path, "file-check"));
    execFileSync("icacls.exe", [path, "/remove:g", "*S-1-1-0"]);
    windowsPrivatePath(path, "file-check");
    const inherited = join(directory, "inherited");
    writeFileSync(inherited, "fixture");
    execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)R"]);
    assert.throws(() => windowsPrivatePath(directory, "directory-create"));
    assert.throws(() => windowsPrivatePath(inherited, "file-check")); // inherited broad ACE
    execFileSync("icacls.exe", [directory, "/remove:g", "*S-1-1-0"]);
    windowsPrivatePath(directory, "directory-check");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows private paths reject junction ancestors and file-kind mismatches", { skip: !windows }, () => {
  const root = mkdtempSync(join(tmpdir(), "iicp-acl-link-"));
  try {
    const target = join(root, "target");
    windowsPrivatePath(target, "directory-create");
    const link = join(root, "alias");
    symlinkSync(target, link, "junction");
    assert.throws(() => windowsPrivatePath(join(link, "state"), "file-create"));
    assert.throws(() => windowsPrivatePath(target, "file-check"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows private paths fail closed when the security tool is unavailable", { skip: !windows }, () => {
  const previous = process.env.SystemRoot;
  try {
    process.env.SystemRoot = resolve("nonexistent-security-tool");
    assert.throws(() => windowsPrivatePath(resolve("state"), "file-check"), /ACL verification failed/);
    delete process.env.SystemRoot;
    assert.throws(() => windowsPrivatePath(resolve("state"), "file-check"), /unavailable/);
  } finally { process.env.SystemRoot = previous; }
});

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const trackedArchives = spawnSync(
  "git",
  ["ls-files", "--", "*.tgz"],
  { encoding: "utf8" },
);

function archiveFiles(path = ".") {
  const found = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if ([".git", "dist", "node_modules"].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) found.push(...archiveFiles(child));
    else if (entry.name.endsWith(".tgz")) found.push(child);
  }
  return found;
}

let files;
if (trackedArchives.error?.code === "ENOENT") {
  // Clean package-validation containers need not install Git merely to prove
  // that the source tree contains no package archives.
  files = archiveFiles().join("\n");
} else if (trackedArchives.status !== 0) {
  process.stderr.write(trackedArchives.stderr ?? "git ls-files failed\n");
  process.exit(trackedArchives.status ?? 1);
} else {
  files = trackedArchives.stdout.trim();
}

if (files) {
  process.stderr.write(`Package archives must not be tracked:\n${files}\n`);
  process.exit(1);
}

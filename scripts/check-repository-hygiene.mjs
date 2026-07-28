import { spawnSync } from "node:child_process";

const trackedArchives = spawnSync(
  "git",
  ["ls-files", "--", "*.tgz"],
  { encoding: "utf8" },
);

if (trackedArchives.status !== 0) {
  process.stderr.write(trackedArchives.stderr);
  process.exit(trackedArchives.status ?? 1);
}

const files = trackedArchives.stdout.trim();
if (files) {
  process.stderr.write(`Package archives must not be tracked:\n${files}\n`);
  process.exit(1);
}

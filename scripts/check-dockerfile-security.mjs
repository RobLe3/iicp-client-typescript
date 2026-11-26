import assert from "node:assert/strict";
import fs from "node:fs";

const dockerfile = fs.readFileSync("Dockerfile", "utf8");
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const engineRange = manifest.engines.node;
assert.equal(lockfile.packages[""].engines.node, engineRange, "lockfile root must retain the published Node range");
const supportedMajors = engineRange.split(/\s*\|\|\s*/).map((clause) => {
  const match = /^\^(\d+)\.0\.0$/.exec(clause);
  assert.ok(match, `unexpected Node engine clause: ${clause}`);
  return match[1];
});
const bases = [...dockerfile.matchAll(/^FROM[ \t]+(.+)$/gm)].map((line) => line[1]);
assert.equal(bases.length, 2, "expect one build and one runtime base");
assert.deepEqual(bases.map((base) => base.split(" AS ")[1]), ["build", "runtime"]);
const images = bases.map((base) => {
  const match = /^node:(\d+)\.\d+\.\d+-slim@sha256:[0-9a-f]{64}(?= AS )/.exec(base);
  assert.ok(match, "use an exact digest-pinned Node slim image in each stage");
  assert.ok(supportedMajors.includes(match[1]), `container Node major ${match[1]} is outside ${engineRange}`);
  return match[0];
});
assert.equal(images[0], images[1], "build and runtime must use the same approved Node image");
assert.match(dockerfile, /RUN npm ci\b/, "container dependencies must use npm ci");
assert.doesNotMatch(dockerfile, /releases\/latest\//, "external binaries must not use an unpinned latest URL");
assert.match(dockerfile, /ARG CLOUDFLARED_VERSION=\d{4}\.\d+\.\d+/, "cloudflared version must be pinned");
assert.match(dockerfile, /sha256sum --check --strict/, "cloudflared download must be digest-verified");
assert.match(dockerfile, /COPY --chown=node:node/, "runtime files must belong to the runtime user");
assert.match(dockerfile, /^USER node$/m, "runtime must not execute as root");
console.log("Dockerfile security contract passed");

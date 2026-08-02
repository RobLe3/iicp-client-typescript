import assert from "node:assert/strict";
import fs from "node:fs";

const dockerfile = fs.readFileSync("Dockerfile", "utf8");
assert.match(dockerfile, /RUN npm ci\b/, "container dependencies must use npm ci");
assert.doesNotMatch(dockerfile, /releases\/latest\//, "external binaries must not use an unpinned latest URL");
assert.match(dockerfile, /ARG CLOUDFLARED_VERSION=\d{4}\.\d+\.\d+/, "cloudflared version must be pinned");
assert.match(dockerfile, /sha256sum --check --strict/, "cloudflared download must be digest-verified");
assert.match(dockerfile, /COPY --chown=node:node/, "runtime files must belong to the runtime user");
assert.match(dockerfile, /^USER node$/m, "runtime must not execute as root");
console.log("Dockerfile security contract passed");

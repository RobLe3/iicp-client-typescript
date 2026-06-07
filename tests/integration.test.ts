// SPDX-License-Identifier: Apache-2.0
// Live-mesh integration tests (#3) — OPT-IN.
//
// The rest of the suite mocks the directory; nothing exercises a REAL IICP node. These do,
// against the live mesh, and are skipped unless explicitly enabled:
//   IICP_INTEGRATION_TEST=1  → discover (read-only, safe)
//   IICP_INTEGRATION_CHAT=1  → submit a real task to a live operator's node
// Override the directory with IICP_DIRECTORY_URL. Unblocked once a node registered a routable
// public endpoint (W-011 resolved; an external operator runs https://iicp.shaal.dev).
import { test } from "node:test";
import assert from "node:assert/strict";

import { IicpClient } from "../src/client.js";
import type { ClientConfig } from "../src/types.js";

const DIRECTORY = process.env.IICP_DIRECTORY_URL ?? "https://iicp.network/api";
const CHAT_INTENT = "urn:iicp:intent:llm:chat:v1";
const cfg: ClientConfig = { directory_url: DIRECTORY, timeout_ms: 30_000, tls_verify: true };

test(
  "live discover returns routable chat nodes",
  { skip: process.env.IICP_INTEGRATION_TEST ? false : "set IICP_INTEGRATION_TEST=1" },
  async () => {
    const client = new IicpClient(cfg);
    const nodes = await client.discover(CHAT_INTENT);
    assert.ok(nodes.length > 0, "live directory returned no chat nodes");
    assert.ok(
      nodes[0].endpoint.startsWith("http"),
      `node endpoint is not routable: ${nodes[0].endpoint}`,
    );
  },
);

test(
  "live chat returns a non-empty reply",
  { skip: process.env.IICP_INTEGRATION_CHAT ? false : "set IICP_INTEGRATION_CHAT=1" },
  async () => {
    const client = new IicpClient(cfg);
    const resp = await client.chat([{ role: "user", content: "Reply with the single word: OK" }], {
      max_tokens: 16,
    });
    assert.ok(resp.choices?.[0]?.message?.content, "chat reply was empty");
  },
);

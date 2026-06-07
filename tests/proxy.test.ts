// SPDX-License-Identifier: Apache-2.0
// Proxy gateway conformance (ADR-050) — runs the shared golden fixtures against
// the in-process gateway with a mocked IICP client. Mirrors the Python proxy
// behaviour per project/proxy-unification-contract.md. The 4 CIP fixtures
// (402/503) need the CIP-dispatch port (#482) and are skipped in v1.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";

import { createProxyServer, type TaskClient } from "../src/proxy/index.js";
import { IicpError } from "../src/errors.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dir, "proxy_fixtures.json"), "utf8")) as {
  cases: Array<{
    name: string;
    request: { method: string; path: string; body?: unknown };
    mock: { kind: string; value?: unknown };
    expect: Record<string, unknown>;
  }>;
};

// CIP gating (402/503) requires the proxy CIP-dispatch port — out of scope for the TS v1 gateway (#482).
const CIP_SKIP = new Set(["openai_insufficient_credits", "openai_no_eligible_workers", "ollama_insufficient_credits", "anthropic_no_eligible_workers"]);

function mockClient(mock: { kind: string; value?: unknown }): TaskClient {
  return {
    async submit() {
      if (mock.kind === "iicp_response") return mock.value as { status: string; result?: unknown; error?: { code?: string } };
      if (mock.kind === "no_nodes") throw new IicpError("No nodes available", "SDK-03");
      throw new IicpError("unexpected mock", "SDK-99");
    },
  };
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, seg) => {
    if (acc == null) return undefined;
    const a = acc as Record<string, unknown> | unknown[];
    return /^\d+$/.test(seg) ? (a as unknown[])[Number(seg)] : (a as Record<string, unknown>)[seg];
  }, obj);
}

async function call(server: ReturnType<typeof createProxyServer>, req: { method: string; path: string; body?: unknown }) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${req.path}`, {
      method: req.method,
      headers: req.body ? { "Content-Type": "application/json" } : undefined,
      body: req.body ? JSON.stringify(req.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", server: res.headers.get("server") ?? "", text };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("proxy gateway conformance (golden fixtures)", () => {
  for (const fx of fixtures.cases) {
    const run = CIP_SKIP.has(fx.name) ? it.skip : it;
    run(fx.name, async () => {
      const server = createProxyServer(mockClient(fx.mock));
      const out = await call(server, fx.request);
      const exp = fx.expect;

      assert.equal(out.status, exp.status, `status for ${fx.name}`);
      // The proxy self-identifies as iicp-proxy on every response (universal contract rule).
      assert.equal(out.server, "iicp-proxy", `Server header for ${fx.name}`);
      if (exp.content_type) assert.ok(out.contentType.startsWith(exp.content_type as string), `content-type ${out.contentType}`);

      if (exp.body_path) {
        const body = JSON.parse(out.text);
        for (const [p, v] of Object.entries(exp.body_path as Record<string, unknown>)) {
          assert.deepEqual(get(body, p), v, `${fx.name} body_path ${p}`);
        }
      }
      if (exp.body_prefix) {
        const body = JSON.parse(out.text);
        for (const [p, v] of Object.entries(exp.body_prefix as Record<string, string>)) {
          assert.ok(String(get(body, p)).startsWith(v), `${fx.name} body_prefix ${p}`);
        }
      }
      if (exp.ndjson_last_path) {
        const lines = out.text.trim().split("\n").filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]);
        for (const [p, v] of Object.entries(exp.ndjson_last_path as Record<string, unknown>)) {
          assert.deepEqual(get(last, p), v, `${fx.name} ndjson ${p}`);
        }
      }
      if (exp.sse_event_types) {
        const types = [...out.text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
        assert.deepEqual(types, exp.sse_event_types, `${fx.name} sse events`);
      }
    });
  }
});

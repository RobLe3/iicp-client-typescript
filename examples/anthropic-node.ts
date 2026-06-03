// SPDX-License-Identifier: Apache-2.0
//
// Provider-side example — serve Claude to the IICP mesh via the native
// Anthropic Messages API (no OpenAI-compat shim).
//
// Equivalent to running:
//   iicp-node serve --backend-type anthropic \
//     --backend-api-key "$ANTHROPIC_API_KEY" --model claude-opus-4-8
//
// The anthropicHandler translates an IICP llm:chat:v1 task into an Anthropic
// Messages request and maps the response back to the OpenAI chat-completion
// shape, so a Claude node looks identical to an Ollama/vLLM node to any client.
//
// Prereqs:
//   - An Anthropic API key in ANTHROPIC_API_KEY.
//
// Run:
//   npm install @iicp/client
//   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/anthropic-node.ts

import { randomBytes } from "node:crypto";
import { IicpNode, anthropicHandler } from "@iicp/client";

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("set ANTHROPIC_API_KEY");
  }
  const model = process.env.IICP_BACKEND_MODEL ?? "claude-opus-4-8";
  const port = parseInt(process.env.IICP_PORT ?? "8020", 10);
  const publicEndpoint =
    process.env.IICP_PUBLIC_ENDPOINT ?? `http://localhost:${port}`;

  const node = new IicpNode({
    nodeId: `claude-example-${randomBytes(4).toString("hex")}`,
    endpoint: publicEndpoint,
    intent: "urn:iicp:intent:llm:chat:v1",
    model,
    region: "local",
    maxConcurrent: 4,
  });

  // baseUrl defaults to https://api.anthropic.com/v1; the key is sent as x-api-key.
  const handler = anthropicHandler({ apiKey, model });

  // In production: `const token = await node.register()` and pass it as
  // `nodeToken` so heartbeats fire. Skipped here for the offline example.
  console.log(`serving on 127.0.0.1:${port} → Anthropic Messages API (${model})`);
  const stop = node.serve(handler, { host: "127.0.0.1", port });
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

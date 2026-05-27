// SPDX-License-Identifier: Apache-2.0
//
// Provider-side example — register and serve one IICP node.
//
// Equivalent to running `iicp-node serve --model qwen2.5:0.5b --backend-url
// http://localhost:11434` (the CLI is the recommended path; this example
// shows the building blocks if you want a custom handler).
//
// Prereqs:
//   - An OpenAI-compatible backend at IICP_BACKEND_URL (Ollama, vLLM, ...)
//   - Set IICP_BACKEND_URL + IICP_BACKEND_MODEL, or edit the constants below.
//
// Run:
//   npm install @iicp/client
//   IICP_BACKEND_URL=http://localhost:11434 \
//     IICP_BACKEND_MODEL=qwen2.5:0.5b \
//     npx tsx examples/node.ts

import { randomBytes } from "node:crypto";
import { IicpNode, openaiCompatHandler } from "@iicp/client";

async function main(): Promise<void> {
  const backendUrl = process.env.IICP_BACKEND_URL ?? "http://localhost:11434";
  const model = process.env.IICP_BACKEND_MODEL ?? "qwen2.5:0.5b";
  const port = parseInt(process.env.IICP_PORT ?? "8020", 10);
  const publicEndpoint =
    process.env.IICP_PUBLIC_ENDPOINT ?? `http://localhost:${port}`;

  const node = new IicpNode({
    nodeId: `sdk-example-${randomBytes(4).toString("hex")}`,
    endpoint: publicEndpoint,
    intent: "urn:iicp:intent:llm:chat:v1",
    model,
    region: "local",
    maxConcurrent: 4,
  });
  const handler = openaiCompatHandler({ baseUrl: backendUrl, model });

  // In production: `const token = await node.register()` and pass it as
  // `nodeToken` so heartbeats fire. Skipped here for the offline example.
  console.log(`serving on 127.0.0.1:${port} → ${backendUrl} (${model})`);
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

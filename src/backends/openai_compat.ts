// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAI-compatible backend helper (Ollama / LM Studio / OpenAI / ...).
 *
 * Thin factory over the shared `buildOpenAiDialectHandler` core. Returns a TaskHandler
 * suitable for IicpNode.serve() AND IicpTcpServer.
 *
 *   import { openaiCompatHandler } from "@iicp/client";
 *
 *   const handler = openaiCompatHandler({
 *     baseUrl: "http://localhost:11434/v1",  // Ollama
 *     model: "qwen2.5:0.5b",
 *   });
 *   await node.serve(handler, { port: 8080, nodeToken });
 *
 * Intent routing matches the Python module + adapter reference:
 *
 *   urn:iicp:intent:llm:chat:v1        → /chat/completions
 *   urn:iicp:intent:llm:completion:v1  → /completions
 *   urn:iicp:intent:llm:embedding:v1   → /embeddings
 */

import {
  buildOpenAiDialectHandler,
  type BackendHandler,
  type TaskHandlerInput,
  type TaskHandlerOutput,
} from "./base.js";

export interface OpenAiCompatOptions {
  /** Provider HTTP root (no trailing slash needed). Default: Ollama `http://localhost:11434/v1`. */
  baseUrl?: string;
  /** Default model name. If unset, the task payload MUST include `model`. */
  model?: string;
  /** Bearer token for the provider. Empty for local Ollama/vLLM. */
  apiKey?: string;
  /** Per-request HTTP timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

export type { TaskHandlerInput, TaskHandlerOutput };

export function openaiCompatHandler(opts: OpenAiCompatOptions = {}): BackendHandler {
  return buildOpenAiDialectHandler(
    "openai_compat",
    opts.baseUrl ?? "http://localhost:11434/v1",
    opts.model,
    opts.apiKey ?? "",
    opts.timeoutMs ?? 30000
  );
}

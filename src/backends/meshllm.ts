// SPDX-License-Identifier: Apache-2.0
/** MeshLLM local OpenAI-compatible backend. */

import { buildOpenAiDialectHandler, type BackendHandler } from "./base.js";

const CHAT_INTENT = "urn:iicp:intent:llm:chat:v1";

export interface MeshLlmOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/** Stable MeshLLM profile: local HTTP chat only; no peer/control-plane coupling. */
export function meshllmHandler(opts: MeshLlmOptions = {}): BackendHandler {
  const openAiHandler = buildOpenAiDialectHandler(
    "meshllm", opts.baseUrl ?? "http://localhost:9337/v1", opts.model,
    opts.apiKey ?? "", opts.timeoutMs ?? 30000,
  );
  return async (task) => {
    if (task.intent !== CHAT_INTENT) {
      return { error_code: 400, error_message: "MeshLLM stable backend supports llm:chat:v1 only" };
    }
    return openAiHandler(task);
  };
}

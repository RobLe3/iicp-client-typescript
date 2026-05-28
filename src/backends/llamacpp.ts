// SPDX-License-Identifier: Apache-2.0
/**
 * llama.cpp backend handler.
 *
 * The `llama-server` binary exposes an OpenAI-compatible `/v1/*` API, so this is a thin
 * factory over the shared core with llama.cpp's default port (8080). Kept as a dedicated
 * module so operators can select `backendType=llamacpp` explicitly. Port of iicp-adapter
 * backends/llamacpp.py (parity Block B).
 */

import { buildOpenAiDialectHandler, type BackendHandler } from "./base.js";

export interface LlamaCppOptions {
  /** Provider HTTP root. Default: llama.cpp `http://localhost:8080/v1`. */
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export function llamacppHandler(opts: LlamaCppOptions = {}): BackendHandler {
  return buildOpenAiDialectHandler(
    "llamacpp",
    opts.baseUrl ?? "http://localhost:8080/v1",
    opts.model,
    opts.apiKey ?? "",
    opts.timeoutMs ?? 30000
  );
}

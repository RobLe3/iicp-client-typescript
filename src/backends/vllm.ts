// SPDX-License-Identifier: Apache-2.0
/**
 * vLLM backend handler.
 *
 * vLLM's OpenAI server (`python -m vllm.entrypoints.openai.api_server`) speaks the
 * standard `/v1/*` dialect, so this is a thin factory over the shared core with vLLM's
 * default port (8000). Kept as a dedicated module so operators can select
 * `backendType=vllm` explicitly. Port of iicp-adapter backends/vllm.py (parity Block B).
 */

import { buildOpenAiDialectHandler, type BackendHandler } from "./base.js";

export interface VllmOptions {
  /** Provider HTTP root. Default: vLLM `http://localhost:8000/v1`. */
  baseUrl?: string;
  model?: string;
  /** Optional — set only when vLLM was started with `--api-key`. */
  apiKey?: string;
  timeoutMs?: number;
}

export function vllmHandler(opts: VllmOptions = {}): BackendHandler {
  return buildOpenAiDialectHandler(
    "vllm",
    opts.baseUrl ?? "http://localhost:8000/v1",
    opts.model,
    opts.apiKey ?? "",
    opts.timeoutMs ?? 30000
  );
}

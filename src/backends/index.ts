// SPDX-License-Identifier: Apache-2.0
/**
 * Backend handler registry + selector.
 *
 * Each helper returns a TaskHandler suitable for IicpNode.serve() or IicpTcpServer.
 * Use `getBackendHandler(type, opts)` to select one by name (e.g. from a CLI
 * `--backend-type` flag).
 */

import { type BackendHandler, type BackendOptions } from "./base.js";
import { openaiCompatHandler } from "./openai_compat.js";
import { vllmHandler } from "./vllm.js";
import { llamacppHandler } from "./llamacpp.js";
import { anthropicHandler } from "./anthropic.js";

export const BACKEND_TYPES = ["openai_compat", "vllm", "llamacpp", "anthropic"] as const;
export type BackendType = (typeof BACKEND_TYPES)[number];

const FACTORIES: Record<BackendType, (opts: BackendOptions) => BackendHandler> = {
  openai_compat: openaiCompatHandler,
  vllm: vllmHandler,
  llamacpp: llamacppHandler,
  anthropic: anthropicHandler,
};

/** Return a backend handler by name. Throws on an unknown type. */
export function getBackendHandler(backendType: string, opts: BackendOptions = {}): BackendHandler {
  const factory = FACTORIES[backendType as BackendType];
  if (!factory) {
    throw new Error(
      `unknown backend_type ${JSON.stringify(backendType)}; choose one of ${JSON.stringify(BACKEND_TYPES)}`
    );
  }
  return factory(opts);
}

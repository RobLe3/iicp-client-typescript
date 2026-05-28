// SPDX-License-Identifier: Apache-2.0
/**
 * Shared core for OpenAI-dialect backend handlers.
 *
 * vLLM, llama.cpp, LM Studio and Ollama all speak the OpenAI `/v1/*` HTTP dialect, so
 * the request/response plumbing is identical — only the default port and the engine
 * label in error messages differ. This module hosts that shared plumbing so the
 * per-engine modules (openai_compat, vllm, llamacpp) stay thin.
 *
 * Port of iicp-adapter backends/{base,vllm,llamacpp,openai_compat} into the SDK's
 * handler-factory style (tracker iicp.network#340; parity Block B).
 */

export const INTENT_TO_PATH: Record<string, string> = {
  "urn:iicp:intent:llm:chat:v1": "/chat/completions",
  "urn:iicp:intent:llm:completion:v1": "/completions",
  "urn:iicp:intent:llm:embedding:v1": "/embeddings",
};

export interface BackendOptions {
  /** Provider HTTP root (no trailing slash needed). */
  baseUrl?: string;
  /** Default model name. If unset, the task payload MUST include `model`. */
  model?: string;
  /** Bearer token for the provider. Empty for local Ollama/vLLM. */
  apiKey?: string;
  /** Per-request HTTP timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

export type TaskHandlerInput = {
  task_id?: string;
  intent?: string;
  payload?: Record<string, unknown>;
};

export type TaskHandlerOutput = Record<string, unknown>;

export type BackendHandler = (task: TaskHandlerInput) => Promise<TaskHandlerOutput>;

/**
 * Build a TaskHandler that proxies CALLs to an OpenAI-dialect server. `engine` is the
 * label used in error messages (e.g. "vllm"); all engines share this body.
 */
export function buildOpenAiDialectHandler(
  engine: string,
  baseUrlRaw: string,
  model: string | undefined,
  apiKey: string,
  timeoutMs: number
): BackendHandler {
  const baseUrl = baseUrlRaw.replace(/\/$/, "");

  return async function handler(task: TaskHandlerInput): Promise<TaskHandlerOutput> {
    const intent = String(task.intent ?? "");
    const payload = task.payload;
    if (
      payload !== undefined &&
      payload !== null &&
      (typeof payload !== "object" || Array.isArray(payload))
    ) {
      return {
        error_code: 400,
        error_message: `${engine}: task.payload must be a dict, got ${typeof payload}`,
      };
    }

    const path = INTENT_TO_PATH[intent];
    if (!path) {
      return {
        error_code: 400,
        error_message: `${engine}: unsupported intent ${JSON.stringify(intent)}; supported: ${JSON.stringify(
          Object.keys(INTENT_TO_PATH).sort()
        )}`,
      };
    }

    const body: Record<string, unknown> = { ...((payload as Record<string, unknown>) ?? {}) };
    if (body.model === undefined && model !== undefined) body.model = model;
    if (!body.model) {
      return {
        error_code: 400,
        error_message:
          `${engine}: no model — either pass \`model\` to the backend factory ` +
          "or include `model` in the task payload",
      };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (exc) {
      clearTimeout(t);
      const msg = exc instanceof Error ? exc.message : String(exc);
      if (ctrl.signal.aborted) {
        return { error_code: 408, error_message: `${engine}: backend timed out` };
      }
      return { error_code: 502, error_message: `${engine}: HTTP transport error: ${msg}` };
    }
    clearTimeout(t);

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        error_code: resp.status,
        error_message: `${engine}: upstream ${resp.status}: ${text.slice(0, 512)}`,
      };
    }

    let data: unknown;
    try {
      data = await resp.json();
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      return { error_code: 502, error_message: `${engine}: upstream returned non-JSON: ${msg}` };
    }

    return { result: data };
  };
}

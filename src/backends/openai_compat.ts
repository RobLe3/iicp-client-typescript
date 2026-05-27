// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAI-compatible backend helper (Ollama / vLLM / LM Studio / OpenAI / ...).
 *
 * TypeScript port of iicp-client-python's backends/openai_compat.py (iter-1423).
 * Returns a TaskHandler suitable for IicpNode.serve() AND IicpTcpServer.
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

const INTENT_TO_PATH: Record<string, string> = {
  "urn:iicp:intent:llm:chat:v1": "/chat/completions",
  "urn:iicp:intent:llm:completion:v1": "/completions",
  "urn:iicp:intent:llm:embedding:v1": "/embeddings",
};

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

export type TaskHandlerInput = {
  task_id?: string;
  intent?: string;
  payload?: Record<string, unknown>;
};

export type TaskHandlerOutput = Record<string, unknown>;

export function openaiCompatHandler(
  opts: OpenAiCompatOptions = {}
): (task: TaskHandlerInput) => Promise<TaskHandlerOutput> {
  const baseUrl = (opts.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, "");
  const model = opts.model;
  const apiKey = opts.apiKey ?? "";
  const timeoutMs = opts.timeoutMs ?? 30000;

  return async function handler(task: TaskHandlerInput): Promise<TaskHandlerOutput> {
    const intent = String(task.intent ?? "");
    const payload = task.payload;
    if (payload !== undefined && payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
      return {
        error_code: 400,
        error_message: `openai_compat: task.payload must be a dict, got ${typeof payload}`,
      };
    }

    const path = INTENT_TO_PATH[intent];
    if (!path) {
      return {
        error_code: 400,
        error_message: `openai_compat: unsupported intent ${JSON.stringify(intent)}; supported: ${JSON.stringify(
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
          "openai_compat: no model — either pass `model` to openaiCompatHandler(...) " +
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
        return { error_code: 408, error_message: "openai_compat: backend timed out" };
      }
      return { error_code: 502, error_message: `openai_compat: HTTP transport error: ${msg}` };
    }
    clearTimeout(t);

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        error_code: resp.status,
        error_message: `openai_compat: upstream ${resp.status}: ${text.slice(0, 512)}`,
      };
    }

    let data: unknown;
    try {
      data = await resp.json();
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      return { error_code: 502, error_message: `openai_compat: upstream returned non-JSON: ${msg}` };
    }

    return { result: data };
  };
}

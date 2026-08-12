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
import type { TcpStreamingHandler } from "../iicp_tcp.js";

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

/** Genuine opt-in SSE streaming for OpenAI-compatible chat/completion backends. */
export function openaiCompatStreamingHandler(opts: OpenAiCompatOptions = {}): TcpStreamingHandler {
  const base = (opts.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  return async function* (task) {
    const path = task.intent === "urn:iicp:intent:llm:chat:v1" ? "/chat/completions"
      : task.intent === "urn:iicp:intent:llm:completion:v1" ? "/completions" : null;
    if (!path) {
      yield { status: "error", error_code: "unsupported_streaming_intent", error_message: "openai_compat: streaming is limited to chat and completion intents" };
      return;
    }
    const body = { ...task.payload, model: task.payload.model ?? opts.model, stream: true,
      stream_options: task.payload.stream_options ?? { include_usage: true } };
    if (!body.model) {
      yield { status: "error", error_code: "missing_model", error_message: "openai_compat: no model configured" };
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    let tokensUsed: number | undefined;
    let reader: ReadableStreamDefaultReader<string> | undefined;
    try {
      const response = await fetch(`${base}${path}`, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) {
        yield { status: "error", error_code: `upstream_${response.status}`,
          error_message: `openai_compat: upstream ${response.status}: ${(await response.text()).slice(0, 512)}` };
        return;
      }
      if (!response.body) {
        yield { status: "error", error_code: "invalid_backend_stream", error_message: "openai_compat: upstream returned no stream body" };
        return;
      }
      reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let output = "";
      let flushDeadline = 0;
      let pendingRead = reader.read();
      while (true) {
        const read = output
          ? await new Promise<{ kind: "read"; value: { done: boolean; value?: string } } | { kind: "flush" }>((resolve, reject) => {
              const timer = setTimeout(
                () => resolve({ kind: "flush" }),
                Math.max(0, flushDeadline - performance.now()),
              );
              pendingRead.then(
                (value) => { clearTimeout(timer); resolve({ kind: "read", value }); },
                (error: unknown) => { clearTimeout(timer); reject(error); },
              );
            })
          : { kind: "read" as const, value: await pendingRead };
        if (read.kind === "flush") {
          yield { status: "partial", result: output, ...(tokensUsed === undefined ? {} : { tokens_used: tokensUsed }) };
          output = "";
          flushDeadline = 0;
          continue;
        }
        const { value, done } = read.value;
        if (!done) pendingRead = reader.read();
        buffer += value ?? "";
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            if (output) {
              yield { status: "partial", result: output, ...(tokensUsed === undefined ? {} : { tokens_used: tokensUsed }) };
            }
            yield { status: "success", result: "", ...(tokensUsed === undefined ? {} : { tokens_used: tokensUsed }) };
            return;
          }
          if (!data) continue;
          let chunk: Record<string, unknown>;
          try { chunk = JSON.parse(data) as Record<string, unknown>; }
          catch {
            yield { status: "error", error_code: "invalid_backend_stream", error_message: "openai_compat: upstream emitted invalid SSE JSON" };
            return;
          }
          const usage = chunk.usage as Record<string, unknown> | undefined;
          if (typeof usage?.total_tokens === "number") tokensUsed = usage.total_tokens;
          const first = Array.isArray(chunk.choices) ? chunk.choices[0] as Record<string, unknown> | undefined : undefined;
          const delta = first?.delta as Record<string, unknown> | undefined;
          const text = task.intent.endsWith(":chat:v1") ? delta?.content : first?.text;
          if (typeof text === "string" && text) {
            if (!output) flushDeadline = performance.now() + 25;
            output += text;
            if (Buffer.byteLength(output, "utf8") >= 256) {
              yield { status: "partial", result: output, ...(tokensUsed === undefined ? {} : { tokens_used: tokensUsed }) };
              output = "";
              flushDeadline = 0;
            }
          }
        }
        if (done) {
          if (output) {
            yield { status: "partial", result: output, ...(tokensUsed === undefined ? {} : { tokens_used: tokensUsed }) };
          }
          yield { status: "error", error_code: "stream_incomplete", error_message: "openai_compat: upstream closed before [DONE]" };
          return;
        }
      }
    } catch (error) {
      yield error instanceof DOMException && error.name === "AbortError"
        ? { status: "timeout", error_code: "backend_timeout", error_message: "openai_compat: backend timed out" }
        : { status: "error", error_code: "backend_transport_error", error_message: "openai_compat: backend transport failed" };
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
    }
  };
}

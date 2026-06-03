// SPDX-License-Identifier: Apache-2.0
/**
 * Native Anthropic Messages-API backend helper.
 *
 * Unlike openai_compat/vllm/llamacpp (which share the OpenAI `/v1/*` dialect via
 * buildOpenAiDialectHandler), Anthropic speaks the Messages API (`POST /v1/messages`):
 * a top-level `system` string instead of a system-role message, `x-api-key` +
 * `anthropic-version` headers instead of a bearer token, a REQUIRED `max_tokens`, and
 * `content` blocks instead of OpenAI's `message.content`.
 *
 * This handler translates an IICP `llm:chat:v1` task (OpenAI chat shape) → an Anthropic
 * Messages request, then translates the response BACK to the OpenAI chat-completion
 * shape — so a Claude-backed node looks identical to an Ollama/vLLM node to any IICP
 * client. First-class Claude support (prompt caching, native content blocks) without
 * the OpenAI-compat shim (which strips audio + disables caching).
 *
 * Capability roadmap C1 (reports/capability-gaps-implementation-plan-2026-06-03.md;
 * research #414). No new dependency — uses built-in fetch.
 */

import { type BackendHandler, type TaskHandlerInput, type TaskHandlerOutput } from "./base.js";

const CHAT_INTENT = "urn:iicp:intent:llm:chat:v1";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicOptions {
  /** Anthropic API root. Default `https://api.anthropic.com/v1`. */
  baseUrl?: string;
  /** Claude model id (e.g. `claude-opus-4-8`). If unset, taken from task payload. */
  model?: string;
  /** Anthropic API key → sent as `x-api-key` (reuses #5 backend api-key support). */
  apiKey?: string;
  /** Per-request HTTP timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Value for the required `anthropic-version` header. */
  anthropicVersion?: string;
  /** `max_tokens` sent when the task omits it (Anthropic requires the field). */
  defaultMaxTokens?: number;
}

type ContentPart = { type?: string; text?: string; image_url?: { url?: string } };

/** Translate one OpenAI message `content` into Anthropic content. */
function toAnthropicContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const blocks: Array<Record<string, unknown>> = [];
  for (const partRaw of content) {
    if (typeof partRaw !== "object" || partRaw === null) continue;
    const part = partRaw as ContentPart;
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text ?? "" });
    } else if (part.type === "image_url") {
      const url = part.image_url?.url ?? "";
      if (url.startsWith("data:")) {
        const comma = url.indexOf(",");
        if (comma < 0) continue;
        const header = url.slice(0, comma);
        const b64 = url.slice(comma + 1);
        const mediaType = header.slice("data:".length).split(";")[0] || "image/png";
        blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: b64 } });
      } else if (url) {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
    // unknown parts dropped
  }
  return blocks;
}

/** Translate an OpenAI chat payload → an Anthropic Messages request body. */
function toAnthropicRequest(
  payload: Record<string, unknown>,
  model: string | undefined,
  defaultMaxTokens: number
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  body.model = (payload.model as string | undefined) ?? model;

  const systemParts: string[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const inMsgs = Array.isArray(payload.messages) ? payload.messages : [];
  for (const msgRaw of inMsgs) {
    if (typeof msgRaw !== "object" || msgRaw === null) continue;
    const msg = msgRaw as { role?: string; content?: unknown };
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (typeof p === "object" && p !== null && (p as ContentPart).type === "text") {
            systemParts.push((p as ContentPart).text ?? "");
          }
        }
      }
      continue;
    }
    messages.push({ role: msg.role, content: toAnthropicContent(msg.content) });
  }
  body.messages = messages;
  const sys = systemParts.filter((s) => s).join("\n\n");
  if (sys) body.system = sys;

  const mt = payload.max_tokens as number | undefined;
  body.max_tokens = mt && mt > 0 ? mt : defaultMaxTokens;
  if (payload.temperature !== undefined) body.temperature = payload.temperature;
  if (payload.top_p !== undefined) body.top_p = payload.top_p;
  const stop = payload.stop;
  if (stop !== undefined && stop !== null) {
    body.stop_sequences = typeof stop === "string" ? [stop] : (stop as unknown[]);
  }
  return body;
}

const STOP_REASON_TO_FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

/** Translate an Anthropic Messages response → the OpenAI chat-completion shape. */
function toOpenAiResponse(data: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(data.content) ? data.content : [];
  const text = content
    .filter((b): b is { type: string; text: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const usage = (data.usage as { input_tokens?: number; output_tokens?: number } | undefined) ?? {};
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    id: data.id ?? "",
    object: "chat.completion",
    model: data.model ?? "",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: STOP_REASON_TO_FINISH[data.stop_reason as string] ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Build a TaskHandler that proxies `llm:chat:v1` CALLs to the Anthropic Messages API.
 * Only chat is supported (Anthropic has no completion/embedding endpoint). Success →
 * `{ result: <OpenAI-shaped JSON> }`; failure → `{ error_code, error_message }`.
 */
export function anthropicHandler(opts: AnthropicOptions = {}): BackendHandler {
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
  const model = opts.model;
  const apiKey = opts.apiKey ?? "";
  const timeoutMs = opts.timeoutMs ?? 30000;
  const anthropicVersion = opts.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
  const defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": anthropicVersion,
  };
  if (apiKey) headers["x-api-key"] = apiKey;

  return async function handler(task: TaskHandlerInput): Promise<TaskHandlerOutput> {
    const intent = String(task.intent ?? "");
    if (intent !== CHAT_INTENT) {
      return {
        error_code: 400,
        error_message: `anthropic: unsupported intent ${JSON.stringify(intent)}; the Messages API serves only ${CHAT_INTENT}`,
      };
    }
    const payload = task.payload;
    if (payload !== undefined && payload !== null && (typeof payload !== "object" || Array.isArray(payload))) {
      return { error_code: 400, error_message: `anthropic: task.payload must be a dict, got ${typeof payload}` };
    }

    const body = toAnthropicRequest((payload as Record<string, unknown>) ?? {}, model, defaultMaxTokens);
    if (!body.model) {
      return {
        error_code: 400,
        error_message:
          "anthropic: no model — pass `model` to the backend factory or include `model` in the task payload",
      };
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (exc) {
      clearTimeout(t);
      if (ctrl.signal.aborted) return { error_code: 408, error_message: "anthropic: backend timed out" };
      const msg = exc instanceof Error ? exc.message : String(exc);
      return { error_code: 502, error_message: `anthropic: HTTP transport error: ${msg}` };
    }
    clearTimeout(t);

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { error_code: resp.status, error_message: `anthropic: upstream ${resp.status}: ${text.slice(0, 512)}` };
    }

    let data: unknown;
    try {
      data = await resp.json();
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      return { error_code: 502, error_message: `anthropic: upstream returned non-JSON: ${msg}` };
    }

    return { result: toOpenAiResponse(data as Record<string, unknown>) };
  };
}

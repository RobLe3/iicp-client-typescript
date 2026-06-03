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

/** #414 — speech-to-text. Multipart file upload (distinct path below), not JSON. */
export const AUDIO_TRANSCRIBE_INTENT = "urn:iicp:intent:audio:transcribe:v1";

export const INTENT_TO_PATH: Record<string, string> = {
  "urn:iicp:intent:llm:chat:v1": "/chat/completions",
  "urn:iicp:intent:llm:completion:v1": "/completions",
  "urn:iicp:intent:llm:embedding:v1": "/embeddings",
  [AUDIO_TRANSCRIBE_INTENT]: "/audio/transcriptions",
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

    // #414 — audio:transcribe is a multipart file upload (OpenAI
    // /v1/audio/transcriptions). Audio rides as base64 in payload.audio; model is
    // OPTIONAL (whisper.cpp ignores it, vLLM/OpenAI use it). Native FormData/Blob —
    // no new dependency.
    if (intent === AUDIO_TRANSCRIBE_INTENT) {
      const p = (payload as Record<string, unknown>) ?? {};
      const audioB64 = (p.audio ?? p.audio_b64) as unknown;
      if (typeof audioB64 !== "string" || !audioB64) {
        return {
          error_code: 400,
          error_message: `${engine}: audio:transcribe requires payload.audio (base64-encoded audio bytes)`,
        };
      }
      const cleaned = audioB64.trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
        return { error_code: 400, error_message: `${engine}: payload.audio is not valid base64` };
      }
      const audioBytes = Buffer.from(cleaned, "base64");
      const filename = typeof p.filename === "string" ? p.filename : "audio.wav";
      const form = new FormData();
      form.append("file", new Blob([audioBytes]), filename);
      const reqModel = (typeof p.model === "string" ? p.model : undefined) ?? model;
      if (reqModel) form.append("model", reqModel);
      let haveRf = false;
      for (const k of ["language", "response_format", "prompt", "temperature"]) {
        if (p[k] !== undefined && p[k] !== null) {
          if (k === "response_format") haveRf = true;
          form.append(k, String(p[k]));
        }
      }
      if (!haveRf) form.append("response_format", "json");

      const mpHeaders: Record<string, string> = {};
      if (apiKey) mpHeaders["Authorization"] = `Bearer ${apiKey}`;
      const ctrlA = new AbortController();
      const tA = setTimeout(() => ctrlA.abort(), timeoutMs);
      let respA: Response;
      try {
        respA = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: mpHeaders,
          body: form,
          signal: ctrlA.signal,
        });
      } catch (exc) {
        clearTimeout(tA);
        const msg = exc instanceof Error ? exc.message : String(exc);
        if (ctrlA.signal.aborted) return { error_code: 408, error_message: `${engine}: backend timed out` };
        return { error_code: 502, error_message: `${engine}: HTTP transport error: ${msg}` };
      }
      clearTimeout(tA);
      if (!respA.ok) {
        const text = await respA.text().catch(() => "");
        return {
          error_code: respA.status,
          error_message: `${engine}: upstream ${respA.status}: ${text.slice(0, 512)}`,
        };
      }
      const text = await respA.text();
      try {
        return { result: JSON.parse(text) };
      } catch {
        return { result: { text } }; // response_format=text → plain body
      }
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

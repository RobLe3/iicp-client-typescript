// SPDX-License-Identifier: Apache-2.0
/**
 * iicp-node proxy (ADR-050) — local OpenAI/Ollama/Anthropic-compat gateway.
 *
 * A loopback HTTP server that translates external chat-API requests into IICP mesh
 * calls via {@link IicpClient} and translates responses back. It does NOT register
 * with the directory (consumer gateway). Mirrors the Python `iicp_client.proxy`
 * behaviour per project/proxy-unification-contract.md; verified against
 * tests/conformance/proxy_fixtures.json.
 *
 * v1 covers the non-CIP fixtures (success / upstream-502 / no-nodes-502 / 500 /
 * static endpoints / streaming). The CIP affordability + no-eligible-workers gates
 * (402 IICP-E036 / 503 IICP-E022) require porting the proxy CIP dispatch to TS and
 * are tracked under the conformance issue (#482).
 */
import * as http from "node:http";

import { IicpClient } from "../client.js";
import { IicpError } from "../errors.js";
import type { ChatMessage } from "../types.js";
import {
  CIPInsufficientCredits,
  CIPNoEligibleWorkers,
  cipConfigFromEnv,
  computeCipEnvelope,
} from "./cip.js";

const INTENT = "urn:iicp:intent:llm:chat:v1";
/** CIP consumer config (env IICP_PROXY_CIP_*); enabled defaults OFF (§2.2 ¶1). */
const CIP_CONFIG = cipConfigFromEnv();
const OLLAMA_VERSION = "0.1.0";
/** The proxy self-identifies as `iicp-proxy` on every response (Server header). */
const SERVER_ID = "iicp-proxy";

export interface ProxyConfig {
  host: string;
  port: number;
  directoryUrl?: string;
  region?: string;
  token?: string;
}

/** Minimal IICP task surface the gateway needs — lets tests inject a mock. */
export interface TaskClient {
  submit(req: {
    intent: string;
    payload: Record<string, unknown>;
    constraints?: Record<string, unknown>;
  }): Promise<{ status: string; result?: unknown; error?: { code?: string } }>;
  /** Optional — used only for CIP consumer gating (S.12 §2.2) when CIP is enabled. */
  discover?(
    intent: string,
  ): Promise<Array<{ node_id?: string; allow_remote_inference?: boolean; reputation_score?: number }>>;
}

// ── translators (mirror iicp_client.proxy.*_compat.translator) ───────────────

function firstMessage(resp: { result?: unknown }): { role: string; content: string } {
  const result = (resp.result ?? {}) as Record<string, unknown>;
  const choices = (result.choices as Array<Record<string, unknown>>) ?? [{}];
  const msg = (choices[0]?.message as Record<string, string>) ?? {};
  return { role: msg.role ?? "assistant", content: msg.content ?? "" };
}

function usageOf(resp: { result?: unknown }): Record<string, unknown> {
  const result = (resp.result ?? {}) as Record<string, unknown>;
  return (result.usage as Record<string, unknown>) ?? {};
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function toOpenAI(resp: { result?: unknown }, model: string): Record<string, unknown> {
  const m = firstMessage(resp);
  return {
    id: `chatcmpl-iicp`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: m.role, content: m.content }, finish_reason: "stop" }],
    usage: usageOf(resp),
  };
}

function toOllama(resp: { result?: unknown }, model: string): Record<string, unknown> {
  const m = firstMessage(resp);
  return {
    model,
    created_at: nowIso(),
    message: { role: m.role, content: m.content },
    done: true,
    done_reason: "stop",
  };
}

function toOllamaGenerate(resp: { result?: unknown }, model: string): Record<string, unknown> {
  const m = firstMessage(resp);
  return { model, created_at: nowIso(), response: m.content, done: true, done_reason: "stop" };
}

function toAnthropic(resp: { result?: unknown }, model: string, taskId: string): Record<string, unknown> {
  const m = firstMessage(resp);
  return {
    id: `msg_${taskId || "iicp"}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: m.content }],
    stop_reason: "end_turn",
    usage: usageOf(resp),
  };
}

// ── error bodies (per-surface, per the contract error map) ───────────────────

function openaiErr(code: string, message: string): unknown {
  return { error: { code, message } };
}
function ollamaErr(code: string, message: string): unknown {
  return { error: `${code}: ${message}` };
}
function anthropicErr(code: string, message: string): unknown {
  return { type: "error", error: { type: "api_error", message: `${code}: ${message}` } };
}

// ── core dispatch: run an IICP chat task; classify the outcome ───────────────

type Outcome =
  | { kind: "ok"; resp: { result?: unknown } }
  | { kind: "error"; status: number; code: string };

async function runChatTask(
  client: TaskClient,
  messages: ChatMessage[],
  model: string,
  extra: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<Outcome> {
  try {
    let payloadExtra = extra;
    // CIP consumer gating (§2.2) — only when enabled; throws CIPInsufficientCredits
    // (E036→402) / CIPNoEligibleWorkers (E022→503), else returns an envelope to attach.
    if (CIP_CONFIG.enabled && client.discover) {
      const taskId = `cip-${Date.now()}`;
      const nodes = await client.discover(INTENT);
      const balance = ((body.billing as Record<string, unknown>)?.consumer_balance as number) ?? null;
      const envelope = computeCipEnvelope(nodes, body, CIP_CONFIG, taskId, body.qos as string | undefined, balance);
      if (envelope) {
        payloadExtra = { ...extra, cip: { ...((extra.cip as Record<string, unknown>) ?? {}), ...envelope } };
      }
    }
    const resp = await client.submit({
      intent: INTENT,
      payload: { messages, model, ...payloadExtra },
      constraints: { timeout_ms: 30000 },
    });
    if (resp.status !== "success" && resp.status !== "completed") {
      return { kind: "error", status: 502, code: resp.error?.code ?? "proxy_error" };
    }
    return { kind: "ok", resp };
  } catch (err) {
    // CIP gating errors map to dedicated statuses (S.12 §2.2 / §10.1).
    if (err instanceof CIPInsufficientCredits) return { kind: "error", status: 402, code: err.code };
    if (err instanceof CIPNoEligibleWorkers) return { kind: "error", status: 503, code: err.code };
    if (err instanceof IicpError) {
      // No nodes from discover → IICP-E033 (parity with the Python empty-discover path).
      if (err.code === "SDK-03") return { kind: "error", status: 502, code: "IICP-E033" };
      return { kind: "error", status: 502, code: err.code };
    }
    return { kind: "error", status: 500, code: "proxy_error" };
  }
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, generatedByAi = false): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Server": SERVER_ID,
    ...(generatedByAi ? { "X-IICP-Generated-By-AI": "true" } : {}),
  });
  res.end(data);
}

function messagesOf(body: Record<string, unknown>): ChatMessage[] {
  return (body.messages as ChatMessage[]) ?? [];
}

function extraOf(body: Record<string, unknown>): Record<string, unknown> {
  const e: Record<string, unknown> = {};
  for (const k of ["temperature", "max_tokens", "cip", "billing", "qos"]) {
    if (body[k] !== undefined) e[k] = body[k];
  }
  return e;
}

function errMsg(status: number): string {
  if (status === 402) return "Insufficient credits";
  if (status === 503) return "No eligible workers";
  if (status === 502) return "Upstream error";
  return "Internal proxy error";
}

// ── per-surface handlers ─────────────────────────────────────────────────────

async function handleOpenAIChat(client: TaskClient, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJson(req);
  const model = (body.model as string) ?? "iicp";
  const out = await runChatTask(client, messagesOf(body), model, extraOf(body), body);
  if (out.kind === "error") return sendJson(res, out.status, openaiErr(out.code, errMsg(out.status)));
  return sendJson(res, 200, toOpenAI(out.resp, model), true);
}

async function handleOllamaChat(client: TaskClient, req: http.IncomingMessage, res: http.ServerResponse, generate: boolean) {
  const body = await readJson(req);
  const model = (body.model as string) ?? "iicp";
  const stream = body.stream === undefined ? true : Boolean(body.stream); // Ollama default true
  const messages: ChatMessage[] = generate
    ? [{ role: "user", content: String(body.prompt ?? "") }]
    : messagesOf(body);
  const out = await runChatTask(client, messages, model, extraOf(body), body);
  if (out.kind === "error") return sendJson(res, out.status, ollamaErr(out.code, errMsg(out.status)));
  const payload = generate ? toOllamaGenerate(out.resp, model) : toOllama(out.resp, model);
  if (stream) {
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Server": SERVER_ID, "X-IICP-Generated-By-AI": "true" });
    res.end(JSON.stringify(payload) + "\n"); // one terminal NDJSON line (done=true)
    return;
  }
  return sendJson(res, 200, payload, true);
}

async function handleAnthropicMessages(client: TaskClient, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJson(req);
  const model = (body.model as string) ?? "iicp";
  const stream = Boolean(body.stream); // Anthropic default false
  const out = await runChatTask(client, messagesOf(body), model, extraOf(body), body);
  if (out.kind === "error") return sendJson(res, out.status, anthropicErr(out.code, errMsg(out.status)));
  const msg = toAnthropic(out.resp, model, "iicp");
  if (stream) {
    const text = firstMessage(out.resp).content;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Server": SERVER_ID, "X-IICP-Generated-By-AI": "true" });
    const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
    ev("message_start", { message: msg });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn" } });
    ev("message_stop", {});
    res.end();
    return;
  }
  return sendJson(res, 200, msg, true);
}

// ── server ───────────────────────────────────────────────────────────────────

const MODELS_LIST = { object: "list", data: [{ id: "iicp", object: "model", created: 1700000000, owned_by: "iicp" }] };
const OLLAMA_TAGS = { models: [{ name: "iicp", model: "iicp", modified_at: "", size: 0, digest: "" }] };

/** Build the gateway HTTP server. `client` is injectable for tests. */
export function createProxyServer(client: TaskClient): http.Server {
  return http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0];
    const route = `${method} ${path}`;
    (async () => {
      try {
        switch (route) {
          case "POST /v1/chat/completions": return await handleOpenAIChat(client, req, res);
          case "POST /api/chat": return await handleOllamaChat(client, req, res, false);
          case "POST /api/generate": return await handleOllamaChat(client, req, res, true);
          case "GET /api/tags": return sendJson(res, 200, OLLAMA_TAGS);
          case "GET /api/version": return sendJson(res, 200, { version: OLLAMA_VERSION });
          case "POST /v1/messages": return await handleAnthropicMessages(client, req, res);
          case "GET /v1/models": return sendJson(res, 200, MODELS_LIST);
          case "GET /status": return sendJson(res, 200, { status: "ok", role: "proxy" });
          case "GET /metrics": {
            res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Server": SERVER_ID });
            res.end("# iicp-proxy metrics\n");
            return;
          }
          default:
            return sendJson(res, 404, openaiErr("not_found", `no route for ${route}`));
        }
      } catch {
        return sendJson(res, 500, openaiErr("proxy_error", "Internal proxy error"));
      }
    })();
  });
}

/** CLI entry: build a real IicpClient gateway and listen (loopback by default). */
export function runProxy(cfg: ProxyConfig): Promise<number> {
  const client = new IicpClient({
    directory_url: cfg.directoryUrl,
    region: cfg.region,
    api_token: cfg.token,
  }) as unknown as TaskClient;
  const server = createProxyServer(client);
  return new Promise((resolve) => {
    server.listen(cfg.port, cfg.host, () => {
      process.stdout.write(
        `iicp-node proxy → http://${cfg.host}:${cfg.port} (OpenAI/Ollama/Anthropic compat; no directory registration)\n`,
      );
    });
    server.on("error", (e) => {
      process.stderr.write(`proxy error: ${String(e)}\n`);
      resolve(1);
    });
  });
}

// SPDX-License-Identifier: Apache-2.0
/**
 * Experimental native IICP binary transport — server + framing + CBOR payloads.
 * Provider nodes require the separate IICP_ENABLE_EXPERIMENTAL_NATIVE_TCP=1
 * runtime opt-in before mounting or advertising this plaintext development
 * binding. It is excluded from stable and production support claims.
 *
 * TypeScript port of iicp-client-python iicp_tcp.py (iter-1414). Wire-
 * compatible with adapter nodes and REACH FRAME-PING-01 / FRAME-INIT-01
 * conformance probes.
 *
 * cbor-x is an optional peer dependency. Installing it alone does not enable
 * the native listener; HTTP-only nodes do not need it.
 *
 * Implements the iter-1410 framing fixes from the start: session loop reads
 * the announced payload BEFORE decoding (pre-fix the adapter version closed
 * on every payload-bearing frame), and CALL handler decodes key-5 JSON dict
 * before invoking the user handler.
 *
 * Spec: iicp.network/spec/iicp-framing.md, ADR-040.
 */

import * as net from "node:net";
import { randomUUID } from "node:crypto";
import {
  NativeResponseSequence,
  type NativeResponseFrame,
} from "./native_response_sequence.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const IICP_MAGIC = Buffer.from("IICP", "ascii"); // 0x49 0x49 0x43 0x50
export const FRAMING_VERSION = 0x01;
export const FRAME_HEADER_LEN = 12; // magic(4) + ver(1) + type(1) + flags(1) + reserved(1) + length(4)
/** Length-field payload bytes; the 12-byte header is excluded. */
export const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;

const STABLE_TASK_MESSAGE_TYPES = new Set<number>([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0d, 0x0e,
]);

/** Fail-closed type-byte disposition for the bounded experimental task profile. */
export function stableTaskMessageTypeError(msgType: number): string | undefined {
  if (STABLE_TASK_MESSAGE_TYPES.has(msgType)) return undefined;
  if (msgType === 0x00 || msgType === 0xff) return "invalid_type";
  if (msgType === 0x0b || msgType === 0x0c) return "conflicted_type";
  if (msgType >= 0xf0 && msgType <= 0xfe) return "unsupported_extension";
  return "unknown_type";
}

export enum MsgType {
  INIT = 0x01,
  ACK = 0x02,
  DISCOVER = 0x03,
  SUB_PROTOCOL = 0x04,
  CALL = 0x05,
  RESPONSE = 0x06,
  CLOSE = 0x07,
  FEEDBACK = 0x08,
  PING = 0x09,
  PONG = 0x0a,
  /** R1 relay-as-last-resort: worker binds outbound session to relay (#341). */
  RELAY_BIND = 0x0b,
  RELAY_ACK = 0x0c,
}

// ── Frame ─────────────────────────────────────────────────────────────────────

export interface IicpFrame {
  version: number;
  msgType: number;
  flags: number;
  payload: Buffer;
}

export function encodeFrame(msgType: number, payload: Buffer = Buffer.alloc(0), flags = 0): Buffer {
  if (payload.length > MAX_FRAME_PAYLOAD) {
    throw new Error(`IICP frame payload too large: ${payload.length} > ${MAX_FRAME_PAYLOAD}`);
  }
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  IICP_MAGIC.copy(header, 0);
  header.writeUInt8(FRAMING_VERSION, 4);
  header.writeUInt8(msgType, 5);
  header.writeUInt8(flags, 6);
  header.writeUInt8(0, 7); // reserved
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

export function decodeFrame(data: Buffer): { frame: IicpFrame; consumed: number } {
  if (data.length < FRAME_HEADER_LEN) {
    throw new Error(`IICP frame too short: ${data.length} < ${FRAME_HEADER_LEN}`);
  }
  const magic = data.subarray(0, 4);
  if (!magic.equals(IICP_MAGIC)) {
    throw new Error(`Invalid IICP magic: ${magic.toString("hex")}`);
  }
  const version = data.readUInt8(4);
  if (version !== FRAMING_VERSION) {
    throw new Error(`Unsupported IICP framing version: ${version}; expected ${FRAMING_VERSION}`);
  }
  const msgType = data.readUInt8(5);
  const flags = data.readUInt8(6);
  // reserved at 7
  const payloadLen = data.readUInt32BE(8);
  if (payloadLen > MAX_FRAME_PAYLOAD) {
    throw new Error(`IICP frame payload too large: ${payloadLen} > ${MAX_FRAME_PAYLOAD}`);
  }
  const total = FRAME_HEADER_LEN + payloadLen;
  if (data.length < total) {
    throw new Error(`IICP payload truncated: need ${total}, have ${data.length}`);
  }
  return {
    frame: {
      version,
      msgType,
      flags,
      payload: Buffer.from(data.subarray(FRAME_HEADER_LEN, total)),
    },
    consumed: total,
  };
}

// ── CBOR payload helpers (lazy cbor-x import) ────────────────────────────────

interface CborApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encode: (obj: any) => Uint8Array;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decode: (buf: Uint8Array | Buffer) => any;
}

let _cbor: CborApi | null = null;
async function getCbor(): Promise<CborApi> {
  if (_cbor) return _cbor;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import("cbor-x")) as any;
    // Use Encoder instance with useRecords:false so encode(Map) emits a plain
    // CBOR map (a2 ...) with integer keys (instead of a tagged Map d9 01 03)
    // AND encode({k: v}) emits standard text-keyed maps (instead of the
    // cbor-x "Record" optimization tags 57343/57344 which Python/Rust peers
    // cannot decode). IICP wire protocol headers use integer-keyed CBOR maps;
    // application payloads use text-keyed maps.
    const enc = new mod.Encoder({ useRecords: false, mapsAsObjects: false });
    _cbor = {
      encode: (obj: unknown) => enc.encode(obj),
      decode: mod.decode,
    };
    return _cbor;
  } catch (exc) {
    throw new Error(
      "cbor-x is required for the native IICP transport. " +
        "Install with: npm install cbor-x"
    );
  }
}

export async function encodeCbor(obj: unknown): Promise<Buffer> {
  const cbor = await getCbor();
  const out = cbor.encode(obj);
  return Buffer.from(out);
}

export async function decodeCbor(data: Buffer): Promise<unknown> {
  const cbor = await getCbor();
  return cbor.decode(data);
}

export async function encodeAck(framingVersion = FRAMING_VERSION, nodeId?: string): Promise<Buffer> {
  const m = new Map<number, unknown>();
  m.set(1, framingVersion);
  if (nodeId !== undefined) m.set(2, nodeId);
  return encodeCbor(m);
}

export async function encodePong(echo?: Buffer): Promise<Buffer> {
  const m = new Map<number, unknown>();
  if (echo) m.set(1, echo);
  return encodeCbor(m);
}

export async function encodeResponse(args: {
  sessionId: string;
  callId?: string;
  result?: Buffer | string | null;
  errorCode?: number;
  errorMessage?: string;
}): Promise<Buffer> {
  const m = new Map<number, unknown>();
  m.set(2, args.sessionId);
  if (args.callId !== undefined) m.set(15, args.callId);
  if (args.result !== undefined && args.result !== null) {
    m.set(5, typeof args.result === "string" ? Buffer.from(args.result) : args.result);
  }
  if (args.errorCode !== undefined) m.set(100, args.errorCode);
  if (args.errorMessage !== undefined) m.set(101, args.errorMessage);
  return encodeCbor(m);
}

export async function encodeLifecycleResponse(args: {
  sessionId: string;
  callId: string;
  taskId: string;
  sequence: number;
  status: "partial" | "success" | "error" | "timeout";
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  tokensUsed?: number;
  event?: string;
}): Promise<Buffer> {
  const isFinal = args.status !== "partial";
  const event = args.event ?? {
    partial: "partial", success: "completed", error: "failed", timeout: "timed_out",
  }[args.status];
  const m = new Map<number, unknown>([
    [1, FRAMING_VERSION], [2, args.sessionId], [3, args.callId], [4, args.status],
    [12, isFinal], [13, new Map<number, unknown>([[1, args.taskId], [2, args.sequence], [3, event], [4, isFinal]])],
  ]);
  if (args.result !== undefined) m.set(5, args.result);
  if (args.errorCode !== undefined || args.errorMessage !== undefined) {
    m.set(6, new Map<number, unknown>([[1, args.errorCode ?? "stream_error"], [2, args.errorMessage ?? "stream failed"]]));
  }
  if (args.tokensUsed !== undefined) m.set(7, args.tokensUsed);
  return encodeCbor(m);
}

export async function encodeDiscoverResponse(
  sessionId: string,
  intent: string,
  nodes: Record<string, unknown>[]
): Promise<Buffer> {
  const m = new Map<number, unknown>();
  m.set(2, sessionId);
  m.set(3, intent);
  m.set(20, nodes);
  return encodeCbor(m);
}

// ── Server ────────────────────────────────────────────────────────────────────

export type TcpTaskHandler = (task: {
  task_id: string;
  intent: string;
  payload: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

export type TcpStreamingHandler = (task: {
  task_id: string;
  call_id: string;
  intent: string;
  payload: Record<string, unknown>;
}) => AsyncIterable<{
  status: "partial" | "success" | "error" | "timeout";
  result?: unknown;
  error_code?: string;
  error_message?: string;
  tokens_used?: number;
  event?: string;
}>;

export type DiscoverLookup = (intent: string) => Promise<Record<string, unknown>[]>;

export interface IicpTcpServerOptions {
  host?: string;
  port?: number;
  nodeId?: string;
  handler?: TcpTaskHandler;
  streamingHandler?: TcpStreamingHandler;
  discoverLookup?: DiscoverLookup;
  /** Optional ConcurrencyGate. When set, every CALL acquires a slot first;
   * CapacityExceededError → RESPONSE error_code=429 (IICP-E021). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  concurrencyGate?: any;
}

export class IicpTcpServer {
  private readonly _host: string;
  private readonly _port: number;
  private readonly _nodeId: string | undefined;
  private readonly _handler: TcpTaskHandler | undefined;
  private readonly _streamingHandler: TcpStreamingHandler | undefined;
  private readonly _discoverLookup: DiscoverLookup | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _gate: any | undefined;
  private _server: net.Server | null = null;

  constructor(opts: IicpTcpServerOptions = {}) {
    this._host = opts.host ?? "0.0.0.0";
    this._port = opts.port ?? 9484;
    this._nodeId = opts.nodeId;
    this._handler = opts.handler;
    this._streamingHandler = opts.streamingHandler;
    this._discoverLookup = opts.discoverLookup;
    this._gate = opts.concurrencyGate;
  }

  async start(): Promise<void> {
    // Validate cbor-x is importable before opening the socket so we fail fast.
    await getCbor();
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        this._handleConnection(socket).catch(() => undefined);
      });
      this._server.once("error", reject);
      this._server.listen(this._port, this._host, () => {
        this._server?.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const srv = this._server;
    this._server = null;
    if (!srv) return;
    return new Promise((resolve) => {
      srv.close(() => resolve());
      // Force-close any open connections so the test fixture shuts down promptly.
      srv.unref();
    });
  }

  get port(): number {
    return this._port;
  }

  /**
   * Handle one already-accepted socket as a native IICP connection (#457). Public so a
   * shared single-port listener — where `iicp-node serve` multiplexes the HTTP control
   * plane and the native binary transport on ONE port via first-byte detection — can route
   * native connections here without this server binding its own port.
   */
  async handleConnection(socket: net.Socket): Promise<void> {
    return this._handleConnection(socket);
  }

  private async _handleConnection(socket: net.Socket): Promise<void> {
    let buf = Buffer.alloc(0);
    let initialized = false;
    // Aggregate incoming TCP bytes into a Buffer queue. The async loop reads
    // synchronously off `buf`; new TCP data appends.
    const dataQueue: Buffer[] = [];
    let resolveData: ((value: Buffer | null) => void) | null = null;
    let socketClosed = false;

    const onData = (chunk: Buffer) => {
      if (resolveData) {
        const r = resolveData;
        resolveData = null;
        r(chunk);
      } else {
        dataQueue.push(chunk);
      }
    };
    const onClose = () => {
      socketClosed = true;
      if (resolveData) {
        const r = resolveData;
        resolveData = null;
        r(null);
      }
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onClose);

    const readChunk = (): Promise<Buffer | null> => {
      if (dataQueue.length) return Promise.resolve(dataQueue.shift()!);
      if (socketClosed) return Promise.resolve(null);
      return new Promise((res) => {
        resolveData = res;
      });
    };

    try {
      // Need at least the 12-byte header before we can do anything.
      while (buf.length < FRAME_HEADER_LEN) {
        const chunk = await readChunk();
        if (!chunk) {
          socket.destroy();
          return;
        }
        buf = Buffer.concat([buf, chunk]);
      }

      // Magic byte validation (spec §1.2)
      if (!buf.subarray(0, 4).equals(IICP_MAGIC)) {
        socket.destroy();
        return;
      }

      while (true) {
        // Stage 1: ensure header is complete
        while (buf.length < FRAME_HEADER_LEN) {
          const chunk = await readChunk();
          if (!chunk) {
            socket.destroy();
            return;
          }
          buf = Buffer.concat([buf, chunk]);
        }

        // Stage 2: peek payload length, wait for the full frame BEFORE decoding.
        // This is the iter-1410 framing fix — pre-fix the adapter loop only
        // waited for the header and called decode() immediately, which raises
        // "payload truncated" the moment any frame with a non-empty CBOR
        // payload arrives across two TCP reads.
        if (!buf.subarray(0, 4).equals(IICP_MAGIC)) {
          socket.destroy();
          return;
        }
        const version = buf.readUInt8(4);
        const msgType = buf.readUInt8(5);
        if (version !== FRAMING_VERSION) {
          socket.destroy();
          return;
        }
        if (stableTaskMessageTypeError(msgType) !== undefined) {
          socket.destroy();
          return;
        }
        const payloadLen = buf.readUInt32BE(8);
        if (payloadLen > MAX_FRAME_PAYLOAD) {
          socket.destroy();
          return;
        }
        const totalLen = FRAME_HEADER_LEN + payloadLen;
        while (buf.length < totalLen) {
          const chunk = await readChunk();
          if (!chunk) {
            socket.destroy();
            return;
          }
          buf = Buffer.concat([buf, chunk]);
        }

        let frame: IicpFrame;
        let consumed: number;
        try {
          ({ frame, consumed } = decodeFrame(buf));
        } catch {
          socket.destroy();
          return;
        }
        buf = Buffer.from(buf.subarray(consumed));

        if ((!initialized && msgType !== MsgType.INIT) || (initialized && msgType === MsgType.INIT)) {
          socket.destroy();
          return;
        }

        const keepOpen = await this._dispatch(frame, socket);
        if (!initialized) initialized = true;
        if (!keepOpen) {
          socket.end();
          return;
        }
      }
    } catch {
      socket.destroy();
    } finally {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onClose);
    }
  }

  private async _dispatch(frame: IicpFrame, socket: net.Socket): Promise<boolean> {
    switch (frame.msgType) {
      case MsgType.INIT:
        return this._onInit(frame, socket);
      case MsgType.PING:
        return this._onPing(frame, socket);
      case MsgType.DISCOVER:
        return this._onDiscover(frame, socket);
      case MsgType.CALL:
        return this._onCall(frame, socket);
      case MsgType.CLOSE:
        return false; // peer requested graceful shutdown
      case MsgType.FEEDBACK:
        return true;
      default:
        return true; // ignore unknown msg types
    }
  }

  private async _onInit(frame: IicpFrame, socket: net.Socket): Promise<boolean> {
    let body: unknown;
    try {
      body = await decodeCbor(frame.payload);
    } catch {
      return false;
    }
    if (numericField(body, 1) !== FRAMING_VERSION) return false;
    const ack = await encodeAck(FRAMING_VERSION, this._nodeId);
    socket.write(encodeFrame(MsgType.ACK, ack));
    return true;
  }

  private async _onPing(frame: IicpFrame, socket: net.Socket): Promise<boolean> {
    let echo: Buffer | undefined;
    if (frame.payload.length) {
      try {
        const body = await decodeCbor(frame.payload);
        if (body && typeof body === "object" && 1 in (body as Record<number, unknown>)) {
          const v = (body as Record<number, unknown>)[1];
          if (Buffer.isBuffer(v)) echo = v;
          else if (v instanceof Uint8Array) echo = Buffer.from(v);
        }
      } catch {
        // ignore — echo stays undefined
      }
    }
    const pong = await encodePong(echo);
    socket.write(encodeFrame(MsgType.PONG, pong));
    return true;
  }

  private async _onDiscover(frame: IicpFrame, socket: net.Socket): Promise<boolean> {
    let sessionId = "unknown";
    let intent = "";
    try {
      const body = await decodeCbor(frame.payload);
      if (body && typeof body === "object") {
        sessionId = String((body as Record<number, unknown>)[2] ?? "unknown");
        intent = String((body as Record<number, unknown>)[3] ?? "");
      }
    } catch {
      // ignore
    }

    let nodes: Record<string, unknown>[] = [];
    if (this._discoverLookup && intent) {
      try {
        nodes = await this._discoverLookup(intent);
      } catch {
        // ignore — empty nodes list
      }
    }
    const resp = await encodeDiscoverResponse(sessionId, intent, nodes);
    socket.write(encodeFrame(MsgType.RESPONSE, resp));
    return true;
  }

  private async _onCall(frame: IicpFrame, socket: net.Socket): Promise<boolean> {
    let sessionId = "unknown";
    let callId: string | undefined;
    let intent = "";
    let taskId: string | undefined;
    let payloadObj: Record<string, unknown> = {};

    try {
      const body = await decodeCbor(frame.payload);
      if (body && typeof body === "object") {
        const b = body as Record<number, unknown>;
        sessionId = String(b[2] ?? "unknown");
        intent = String(b[3] ?? "");
        if (typeof b[15] === "string") callId = b[15] as string;
        if (typeof b[24] === "string") taskId = b[24] as string;

        const raw5 = b[5];
        if (raw5 && typeof raw5 === "object" && !Buffer.isBuffer(raw5) && !(raw5 instanceof Uint8Array)) {
          payloadObj = raw5 as Record<string, unknown>;
        } else if (raw5) {
          const buf = Buffer.isBuffer(raw5) ? raw5 : Buffer.from(raw5 as Uint8Array);
          const str = buf.toString("utf-8");
          if (str) {
            try {
              const decoded = JSON.parse(str);
              if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
                payloadObj = decoded as Record<string, unknown>;
              }
            } catch {
              // ignore JSON parse error — payloadObj stays empty
            }
          }
        }
      }
    } catch {
      // ignore
    }

    if (taskId && this._streamingHandler) {
      return this._onStreamCall(socket, { sessionId, callId: callId ?? "", taskId, intent, payload: payloadObj });
    }

    let result: Buffer | undefined;
    let errorCode: number | undefined;
    let errorMessage: string | undefined;

    if (!this._handler) {
      errorCode = 503;
      errorMessage = "no handler configured";
    } else {
      const task = { task_id: callId ?? sessionId, intent, payload: payloadObj };
      const runHandler = async (): Promise<void> => {
        try {
          const handlerResult = await this._handler!(task);
          if (handlerResult && typeof handlerResult === "object" && "error_code" in handlerResult) {
            errorCode = Number((handlerResult as Record<string, unknown>).error_code);
            errorMessage = String((handlerResult as Record<string, unknown>).error_message ?? "handler error");
          } else {
            const out = (handlerResult as Record<string, unknown>).result ?? handlerResult;
            result = await encodeCbor(out);
          }
        } catch {
          errorCode = 500;
          errorMessage = "handler raised exception";
        }
      };
      // Tier 2 Item 5: optional ConcurrencyGate. CapacityExceededError →
      // RESPONSE error_code=429 IICP-E021 so the directory's NodeScorer
      // sees back-pressure consistently across HTTP + native IICP transports.
      if (this._gate && typeof this._gate.acquire === "function") {
        try {
          this._gate.acquire();
        } catch (exc) {
          const max = (exc as { maxConcurrent?: number }).maxConcurrent ?? 0;
          errorCode = 429;
          errorMessage = `IICP-E021: max_concurrent=${max} reached`;
          const resp = await encodeResponse({ sessionId, callId, result, errorCode, errorMessage });
          socket.write(encodeFrame(MsgType.RESPONSE, resp));
          return true;
        }
        try {
          await runHandler();
        } finally {
          this._gate.release();
        }
      } else {
        await runHandler();
      }
    }

    const resp = await encodeResponse({ sessionId, callId, result, errorCode, errorMessage });
    socket.write(encodeFrame(MsgType.RESPONSE, resp));
    return true;
  }

  private async _onStreamCall(
    socket: net.Socket,
    args: { sessionId: string; callId: string; taskId: string; intent: string; payload: Record<string, unknown> },
  ): Promise<boolean> {
    const handler = this._streamingHandler!;
    let sequence = 0;
    let terminalSent = false;
    const emit = async (item: {
      status: "partial" | "success" | "error" | "timeout"; result?: unknown;
      error_code?: string; error_message?: string; tokens_used?: number; event?: string;
    }): Promise<void> => {
      if (terminalSent) throw new Error("response_after_terminal");
      const payload = await encodeLifecycleResponse({
        sessionId: args.sessionId, callId: args.callId, taskId: args.taskId, sequence,
        status: item.status, result: item.result, errorCode: item.error_code,
        errorMessage: item.error_message, tokensUsed: item.tokens_used, event: item.event,
      });
      socket.write(encodeFrame(MsgType.RESPONSE, payload));
      sequence += 1;
      terminalSent = item.status !== "partial";
    };
    const run = async (): Promise<void> => {
      for await (const item of handler({
        task_id: args.taskId, call_id: args.callId, intent: args.intent, payload: args.payload,
      })) await emit(item);
      if (!terminalSent) await emit({
        status: "error", error_code: "stream_incomplete",
        error_message: "stream ended without a terminal response",
      });
    };
    try {
      if (this._gate && typeof this._gate.acquire === "function") {
        this._gate.acquire();
        try { await run(); } finally { this._gate.release(); }
      } else await run();
    } catch {
      if (!terminalSent) await emit({
        status: "error", error_code: "backend_error",
        error_message: "streaming handler raised exception",
      });
    }
    return true;
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

/** Raised when an IICP TCP RPC fails (wrong response type, server error, timeout). */
export class IicpTcpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IicpTcpClientError";
  }
}

export interface IicpTcpClientOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
}

/**
 * Native IICP TCP client (consumer side). Symmetric counterpart to
 * IicpTcpServer: connect, handshake, then issue PING/DISCOVER/CALL requests.
 *
 * Usage:
 *   const client = new IicpTcpClient({ host: "203.0.113.5", port: 9484 });
 *   await client.connect();
 *   await client.handshake();
 *   const nodes = await client.discover("urn:iicp:intent:llm:chat:v1");
 *   const result = await client.call("urn:iicp:intent:llm:chat:v1", { messages: [...] });
 *   await client.close();
 *   await client.disconnect();
 */
export class IicpTcpClient {
  private readonly _host: string;
  private readonly _port: number;
  private readonly _timeoutMs: number;
  private _socket: net.Socket | null = null;
  private _buf: Buffer = Buffer.alloc(0);
  private _waiters: Array<(value: Buffer | null) => void> = [];
  private _closed = false;
  /** node_id from the server's ACK payload (populated by handshake). */
  public peerNodeId: string | null = null;
  /** framing_version negotiated in the INIT/ACK (populated by handshake). */
  public framingVersion: number | null = null;

  constructor(opts: IicpTcpClientOptions) {
    this._host = opts.host;
    this._port = opts.port ?? 9484;
    this._timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async connect(): Promise<void> {
    // Validate cbor-x is importable before we open the socket.
    await getCbor();
    return new Promise((resolve, reject) => {
      const sock = net.connect(this._port, this._host);
      const t = setTimeout(() => {
        sock.destroy();
        reject(new IicpTcpClientError(`connect timeout to ${this._host}:${this._port}`));
      }, this._timeoutMs);
      sock.once("connect", () => {
        clearTimeout(t);
        this._socket = sock;
        sock.on("data", (chunk) => this._onData(chunk));
        sock.on("close", () => this._onClose());
        sock.on("error", () => this._onClose());
        resolve();
      });
      sock.once("error", (err) => {
        clearTimeout(t);
        reject(new IicpTcpClientError(`connect failed: ${err.message}`));
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this._socket) return;
    return new Promise((resolve) => {
      this._socket!.once("close", () => resolve());
      this._socket!.destroy();
    });
  }

  async handshake(): Promise<void> {
    if (!this._socket) throw new IicpTcpClientError("not connected");
    const initPayload = await encodeCbor(new Map<number, unknown>([[1, FRAMING_VERSION]]));
    this._socket.write(encodeFrame(MsgType.INIT, initPayload));
    const { msgType, payload } = await this._readFrame();
    if (msgType !== MsgType.ACK) {
      throw new IicpTcpClientError(`expected ACK (0x02), got 0x${msgType.toString(16)}`);
    }
    const body = payload.length
      ? ((await decodeCbor(payload)) as Record<number, unknown>)
      : undefined;
    const version = body?.[1];
    if (version !== FRAMING_VERSION) {
      throw new IicpTcpClientError(
        `ACK negotiated unsupported framing version ${String(version)}`,
      );
    }
    this.framingVersion = FRAMING_VERSION;
    const id = body?.[2];
    if (typeof id === "string") this.peerNodeId = id;
  }

  private _requireHandshake(): void {
    if (this.framingVersion !== FRAMING_VERSION) {
      throw new IicpTcpClientError("native session handshake is not complete");
    }
  }

  /** Send PING; return echoed bytes from PONG (or null if not echoed). */
  async ping(echo?: Buffer): Promise<Buffer | null> {
    if (!this._socket) throw new IicpTcpClientError("not connected");
    this._requireHandshake();
    const pingMap = new Map<number, unknown>();
    if (echo) pingMap.set(1, echo);
    const payload = await encodeCbor(pingMap);
    this._socket.write(encodeFrame(MsgType.PING, payload));
    const { msgType, payload: respPayload } = await this._readFrame();
    if (msgType !== MsgType.PONG) {
      throw new IicpTcpClientError(`expected PONG (0x0a), got 0x${msgType.toString(16)}`);
    }
    if (!respPayload.length) return null;
    const body = (await decodeCbor(respPayload)) as Record<number, unknown>;
    const v = body?.[1];
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v);
    return null;
  }

  /** Send DISCOVER for `intent`; return the nodes list from the RESPONSE. */
  async discover(intent: string, sessionId = "discover-1"): Promise<Record<string, unknown>[]> {
    if (!this._socket) throw new IicpTcpClientError("not connected");
    this._requireHandshake();
    const discMap = new Map<number, unknown>();
    discMap.set(2, sessionId);
    discMap.set(3, intent);
    const payload = await encodeCbor(discMap);
    this._socket.write(encodeFrame(MsgType.DISCOVER, payload));
    const { msgType, payload: respPayload } = await this._readFrame();
    if (msgType !== MsgType.RESPONSE) {
      throw new IicpTcpClientError(`expected RESPONSE (0x06), got 0x${msgType.toString(16)}`);
    }
    const body = (await decodeCbor(respPayload)) as Record<number, unknown>;
    const nodes = body?.[20];
    return Array.isArray(nodes) ? (nodes as Record<string, unknown>[]) : [];
  }

  /** Send CALL with JSON payload; return the CBOR-decoded result object. */
  async call(
    intent: string,
    payload: Record<string, unknown>,
    opts: { sessionId?: string; callId?: string; timeoutMs?: number } = {}
  ): Promise<Record<string, unknown>> {
    if (!this._socket) throw new IicpTcpClientError("not connected");
    this._requireHandshake();
    const body = new Map<number, unknown>();
    body.set(2, opts.sessionId ?? "call-1");
    body.set(3, intent);
    body.set(5, Buffer.from(JSON.stringify(payload)));
    if (opts.callId !== undefined) body.set(15, opts.callId);
    this._socket.write(encodeFrame(MsgType.CALL, await encodeCbor(body)));
    const { msgType, payload: respPayload } = await this._readFrame(opts.timeoutMs);
    if (msgType !== MsgType.RESPONSE) {
      throw new IicpTcpClientError(`expected RESPONSE (0x06), got 0x${msgType.toString(16)}`);
    }
    const resp = (await decodeCbor(respPayload)) as Record<number, unknown>;
    if (resp?.[100] !== undefined) {
      throw new IicpTcpClientError(`server error ${resp[100]}: ${String(resp[101] ?? "")}`);
    }
    const resultBytes = resp?.[5];
    if (resultBytes === undefined || resultBytes === null) return {};
    if (Buffer.isBuffer(resultBytes) || resultBytes instanceof Uint8Array) {
      const decoded = await decodeCbor(Buffer.from(resultBytes as Uint8Array));
      return decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : { value: decoded };
    }
    if (typeof resultBytes === "object") return resultBytes as Record<string, unknown>;
    return { value: resultBytes };
  }

  /** Yield validated events from the opt-in service-lifecycle profile. */
  async *streamCall(
    intent: string,
    payload: Record<string, unknown>,
    opts: {
      taskId: string;
      sessionId?: string;
      callId?: string;
      idempotencyKey?: string;
      timeoutMs?: number;
    },
  ): AsyncIterableIterator<NativeResponseFrame> {
    if (!this._socket) throw new IicpTcpClientError("not connected");
    this._requireHandshake();
    if (!opts.taskId) throw new IicpTcpClientError("taskId is required for lifecycle streaming");
    const sessionId = opts.sessionId ?? "call-1";
    const callId = opts.callId ?? randomUUID();
    const body = new Map<number, unknown>([
      [2, sessionId],
      [3, intent],
      [5, Buffer.from(JSON.stringify(payload))],
      [15, callId],
      [24, opts.taskId],
    ]);
    if (opts.idempotencyKey !== undefined) body.set(16, opts.idempotencyKey);
    this._socket.write(encodeFrame(MsgType.CALL, await encodeCbor(body)));

    const sequence = new NativeResponseSequence(sessionId, callId, opts.taskId);
    let terminal = false;
    try {
      while (!terminal) {
        let wire: { msgType: number; payload: Buffer };
        try {
          wire = await this._readFrame(opts.timeoutMs);
        } catch (error) {
          try {
            sequence.finish();
          } catch (lifecycleError) {
            throw new IicpTcpClientError(
              lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError),
            );
          }
          throw error;
        }
        if (wire.msgType !== MsgType.RESPONSE) {
          throw new IicpTcpClientError(`expected RESPONSE (0x06), got 0x${wire.msgType.toString(16)}`);
        }
        const frame = decodeLifecycleResponse(await decodeCbor(wire.payload));
        try {
          sequence.accept(frame);
        } catch (error) {
          throw new IicpTcpClientError(error instanceof Error ? error.message : String(error));
        }
        terminal = frame.is_final;
        yield frame;
      }
      sequence.finish();
    } finally {
      if (!terminal && this._socket && !this._socket.destroyed) this._socket.destroy();
    }
  }

  /** Send CLOSE (graceful teardown). Server hangs up; caller should disconnect. */
  async close(): Promise<void> {
    if (!this._socket || this._socket.destroyed) return;
    if (this.framingVersion !== FRAMING_VERSION) {
      this._socket.destroy();
      return;
    }
    this._socket.write(encodeFrame(MsgType.CLOSE, Buffer.alloc(0)));
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private _onData(chunk: Buffer): void {
    // Append the new data; do NOT clear the buffer. The consumer (_readFrame)
    // owns slicing/consuming bytes off `_buf` once it has parsed a full frame.
    this._buf = Buffer.concat([this._buf, chunk]);
    // Wake every waiter — each one re-checks the buffer itself.
    while (this._waiters.length) {
      const w = this._waiters.shift()!;
      w(this._buf);
    }
  }

  private _onClose(): void {
    this._closed = true;
    while (this._waiters.length) {
      const w = this._waiters.shift()!;
      w(null);
    }
  }

  private async _readFrame(timeoutMs?: number): Promise<{ msgType: number; payload: Buffer }> {
    const limit = timeoutMs ?? this._timeoutMs;
    const deadline = Date.now() + limit;

    // Wait for header
    while (this._buf.length < FRAME_HEADER_LEN) {
      if (this._closed) throw new IicpTcpClientError("connection closed");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new IicpTcpClientError("read timeout (header)");
      await this._waitForData(remaining);
    }
    if (!this._buf.subarray(0, 4).equals(IICP_MAGIC)) {
      throw new IicpTcpClientError(`bad magic in response: ${this._buf.subarray(0, 4).toString("hex")}`);
    }
    const version = this._buf.readUInt8(4);
    if (version !== FRAMING_VERSION) {
      throw new IicpTcpClientError(`unsupported framing version ${version} in response`);
    }
    const msgType = this._buf.readUInt8(5);
    const typeError = stableTaskMessageTypeError(msgType);
    if (typeError !== undefined) {
      throw new IicpTcpClientError(
        `rejected native task frame type 0x${msgType.toString(16).padStart(2, "0")}: ${typeError}`,
      );
    }
    const payloadLen = this._buf.readUInt32BE(8);
    if (payloadLen > MAX_FRAME_PAYLOAD) {
      throw new IicpTcpClientError(
        `response frame payload too large: ${payloadLen} > ${MAX_FRAME_PAYLOAD}`,
      );
    }
    const total = FRAME_HEADER_LEN + payloadLen;
    while (this._buf.length < total) {
      if (this._closed) throw new IicpTcpClientError("connection closed mid-frame");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new IicpTcpClientError("read timeout (payload)");
      await this._waitForData(remaining);
    }
    const payload = Buffer.from(this._buf.subarray(FRAME_HEADER_LEN, total));
    this._buf = Buffer.from(this._buf.subarray(total));
    return { msgType, payload };
  }

  private _waitForData(maxWaitMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this._waiters.indexOf(resolver);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(new IicpTcpClientError("read timeout"));
      }, maxWaitMs);
      const resolver = (_buf: Buffer | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve();
      };
      this._waiters.push(resolver);
    });
  }
}

function numericField(value: unknown, key: number): unknown {
  if (value instanceof Map) return value.get(key);
  if (value && typeof value === "object") return (value as Record<number, unknown>)[key];
  return undefined;
}

export function decodeLifecycleResponse(value: unknown): NativeResponseFrame {
  const lifecycle = numericField(value, 13);
  if (!lifecycle || typeof lifecycle !== "object") throw new IicpTcpClientError("missing_lifecycle");
  const error = numericField(value, 6);
  return {
    session_id: String(numericField(value, 2) ?? ""),
    call_id: String(numericField(value, 3) ?? ""),
    status: String(numericField(value, 4) ?? ""),
    is_final: numericField(value, 12) === true,
    lifecycle: {
      task_id: String(numericField(lifecycle, 1) ?? ""),
      sequence: Number(numericField(lifecycle, 2)),
      event: String(numericField(lifecycle, 3) ?? ""),
      is_final: numericField(lifecycle, 4) === true,
    },
    result: numericField(value, 5),
    tokens_used:
      numericField(value, 7) === undefined ? undefined : Number(numericField(value, 7)),
    error:
      error && typeof error === "object"
        ? { code: numericField(error, 1), message: numericField(error, 2) }
        : undefined,
  };
}

// SPDX-License-Identifier: Apache-2.0
/**
 * Native IICP binary transport (port 9484) — server + framing + cbor payloads.
 *
 * TypeScript port of iicp-client-python iicp_tcp.py (iter-1414). Wire-
 * compatible with adapter nodes and REACH FRAME-PING-01 / FRAME-INIT-01
 * conformance probes.
 *
 * cbor-x is an optional peer dependency installed only when an SDK consumer
 * actually wants to run a native-transport node. HTTP-only nodes don't need it.
 *
 * Implements the iter-1410 framing fixes from the start: session loop reads
 * the announced payload BEFORE decoding (pre-fix the adapter version closed
 * on every payload-bearing frame), and CALL handler decodes key-5 JSON dict
 * before invoking the user handler.
 *
 * Spec: iicp.network/spec/iicp-framing.md, ADR-040.
 */

import * as net from "node:net";

// ── Constants ─────────────────────────────────────────────────────────────────

export const IICP_MAGIC = Buffer.from("IICP", "ascii"); // 0x49 0x49 0x43 0x50
export const FRAMING_VERSION = 0x01;
export const FRAME_HEADER_LEN = 12; // magic(4) + ver(1) + type(1) + flags(1) + reserved(1) + length(4)
const MAX_PAYLOAD = 16 * 1024 * 1024;

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
}

// ── Frame ─────────────────────────────────────────────────────────────────────

export interface IicpFrame {
  version: number;
  msgType: number;
  flags: number;
  payload: Buffer;
}

export function encodeFrame(msgType: number, payload: Buffer = Buffer.alloc(0), flags = 0): Buffer {
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
  const msgType = data.readUInt8(5);
  const flags = data.readUInt8(6);
  // reserved at 7
  const payloadLen = data.readUInt32BE(8);
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
    _cbor = { encode: mod.encode, decode: mod.decode };
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
  const payload: Record<number, unknown> = { 1: framingVersion };
  if (nodeId !== undefined) payload[2] = nodeId;
  return encodeCbor(payload);
}

export async function encodePong(echo?: Buffer): Promise<Buffer> {
  const payload: Record<number, unknown> = {};
  if (echo) payload[1] = echo;
  return encodeCbor(payload);
}

export async function encodeResponse(args: {
  sessionId: string;
  callId?: string;
  result?: Buffer | string | null;
  errorCode?: number;
  errorMessage?: string;
}): Promise<Buffer> {
  const payload: Record<number, unknown> = { 2: args.sessionId };
  if (args.callId !== undefined) payload[15] = args.callId;
  if (args.result !== undefined && args.result !== null) {
    payload[5] = typeof args.result === "string" ? Buffer.from(args.result) : args.result;
  }
  if (args.errorCode !== undefined) payload[100] = args.errorCode;
  if (args.errorMessage !== undefined) payload[101] = args.errorMessage;
  return encodeCbor(payload);
}

export async function encodeDiscoverResponse(
  sessionId: string,
  intent: string,
  nodes: Record<string, unknown>[]
): Promise<Buffer> {
  return encodeCbor({ 2: sessionId, 3: intent, 20: nodes });
}

// ── Server ────────────────────────────────────────────────────────────────────

export type TcpTaskHandler = (task: {
  task_id: string;
  intent: string;
  payload: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

export type DiscoverLookup = (intent: string) => Promise<Record<string, unknown>[]>;

export interface IicpTcpServerOptions {
  host?: string;
  port?: number;
  nodeId?: string;
  handler?: TcpTaskHandler;
  discoverLookup?: DiscoverLookup;
}

export class IicpTcpServer {
  private readonly _host: string;
  private readonly _port: number;
  private readonly _nodeId: string | undefined;
  private readonly _handler: TcpTaskHandler | undefined;
  private readonly _discoverLookup: DiscoverLookup | undefined;
  private _server: net.Server | null = null;

  constructor(opts: IicpTcpServerOptions = {}) {
    this._host = opts.host ?? "0.0.0.0";
    this._port = opts.port ?? 9484;
    this._nodeId = opts.nodeId;
    this._handler = opts.handler;
    this._discoverLookup = opts.discoverLookup;
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

  private async _handleConnection(socket: net.Socket): Promise<void> {
    let buf = Buffer.alloc(0);
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
        const payloadLen = buf.readUInt32BE(8);
        if (payloadLen + FRAME_HEADER_LEN > MAX_PAYLOAD) {
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

        const keepOpen = await this._dispatch(frame, socket);
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
        return this._onInit(socket);
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

  private async _onInit(socket: net.Socket): Promise<boolean> {
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
    let payloadObj: Record<string, unknown> = {};

    try {
      const body = await decodeCbor(frame.payload);
      if (body && typeof body === "object") {
        const b = body as Record<number, unknown>;
        sessionId = String(b[2] ?? "unknown");
        intent = String(b[3] ?? "");
        if (typeof b[15] === "string") callId = b[15] as string;

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

    let result: Buffer | undefined;
    let errorCode: number | undefined;
    let errorMessage: string | undefined;

    if (!this._handler) {
      errorCode = 503;
      errorMessage = "no handler configured";
    } else {
      const task = { task_id: callId ?? sessionId, intent, payload: payloadObj };
      try {
        const handlerResult = await this._handler(task);
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
    }

    const resp = await encodeResponse({ sessionId, callId, result, errorCode, errorMessage });
    socket.write(encodeFrame(MsgType.RESPONSE, resp));
    return true;
  }
}

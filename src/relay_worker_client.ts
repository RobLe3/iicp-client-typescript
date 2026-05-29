// SPDX-License-Identifier: Apache-2.0
/**
 * Relay worker client — ADR-041 tier-3, Part 3 R2 (#341).
 *
 * TypeScript port of relay_worker_client.py.
 * A CGNAT-unreachable node connects outbound to a relay node here.
 * The relay pushes CALL frames down the persistent session; the worker
 * handles them and sends RESPONSE back. PING/PONG keepalive with auto-
 * reconnect (exponential backoff, cap 60 s).
 */

import * as net from "node:net";

const IICP_MAGIC = Buffer.from("IICP");
const FRAMING_VERSION = 0x01;
const FRAME_HEADER_LEN = 12;
const PING_INTERVAL_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
// #359 — explicit connect timeout so a TCP-reachable-but-not-accepting relay
// fails fast instead of blocking on the OS default; the _run() loop reconnects.
const CONNECT_TIMEOUT_MS = 10_000;

const MT_INIT = 0x01;
const MT_ACK = 0x02;
const MT_CALL = 0x05;
const MT_RESPONSE = 0x06;
const MT_PING = 0x09;
const MT_PONG = 0x0a;
const MT_RELAY_BIND = 0x0b;
const MT_RELAY_ACK = 0x0c;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const _cborx = require("cbor-x") as {
  Encoder: new (opts: object) => { encode: (v: unknown) => Buffer };
  decode: (v: Buffer) => unknown;
};
// useRecords:false + mapsAsObjects:false so encode(Map) emits a plain integer-keyed
// CBOR map (a2 01.. 02..) interoperable with Python cbor2 / Rust ciborium — NOT
// cbor-x Record tags. IICP wire headers are integer-keyed maps: build them with
// `new Map`, since a plain object {1:x} emits TEXT keys ("1") that integer-key
// decoders cannot read (GAPS-014). Mirrors src/iicp_tcp.ts.
const _encoder = new _cborx.Encoder({ useRecords: false, mapsAsObjects: false });

function _enc(obj: unknown): Buffer {
  return Buffer.from(_encoder.encode(obj));
}

function _dec(buf: Buffer): Record<number, unknown> {
  return _cborx.decode(buf) as Record<number, unknown>;
}

function makeFrame(msgType: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  IICP_MAGIC.copy(header, 0);
  header.writeUInt8(FRAMING_VERSION, 4);
  header.writeUInt8(msgType, 5);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

export type RelayTaskHandler = (task: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class RelayWorkerClient {
  private readonly _workerId: string;
  private readonly _intent: string;
  private readonly _relayHost: string;
  private readonly _relayPort: number;
  private readonly _handler: RelayTaskHandler;
  private readonly _models: string[];
  private readonly _onBind?: (relayHost: string, relayPort: number, workerId: string) => Promise<void>;
  private _stopped = false;

  constructor(opts: {
    workerId: string;
    intent: string;
    relayHost: string;
    relayPort: number;
    handler: RelayTaskHandler;
    models?: string[];
    /** Called after a successful RELAY_ACK — use to re-register with the directory (#358). */
    onBind?: (relayHost: string, relayPort: number, workerId: string) => Promise<void>;
  }) {
    this._workerId = opts.workerId;
    this._intent = opts.intent;
    this._relayHost = opts.relayHost;
    this._relayPort = opts.relayPort;
    this._handler = opts.handler;
    this._models = opts.models ?? [];
    this._onBind = opts.onBind;
  }

  /** Start the reconnect loop. Returns a stop() function. */
  start(): () => void {
    this._stopped = false;
    void this._run();
    return () => { this._stopped = true; };
  }

  private async _run(): Promise<void> {
    let delay = 2_000;
    while (!this._stopped) {
      try {
        await this._session();
        delay = 2_000;
      } catch {
        // reconnect
      }
      if (this._stopped) break;
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    }
  }

  private _session(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this._relayPort, this._relayHost);
      const connectTimer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`relay connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);
      socket.on("error", (e) => { clearTimeout(connectTimer); reject(e); });
      socket.on("connect", () => {
        clearTimeout(connectTimer);
        this._handshake(socket)
          .then(resolve)
          .catch(reject)
          .finally(() => socket.destroy());
      });
    });
  }

  private async _handshake(socket: net.Socket): Promise<void> {
    const chunks: Buffer[] = [];
    let resolveData: (() => void) | null = null;
    socket.on("data", (d: Buffer) => {
      chunks.push(d);
      if (resolveData) { resolveData(); resolveData = null; }
    });
    socket.on("end", () => { if (resolveData) { resolveData(); resolveData = null; } });

    const waitData = (): Promise<void> => new Promise((r) => { resolveData = r; });

    const readExact = async (n: number): Promise<Buffer | null> => {
      while (true) {
        const total = chunks.reduce((s, c) => s + c.length, 0);
        if (total >= n) {
          const merged = Buffer.concat(chunks);
          chunks.length = 0;
          chunks.push(merged.subarray(n));
          return merged.subarray(0, n);
        }
        if (socket.destroyed) return null;
        await waitData();
      }
    };

    const readFrame = async (): Promise<[number, Buffer] | null> => {
      const h = await readExact(FRAME_HEADER_LEN);
      if (!h) return null;
      if (!h.subarray(0, 4).equals(IICP_MAGIC)) return null;
      const mt = h.readUInt8(5);
      const plen = h.readUInt32BE(8);
      const payload = plen > 0 ? await readExact(plen) : Buffer.alloc(0);
      if (!payload) return null;
      return [mt, payload];
    };

    // Step 1: INIT → ACK
    socket.write(makeFrame(MT_INIT, _enc(new Map<number, unknown>([[1, FRAMING_VERSION]]))));
    const ack = await readFrame();
    if (!ack || ack[0] !== MT_ACK) throw new Error(`Expected ACK, got ${ack?.[0]}`);

    // Step 2: RELAY_BIND → RELAY_ACK
    socket.write(makeFrame(MT_RELAY_BIND, _enc(new Map<number, unknown>([
      [1, this._workerId],
      [2, this._intent],
      [3, this._models],
    ]))));
    const rack = await readFrame();
    if (!rack || rack[0] !== MT_RELAY_ACK) throw new Error(`Expected RELAY_ACK, got ${rack?.[0]}`);
    const ackBody = _dec(rack[1]);
    if (ackBody[1] !== "ok") throw new Error(`RELAY_ACK not ok: ${JSON.stringify(ackBody)}`);

    console.log(`[relay-worker] ${this._workerId}: bound to relay ${this._relayHost}:${this._relayPort}`);
    if (this._onBind) {
      try {
        await this._onBind(this._relayHost, this._relayPort, this._workerId);
      } catch (exc) {
        console.warn(`[relay-worker] onBind callback failed: ${exc instanceof Error ? exc.message : exc}`);
      }
    }

    // Step 3: session loop
    const pingTimer = setInterval(() => {
      if (!socket.destroyed) socket.write(makeFrame(MT_PING, _enc(new Map<number, unknown>([[1, Buffer.alloc(0)]]))));
    }, PING_INTERVAL_MS);

    try {
      while (!this._stopped && !socket.destroyed) {
        const frame = await readFrame();
        if (!frame) break;
        const [mt, payload] = frame;
        if (mt === MT_CALL) {
          void this._handleCall(payload, socket);
        } else if (mt === MT_PONG || mt === MT_PING) {
          // keepalive acknowledged / or relay's keepalive
        } else if (mt === 0x07) {
          break; // CLOSE
        }
      }
    } finally {
      clearInterval(pingTimer);
    }
  }

  private async _handleCall(payload: Buffer, socket: net.Socket): Promise<void> {
    let callId = "";
    let result: Record<string, unknown>;
    try {
      const body = _dec(payload);
      callId = String(body[15] ?? "");
      const raw5 = body[5];
      const taskStr = Buffer.isBuffer(raw5) ? raw5.toString() : String(raw5 ?? "{}");
      const task = JSON.parse(taskStr) as Record<string, unknown>;
      result = await this._handler(task);
    } catch (exc) {
      result = { error: exc instanceof Error ? exc.message : String(exc) };
    }
    try {
      const respPayload = _enc(new Map<number, unknown>([
        [15, callId],
        [5, Buffer.from(JSON.stringify(result))],
      ]));
      socket.write(makeFrame(MT_RESPONSE, respPayload));
    } catch (exc) {
      console.warn(`[relay-worker] failed to send RESPONSE: ${exc}`);
    }
  }
}

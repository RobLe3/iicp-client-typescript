// SPDX-License-Identifier: Apache-2.0
/**
 * Relay-as-last-resort — ADR-041 tier-3, Part 3 R1 (#341).
 *
 * TypeScript port of iicp-client-python/relay_session.py.
 * Workers behind CGNAT hold an outbound IICP-TCP connection here.
 * The relay pushes CALL frames down when /v1/relay is invoked and routes
 * RESPONSE frames back to the waiting HTTP handler.
 */

import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { consumeRelayBindTicket, type RelayBindTicketClaims, verifyRelayBindTicket } from "./relay_ticket.js";
import { decodeLifecycleResponse, MAX_FRAME_PAYLOAD } from "./iicp_tcp.js";
import { NativeResponseSequence, type NativeResponseFrame } from "./native_response_sequence.js";

const IICP_MAGIC = Buffer.from("IICP");
const FRAMING_VERSION = 0x01;
const FRAME_HEADER_LEN = 12;

// Frame type constants (mirrors MsgType enum in iicp_tcp.ts)
const MT_INIT = 0x01;
const MT_ACK = 0x02;
const MT_CALL = 0x05;
const MT_RESPONSE = 0x06;
const MT_CLOSE = 0x07;
const MT_PING = 0x09;
const MT_PONG = 0x0a;
const MT_RELAY_BIND = 0x0b;
const MT_RELAY_ACK = 0x0c;
const MAX_RELAY_STREAM_EVENTS = 32;

class PendingRelayStream {
  readonly sequence: NativeResponseSequence;
  readonly events: NativeResponseFrame[] = [];
  readonly waiters: Array<{ resolve: (event: NativeResponseFrame) => void; reject: (error: Error) => void }> = [];
  error: Error | null = null;

  constructor(sessionId: string, callId: string, taskId: string) {
    this.sequence = new NativeResponseSequence(sessionId, callId, taskId);
  }

  push(event: NativeResponseFrame): void {
    if (this.error) return;
    try { this.sequence.accept(event); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(event);
    else if (this.events.length >= MAX_RELAY_STREAM_EVENTS) this.fail(new Error("relay_backpressure_exceeded"));
    else this.events.push(event);
  }

  fail(error: Error): void {
    this.error = error;
    this.events.length = 0;
    while (this.waiters.length) this.waiters.shift()!.reject(error);
  }

  next(timeoutMs: number): Promise<NativeResponseFrame> {
    if (this.error) return Promise.reject(this.error);
    const event = this.events.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolve, reject) => {
      const waiter = { resolve: (value: NativeResponseFrame) => { clearTimeout(timer); resolve(value); }, reject: (error: Error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("relay_stream_timeout"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

type RelayQueuedCall = {
  call_id: string;
  task: unknown;
  task_id?: string;
  session_id?: string;
  stream?: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const _cborx = require("cbor-x") as {
  Encoder: new (opts: object) => { encode: (v: unknown) => Buffer };
  decode: (v: Buffer) => unknown;
};
// useRecords:false + mapsAsObjects:false so encode(Map) emits a plain integer-keyed
// CBOR map interoperable with Python cbor2 / Rust ciborium. IICP wire headers are
// integer-keyed maps: build them with `new Map` — a plain object {1:x} emits TEXT
// keys ("1") that integer-key decoders cannot read (GAPS-014). Mirrors src/iicp_tcp.ts.
const _encoder = new _cborx.Encoder({ useRecords: false, mapsAsObjects: false });

function _enc(obj: unknown): Buffer {
  return Buffer.from(_encoder.encode(obj));
}

function _dec(buf: Buffer): unknown {
  return _cborx.decode(buf);
}

function makeFrame(msgType: number, payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_PAYLOAD) throw new Error("relay frame payload too large");
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  IICP_MAGIC.copy(header, 0);
  header.writeUInt8(FRAMING_VERSION, 4);
  header.writeUInt8(msgType, 5);
  header.writeUInt8(0, 6); // flags
  header.writeUInt8(0, 7); // reserved
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

// ── RelayWorkerSession ────────────────────────────────────────────────────────

export class RelayWorkerSession {
  readonly workerId: string;
  private readonly _socket: net.Socket;
  private readonly _pending = new Map<string, (result: Record<string, unknown>) => void>();
  private readonly _streamPending = new Map<string, PendingRelayStream>();
  private _writeLocked = false;

  constructor(workerId: string, socket: net.Socket) {
    this.workerId = workerId;
    this._socket = socket;
  }

  /** Push a task CALL to the worker and await the RESPONSE (via Promise). */
  async forwardTask(task: unknown, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(callId);
        reject(new Error(`relay forward timeout for call ${callId}`));
      }, timeoutMs);

      this._pending.set(callId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      try {
        const payload = _enc(new Map<number, unknown>([
          [15, callId],
          [5, Buffer.from(JSON.stringify(task))],
        ]));
        const frame = makeFrame(MT_CALL, payload as Buffer);
        this._socket.write(frame);
      } catch (err) {
        this._pending.delete(callId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Whether the underlying worker socket is still alive/writable.
   * #510 interim hardening: an alive bound session must not be displaced
   * by a new RELAY_BIND for the same worker_id (unauthenticated bind).
   */
  isAlive(): boolean {
    return !this._socket.destroyed && this._socket.writable;
  }

  /** Called by relay accept server when a RESPONSE arrives from the worker. */
  onResponse(callId: string, result: Record<string, unknown>): void {
    const cb = this._pending.get(callId);
    if (cb) {
      this._pending.delete(callId);
      cb(result);
    }
  }

  async *forwardStream(task: Record<string, unknown>, timeoutMs = 120_000): AsyncIterableIterator<NativeResponseFrame> {
    const callId = randomUUID();
    const taskId = String(task.task_id ?? callId);
    const sessionId = String(task.session_id ?? callId);
    const pending = new PendingRelayStream(sessionId, callId, taskId);
    this._streamPending.set(callId, pending);
    try {
      this._socket.write(makeFrame(MT_CALL, _enc(new Map<number, unknown>([
        [2, sessionId], [15, callId], [24, taskId], [5, Buffer.from(JSON.stringify(task))],
      ]))));
      while (true) {
        const event = await pending.next(timeoutMs);
        yield event;
        if (event.is_final) return;
      }
    } finally { this._streamPending.delete(callId); }
  }

  onStreamResponse(callId: string, event: NativeResponseFrame): void {
    this._streamPending.get(callId)?.push(event);
  }
}

// ── HttpPollWorkerSession (#450 browser workers) ─────────────────────────────

/**
 * One bound HTTP long-poll relay-worker session.
 *
 * Duck-type compatible with RelayWorkerSession (forwardTask / isAlive /
 * onResponse) so the registry and relay handlers treat both transports
 * identically. Instead of pushing CALL frames down a TCP socket,
 * forwardTask() queues the call for the worker's GET /v1/relay/pull
 * long-poll; the worker posts the result via POST /v1/relay/result.
 *
 * Auth: `sessionToken` is issued at bind and presented as a Bearer token on
 * pull/result/unbind — stronger than the unauthenticated TCP RELAY_BIND
 * (#510), applied to the new transport from day one.
 *
 * Liveness = the worker pulled within `livenessWindowMs`. A dead session is
 * displaceable by a fresh bind (#510 interim-C: an ALIVE session never is).
 */
export class HttpPollWorkerSession {
  readonly workerId: string;
  readonly intent: string;
  readonly models: string[];
  readonly sessionToken: string;
  private readonly _queue: RelayQueuedCall[] = [];
  private readonly _waiters: Array<(call: RelayQueuedCall | null) => void> = [];
  private readonly _pending = new Map<string, (result: Record<string, unknown>) => void>();
  private readonly _streamPending = new Map<string, PendingRelayStream>();
  private _lastPull = Date.now();
  private readonly _livenessWindowMs: number;
  private _closed = false;

  constructor(workerId: string, opts: { intent?: string; models?: string[]; livenessWindowMs?: number } = {}) {
    this.workerId = workerId;
    this.intent = opts.intent ?? "";
    this.models = opts.models ?? [];
    this.sessionToken = randomUUID().replace(/-/g, "");
    this._livenessWindowMs = opts.livenessWindowMs ?? 90_000;
  }

  /** Queue a CALL for the polling worker and await its RESPONSE. */
  async forwardTask(task: unknown, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(callId);
        reject(new Error(`relay forward timeout for call ${callId}`));
      }, timeoutMs);
      this._pending.set(callId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      const call = { call_id: callId, task };
      const waiter = this._waiters.shift();
      if (waiter) waiter(call);
      else this._queue.push(call);
    });
  }

  /** Long-poll: next queued CALL, or null when the window elapses. */
  nextCall(timeoutMs = 25_000): Promise<RelayQueuedCall | null> {
    this._lastPull = Date.now();
    const queued = this._queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const waiter = (call: RelayQueuedCall | null) => {
        clearTimeout(timer);
        this._lastPull = Date.now();
        resolve(call);
      };
      const timer = setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) this._waiters.splice(i, 1);
        this._lastPull = Date.now();
        resolve(null);
      }, timeoutMs);
      this._waiters.push(waiter);
    });
  }

  isAlive(): boolean {
    return !this._closed && Date.now() - this._lastPull < this._livenessWindowMs;
  }

  onResponse(callId: string, result: Record<string, unknown>): void {
    const cb = this._pending.get(callId);
    if (cb) {
      this._pending.delete(callId);
      cb(result);
    }
  }

  async *forwardStream(task: Record<string, unknown>, timeoutMs = 120_000): AsyncIterableIterator<NativeResponseFrame> {
    const callId = randomUUID();
    const taskId = String(task.task_id ?? callId);
    const sessionId = String(task.session_id ?? callId);
    const pending = new PendingRelayStream(sessionId, callId, taskId);
    this._streamPending.set(callId, pending);
    const call = { call_id: callId, task_id: taskId, session_id: sessionId, stream: true, task };
    const waiter = this._waiters.shift();
    if (waiter) waiter(call);
    else this._queue.push(call);
    try {
      while (true) {
        const event = await pending.next(timeoutMs);
        yield event;
        if (event.is_final) return;
      }
    } finally { this._streamPending.delete(callId); }
  }

  onStreamResponse(callId: string, event: NativeResponseFrame): void {
    this._streamPending.get(callId)?.push(event);
  }

  close(): void {
    this._closed = true;
  }
}

export type RelaySession = RelayWorkerSession | HttpPollWorkerSession;

// ── RelaySessionRegistry ─────────────────────────────────────────────────────

// Red-team F5 (2026-06-12): cap concurrent relay sessions so a bind-flood
// can't exhaust relay memory / starve legitimate workers.
export const MAX_RELAY_SESSIONS = 256;
export const DEFAULT_RELAY_BIND_RATE_LIMIT = 30;
const RELAY_BIND_RATE_WINDOW_MS = 60_000;

export class RelaySessionRegistry {
  private readonly _sessions = new Map<string, RelaySession>();
  private readonly _bindRateLimit: number;
  private readonly _bindRateBuckets = new Map<string, { start: number; count: number }>();

  constructor(private readonly _max: number = MAX_RELAY_SESSIONS) {
    const parsed = Number(process.env["IICP_RELAY_BIND_RATE_LIMIT"] ?? DEFAULT_RELAY_BIND_RATE_LIMIT);
    this._bindRateLimit = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : DEFAULT_RELAY_BIND_RATE_LIMIT;
  }

  /** Bound bind attempts per transport source without persisting or logging it. */
  allowBind(source: string, opts: { rebind?: boolean; now?: number } = {}): boolean {
    if (opts.rebind || this._bindRateLimit === 0) return true;
    const now = opts.now ?? Date.now();
    let bucket = this._bindRateBuckets.get(source);
    if (!bucket || now - bucket.start >= RELAY_BIND_RATE_WINDOW_MS) bucket = { start: now, count: 0 };
    bucket.count += 1;
    this._bindRateBuckets.set(source, bucket);
    if (this._bindRateBuckets.size > 4096) {
      const cutoff = now - RELAY_BIND_RATE_WINDOW_MS;
      for (const [key, value] of this._bindRateBuckets) {
        if (value.start < cutoff) this._bindRateBuckets.delete(key);
      }
    }
    return bucket.count <= this._bindRateLimit;
  }

  /** True if a NEW worker_id can't be admitted (cap reached). A rebind of an
   * already-bound worker_id is always allowed (F5). */
  atCapacity(workerId: string): boolean {
    return !this._sessions.has(workerId) && this._sessions.size >= this._max;
  }

  count(): number {
    return this._sessions.size;
  }

  bind(workerId: string, session: RelaySession): void {
    this._sessions.set(workerId, session);
  }

  unbind(workerId: string): void {
    this._sessions.delete(workerId);
  }

  get(workerId: string): RelaySession | undefined {
    return this._sessions.get(workerId);
  }

  /** Find an HTTP-poll session by its bearer token (pull/result auth). */
  getByToken(token: string): HttpPollWorkerSession | undefined {
    if (!token) return undefined;
    for (const sess of this._sessions.values()) {
      if (sess instanceof HttpPollWorkerSession && sess.sessionToken === token) return sess;
    }
    return undefined;
  }

  isBound(workerId: string): boolean {
    return this._sessions.has(workerId);
  }

  boundWorkerIds(): string[] {
    return [...this._sessions.keys()];
  }
}

// ── RelayAcceptServer ─────────────────────────────────────────────────────────

export class RelayAcceptServer {
  private readonly _registry: RelaySessionRegistry;
  private readonly _host: string;
  private readonly _port: number;
  /** The relay's public HTTP task port — advertised in RELAY_ACK (field 4)
   * so workers can register {relay}:{httpPort}/v1/relay-for/<wid>. */
  readonly httpPort: number;
  private readonly _requireBindTicket: boolean;
  private readonly _bindTicketPublicKeyHex?: string;
  private readonly _relayNodeId: string;
  private _server?: net.Server;

  constructor(
    registry: RelaySessionRegistry,
    opts: {
      host?: string; port?: number; httpPort?: number;
      requireBindTicket?: boolean; bindTicketPublicKeyHex?: string; relayNodeId?: string;
    } = {},
  ) {
    this._registry = registry;
    this._host = opts.host ?? "0.0.0.0";
    this._port = opts.port ?? 9485;
    this.httpPort = opts.httpPort ?? 9484;
    this._requireBindTicket = opts.requireBindTicket ?? (process.env["IICP_RELAY_REQUIRE_BIND_TICKET"] === "1");
    this._bindTicketPublicKeyHex = opts.bindTicketPublicKeyHex ?? process.env["IICP_RELAY_BIND_TICKET_PUBLIC_KEY"];
    this._relayNodeId = opts.relayNodeId ?? process.env["IICP_NODE_ID"] ?? "*";
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        this._handleConnection(socket).catch((err) => {
          console.error(`[relay-accept] session error: ${err instanceof Error ? err.message : err}`);
          socket.destroy();
        });
      });
      this._server.listen(this._port, this._host, () => {
        console.log(`[relay-accept] listening on ${this._host}:${this._port}`);
        resolve();
      });
      this._server.on("error", reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this._server) {
        this._server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async _handleConnection(socket: net.Socket): Promise<void> {
    // Accumulate data into a buffer for synchronous frame parsing
    const chunks: Buffer[] = [];
    let resolveData: (() => void) | null = null;
    socket.on("data", (d: Buffer) => {
      chunks.push(d);
      if (resolveData) { resolveData(); resolveData = null; }
    });
    socket.on("end", () => { if (resolveData) { resolveData(); resolveData = null; } });
    socket.on("error", () => { if (resolveData) { resolveData(); resolveData = null; } });

    const waitForData = (): Promise<void> =>
      new Promise((r) => { resolveData = r; });

    const readExactly = async (n: number): Promise<Buffer | null> => {
      while (true) {
        let total = chunks.reduce((s, c) => s + c.length, 0);
        if (total >= n) {
          const merged = Buffer.concat(chunks);
          chunks.length = 0;
          chunks.push(merged.subarray(n));
          return merged.subarray(0, n);
        }
        if (socket.destroyed) return null;
        await waitForData();
      }
    };

    // Step 1: INIT
    const magic = await readExactly(4);
    if (!magic || !magic.equals(IICP_MAGIC)) return;
    const rest = await readExactly(FRAME_HEADER_LEN - 4);
    if (!rest) return;
    const header = Buffer.concat([magic, rest]);
    const version = header.readUInt8(4);
    const msgType = header.readUInt8(5);
    const payloadLen = header.readUInt32BE(8);
    if (version !== FRAMING_VERSION || msgType !== MT_INIT || payloadLen > MAX_FRAME_PAYLOAD) return;
    if (payloadLen > 0) { const _ = await readExactly(payloadLen); if (!_) return; }
    socket.write(makeFrame(MT_ACK, _enc(new Map<number, unknown>([[1, FRAMING_VERSION]])) as Buffer));

    // Step 2: RELAY_BIND
    const rh = await readExactly(FRAME_HEADER_LEN);
    if (!rh) return;
    if (!rh.subarray(0, 4).equals(IICP_MAGIC) || rh.readUInt8(4) !== FRAMING_VERSION) return;
    const rmt = rh.readUInt8(5);
    const rlen = rh.readUInt32BE(8);
    if (rmt !== MT_RELAY_BIND || rlen > MAX_FRAME_PAYLOAD) return;
    const rbuf = rlen > 0 ? await readExactly(rlen) : Buffer.alloc(0);
    if (!rbuf) return;
    let workerId: string, intent: string, models: string[], bindTicket: string;
    try {
      const body = _dec(rbuf) as Record<number, unknown>;
      workerId = String(body[1] ?? "");
      intent = String(body[2] ?? "");
      models = Array.isArray(body[3]) ? (body[3] as unknown[]).map(String) : [];
      bindTicket = typeof body[4] === "string" ? body[4] as string : "";
    } catch { return; }
    if (!workerId) return;

    // #510 full-mechanism additive rung: workers may present a short-lived
    // directory-signed bind ticket in RELAY_BIND field 4. Soft mode accepts
    // legacy unsigned binds with a warning; strict mode is opt-in until adoption
    // is measured.
    let claims: RelayBindTicketClaims | null = null;
    if (bindTicket && this._bindTicketPublicKeyHex) {
      claims = verifyRelayBindTicket(bindTicket, this._bindTicketPublicKeyHex, workerId, this._relayNodeId);
      if (!claims) {
        socket.write(makeFrame(MT_RELAY_ACK, _enc(new Map<number, unknown>([
          [1, "error"], [2, workerId], [3, "relay bind ticket invalid"],
        ])) as Buffer));
        socket.destroy();
        return;
      }
    } else if (this._requireBindTicket) {
      socket.write(makeFrame(MT_RELAY_ACK, _enc(new Map<number, unknown>([
        [1, "error"], [2, workerId], [3, "relay bind ticket required"],
      ])) as Buffer));
      socket.destroy();
      return;
    } else if (!bindTicket) {
      console.warn(`[relay-accept] unsigned RELAY_BIND for worker=${workerId} accepted in compatibility mode; enable IICP_RELAY_REQUIRE_BIND_TICKET=1 for public relays`);
    }

    // Compatibility hardening: an unsigned bind must never displace an
    // existing session whose socket is still alive (mid-session
    // hijack). Rebind after socket death (legitimate reconnect) still works.
    const existing = this._registry.get(workerId);
    if (existing && existing.isAlive()) {
      console.warn(
        `[relay-accept] rejected RELAY_BIND for worker=${workerId}: worker_id already bound to an alive session (#510)`,
      );
      socket.write(makeFrame(MT_RELAY_ACK, _enc(new Map<number, unknown>([
        [1, "error"],
        [2, workerId],
        [3, "worker_id already bound to an alive session"],
      ])) as Buffer));
      socket.destroy();
      return;
    }

    if (!this._registry.allowBind(socket.remoteAddress ?? "unknown", { rebind: existing !== undefined })) {
      socket.write(makeFrame(MT_RELAY_ACK, _enc(new Map<number, unknown>([
        [1, "error"], [2, workerId], [3, "relay_bind_rate_limited"],
      ])) as Buffer));
      socket.destroy();
      return;
    }

    // Red-team F5: cap concurrent sessions (bind-flood DoS). Rebind exempt.
    if (this._registry.atCapacity(workerId)) {
      console.warn(`[relay-accept] at session capacity — rejecting bind for ${workerId}`);
      socket.write(makeFrame(MT_RELAY_ACK, _enc(new Map<number, unknown>([
        [1, "error"], [2, workerId], [3, "relay at session capacity"],
      ])) as Buffer));
      socket.destroy();
      return;
    }
    if (claims && !consumeRelayBindTicket(claims)) {
      socket.write(makeFrame(MT_RELAY_ACK, _enc(new Map<number, unknown>([
        [1, "error"], [2, workerId], [3, "relay bind ticket replayed"],
      ])) as Buffer));
      socket.destroy();
      return;
    }

    const session = new RelayWorkerSession(workerId, socket);
    this._registry.bind(workerId, session);
    console.log(`[relay-accept] worker=${workerId} bound (intent=${intent} models=${models.slice(0, 3).join(",")})`);
    // Field 4 (additive, #450): the relay's HTTP task port, so the worker can
    // register {relay_host}:{http_port}/v1/relay-for/{worker_id} with the
    // directory. Old workers ignore unknown CBOR keys.
    socket.write(makeFrame(MT_RELAY_ACK, _enc(new Map<number, unknown>([[1, "ok"], [2, workerId], [4, this.httpPort]])) as Buffer));

    // Step 3: relay-worker frame loop
    try {
      while (!socket.destroyed) {
        const fh = await readExactly(FRAME_HEADER_LEN);
        if (!fh) break;
        if (!fh.subarray(0, 4).equals(IICP_MAGIC) || fh.readUInt8(4) !== FRAMING_VERSION) break;
        const ft = fh.readUInt8(5);
        const fl = fh.readUInt32BE(8);
        if (fl > MAX_FRAME_PAYLOAD) break;
        const fp = fl > 0 ? await readExactly(fl) : Buffer.alloc(0);
        if (!fp) break;

        if (ft === MT_PING) {
          let echo = Buffer.alloc(0);
          try { const pb = _dec(fp) as Record<number, unknown>; const e = pb[1]; echo = Buffer.isBuffer(e) ? Buffer.from(e) : Buffer.alloc(0); } catch { /* ok */ }
          socket.write(makeFrame(MT_PONG, _enc(new Map<number, unknown>([[1, echo]])) as Buffer));
        } else if (ft === MT_RESPONSE) {
          try {
            const decoded = _dec(fp);
            const hasLifecycle = decoded instanceof Map
              ? decoded.has(13)
              : Boolean(decoded && typeof decoded === "object" && 13 in decoded);
            if (hasLifecycle) {
              const lifecycleEvent = decodeLifecycleResponse(decoded);
              session.onStreamResponse(lifecycleEvent.call_id, lifecycleEvent);
              continue;
            }
            const rb = decoded as Record<number, unknown>;
            const callId = String(rb[15] ?? "");
            const raw5 = rb[5];
            let result: Record<string, unknown> = {};
            if (Buffer.isBuffer(raw5)) result = JSON.parse(raw5.toString()) as Record<string, unknown>;
            else if (typeof raw5 === "string") result = JSON.parse(raw5) as Record<string, unknown>;
            session.onResponse(callId, result);
          } catch (err) {
            console.warn(`[relay-accept] RESPONSE decode error: ${err}`);
          }
        } else if (ft === MT_CLOSE) {
          break;
        }
      }
    } finally {
      // Only remove the registry entry if it is still ours — a legitimate
      // reconnect may already have bound a newer session for this worker_id.
      if (this._registry.get(workerId) === session) {
        this._registry.unbind(workerId);
      }
      console.log(`[relay-accept] session ended for worker=${workerId}`);
      socket.destroy();
    }
  }
}

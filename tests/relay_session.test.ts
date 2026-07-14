// ADR-016: IICP client SDK conformance — ADR-041 tier-3 / #341 relay R1 (TypeScript parity)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as net from "node:net";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { RelayAcceptServer, RelaySessionRegistry, RelayWorkerSession } from "../src/relay_session.js";

// ── frame type constants ─────────────────────────────────────────────────────

describe("MsgType relay extensions", () => {
  it("RELAY_BIND is 0x0B and RELAY_ACK is 0x0C", async () => {
    const { MsgType } = await import("../src/iicp_tcp.js");
    assert.equal((MsgType as Record<string, number>).RELAY_BIND, 0x0b);
    assert.equal((MsgType as Record<string, number>).RELAY_ACK, 0x0c);
  });
});

// ── RelaySessionRegistry ─────────────────────────────────────────────────────

describe("RelaySessionRegistry", () => {
  it("rate-limits each source independently and recovers after the window", () => {
    process.env.IICP_RELAY_BIND_RATE_LIMIT = "2";
    try {
      const reg = new RelaySessionRegistry();
      assert.equal(reg.allowBind("source-a", { now: 10 }), true);
      assert.equal(reg.allowBind("source-a", { now: 10 }), true);
      assert.equal(reg.allowBind("source-a", { now: 10 }), false);
      assert.equal(reg.allowBind("source-b", { now: 10 }), true);
      assert.equal(reg.allowBind("source-a", { now: 60_011 }), true);
    } finally {
      delete process.env.IICP_RELAY_BIND_RATE_LIMIT;
    }
  });

  it("exempts recovery and supports diagnostic disable", () => {
    process.env.IICP_RELAY_BIND_RATE_LIMIT = "1";
    const reg = new RelaySessionRegistry();
    assert.equal(reg.allowBind("source-a", { now: 10 }), true);
    assert.equal(reg.allowBind("source-a", { rebind: true, now: 10 }), true);
    process.env.IICP_RELAY_BIND_RATE_LIMIT = "0";
    try {
      const disabled = new RelaySessionRegistry();
      for (let i = 0; i < 100; i += 1) assert.equal(disabled.allowBind("source-a", { now: 10 }), true);
    } finally {
      delete process.env.IICP_RELAY_BIND_RATE_LIMIT;
    }
  });

  it("bind and get returns the session", () => {
    const reg = new RelaySessionRegistry();
    const sock = { write: () => {}, destroy: () => {}, destroyed: false } as never;
    const session = new RelayWorkerSession("w-001", sock);
    reg.bind("w-001", session);
    assert.strictEqual(reg.get("w-001"), session);
  });

  it("get on missing worker returns undefined", () => {
    const reg = new RelaySessionRegistry();
    assert.equal(reg.get("nobody"), undefined);
  });

  it("unbind removes entry", () => {
    const reg = new RelaySessionRegistry();
    const sock = { write: () => {}, destroy: () => {}, destroyed: false } as never;
    reg.bind("w-001", new RelayWorkerSession("w-001", sock));
    reg.unbind("w-001");
    assert.equal(reg.get("w-001"), undefined);
  });

  it("isBound reflects state", () => {
    const reg = new RelaySessionRegistry();
    const sock = { write: () => {}, destroy: () => {}, destroyed: false } as never;
    assert.equal(reg.isBound("w-001"), false);
    reg.bind("w-001", new RelayWorkerSession("w-001", sock));
    assert.equal(reg.isBound("w-001"), true);
    reg.unbind("w-001");
    assert.equal(reg.isBound("w-001"), false);
  });

  it("boundWorkerIds returns all bound ids", () => {
    const reg = new RelaySessionRegistry();
    const sock = { write: () => {}, destroy: () => {}, destroyed: false } as never;
    reg.bind("a", new RelayWorkerSession("a", sock));
    reg.bind("b", new RelayWorkerSession("b", sock));
    const ids = reg.boundWorkerIds();
    assert.deepEqual(ids.sort(), ["a", "b"]);
  });
});

// ── RelayWorkerSession.onResponse ────────────────────────────────────────────

describe("RelayWorkerSession.onResponse", () => {
  it("resolves a pending forward task future", async () => {
    const writes: Buffer[] = [];
    const sock = {
      write: (b: Buffer) => { writes.push(b); return true; },
      destroy: () => {},
      destroyed: false,
    } as never;
    const session = new RelayWorkerSession("w-001", sock);
    // Simulate: forwardTask enqueues future; onResponse resolves it.
    const pending = new Map<string, (r: Record<string, unknown>) => void>();
    (session as unknown as { _pending: Map<string, unknown> })._pending = pending;
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      pending.set("call-xyz", resolve);
      session.onResponse("call-xyz", { choices: [{ message: { content: "ok" } }] });
    });
    assert.equal((result as { choices: Array<{ message: { content: string } }> }).choices[0].message.content, "ok");
  });

  it("ignores unknown call ids", () => {
    const sock = { write: () => {}, destroy: () => {}, destroyed: false } as never;
    const session = new RelayWorkerSession("w-001", sock);
    // Should not throw
    session.onResponse("not-registered", { foo: "bar" });
  });
});

// ── RelayAcceptServer bind hardening (#510) ──────────────────────────────────
// Behavior tests: these fail if the alive-session rebind rejection is reverted.

const FRAME_HEADER_LEN = 12;
const MT_INIT = 0x01;
const MT_CALL = 0x05;
const MT_RESPONSE = 0x06;
const MT_RELAY_BIND = 0x0b;
const MT_RELAY_ACK = 0x0c;

async function _cbor() {
  const mod = await import("cbor-x");
  const encoder = new mod.Encoder({ useRecords: false, mapsAsObjects: false });
  return {
    enc: (v: unknown) => Buffer.from(encoder.encode(v)),
    dec: (b: Buffer) => mod.decode(b) as Record<number, unknown>,
  };
}

function _mkFrame(msgType: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  Buffer.from("IICP").copy(header, 0);
  header.writeUInt8(0x01, 4);
  header.writeUInt8(msgType, 5);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

/** Minimal wire-level relay worker: INIT/ACK + RELAY_BIND handshake over a real socket. */
class WireWorker {
  readonly sock: net.Socket;
  private readonly _chunks: Buffer[] = [];
  private _notify: (() => void) | null = null;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", (d: Buffer) => {
      this._chunks.push(d);
      if (this._notify) { this._notify(); this._notify = null; }
    });
    sock.on("close", () => { if (this._notify) { this._notify(); this._notify = null; } });
    sock.on("error", () => { /* swallow — destroyed sockets are expected in these tests */ });
  }

  static connect(port: number): Promise<WireWorker> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => resolve(new WireWorker(sock)));
      sock.once("error", reject);
    });
  }

  private async _readExactly(n: number): Promise<Buffer> {
    for (;;) {
      const total = this._chunks.reduce((s, c) => s + c.length, 0);
      if (total >= n) {
        const merged = Buffer.concat(this._chunks);
        this._chunks.length = 0;
        this._chunks.push(merged.subarray(n));
        return merged.subarray(0, n);
      }
      if (this.sock.destroyed) throw new Error("socket closed while reading");
      await new Promise<void>((r) => { this._notify = r; });
    }
  }

  async readFrame(): Promise<{ msgType: number; payload: Buffer }> {
    const header = await this._readExactly(FRAME_HEADER_LEN);
    const len = header.readUInt32BE(8);
    const payload = len > 0 ? await this._readExactly(len) : Buffer.alloc(0);
    return { msgType: header.readUInt8(5), payload };
  }

  /** INIT/ACK + RELAY_BIND; returns the decoded RELAY_ACK body. */
  async bind(workerId: string, bindTicket?: string): Promise<Record<number, unknown>> {
    const { enc, dec } = await _cbor();
    this.sock.write(_mkFrame(MT_INIT, enc(new Map<number, unknown>([[1, 0x01]]))));
    const ack = await this.readFrame();
    assert.equal(ack.msgType, 0x02, "expected ACK after INIT");
    const bind = new Map<number, unknown>([
      [1, workerId],
      [2, "urn:iicp:intent:llm:chat:v1"],
      [3, []],
    ]);
    if (bindTicket) bind.set(4, bindTicket);
    this.sock.write(_mkFrame(MT_RELAY_BIND, enc(bind)));
    const rack = await this.readFrame();
    assert.equal(rack.msgType, MT_RELAY_ACK, "expected RELAY_ACK after RELAY_BIND");
    return dec(rack.payload);
  }
}

async function _startServer(
  reg: RelaySessionRegistry,
  opts: ConstructorParameters<typeof RelayAcceptServer>[1] = {},
): Promise<{ srv: RelayAcceptServer; port: number }> {
  const srv = new RelayAcceptServer(reg, { host: "127.0.0.1", port: 0, ...opts });
  await srv.start();
  const addr = (srv as unknown as { _server: net.Server })._server.address() as net.AddressInfo;
  return { srv, port: addr.port };
}

function _signedTicket(workerId: string, relayId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  const payload = Buffer.from(JSON.stringify({
    v: 1, typ: "relay-bind-ticket", jti: randomBytes(16).toString("hex"),
    iss: "test", sub: workerId, aud: relayId, iat: 1, exp: 9_999_999_999,
  })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sig = sign(null, Buffer.from("iicp:relay-bind-ticket:v1\n" + payload), privateKey).toString("hex");
  return { token: `${payload}.${sig}`, publicKeyHex: pubHex };
}

describe("RelayAcceptServer bind hardening (#510)", () => {
  it("rejects a second RELAY_BIND while the bound session socket is alive (hijack attempt)", async () => {
    const reg = new RelaySessionRegistry();
    const { srv, port } = await _startServer(reg);
    const cleanup: net.Socket[] = [];
    try {
      const workerA = await WireWorker.connect(port);
      cleanup.push(workerA.sock);
      const ackA = await workerA.bind("w-hijack");
      assert.equal(ackA[1], "ok");
      const sessionA = reg.get("w-hijack");
      assert.ok(sessionA, "worker A must be bound");

      // Attacker on socket B tries to bind the same worker_id while A is alive.
      const workerB = await WireWorker.connect(port);
      cleanup.push(workerB.sock);
      const ackB = await workerB.bind("w-hijack");
      assert.equal(ackB[1], "error", "second bind of an alive worker must be rejected");

      // A's session must remain installed and must still receive dispatches.
      assert.strictEqual(reg.get("w-hijack"), sessionA, "registry entry must not be replaced");
      assert.equal(sessionA.isAlive(), true);

      const { enc, dec } = await _cbor();
      const dispatch = sessionA.forwardTask({ ping: 1 }, 5_000);
      const call = await workerA.readFrame();
      assert.equal(call.msgType, MT_CALL, "dispatch must arrive on worker A's socket");
      const callBody = dec(call.payload);
      const callId = String(callBody[15] ?? "");
      workerA.sock.write(_mkFrame(MT_RESPONSE, enc(new Map<number, unknown>([
        [15, callId],
        [5, Buffer.from(JSON.stringify({ pong: true }))],
      ]))));
      const result = await dispatch;
      assert.equal((result as { pong?: boolean }).pong, true);
    } finally {
      for (const s of cleanup) s.destroy();
      await srv.stop();
    }
  });

  it("allows rebind after the original socket dies (legitimate reconnect)", async () => {
    const reg = new RelaySessionRegistry();
    const { srv, port } = await _startServer(reg);
    const cleanup: net.Socket[] = [];
    try {
      const workerA = await WireWorker.connect(port);
      cleanup.push(workerA.sock);
      const ackA = await workerA.bind("w-reconnect");
      assert.equal(ackA[1], "ok");

      workerA.sock.destroy();
      // Wait until the relay sees the dead socket (unbound, or bound-but-dead).
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const s = reg.get("w-reconnect");
        if (!s || !s.isAlive()) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const workerB = await WireWorker.connect(port);
      cleanup.push(workerB.sock);
      const ackB = await workerB.bind("w-reconnect");
      assert.equal(ackB[1], "ok", "rebind after socket death must succeed");
      assert.equal(reg.isBound("w-reconnect"), true);
      assert.equal(reg.get("w-reconnect")?.isAlive(), true);
    } finally {
      for (const s of cleanup) s.destroy();
      await srv.stop();
    }
  });

  it("strict #510 mode accepts valid relay bind ticket and rejects wrong worker", async () => {
    const reg = new RelaySessionRegistry();
    const good = _signedTicket("w-ticket", "relay-test");
    const badWorker = _signedTicket("attacker", "relay-test");
    const { srv, port } = await _startServer(reg, {
      requireBindTicket: true,
      bindTicketPublicKeyHex: good.publicKeyHex,
      relayNodeId: "relay-test",
    });
    const cleanup: net.Socket[] = [];
    try {
      const worker = await WireWorker.connect(port);
      cleanup.push(worker.sock);
      const ack = await worker.bind("w-ticket", good.token);
      assert.equal(ack[1], "ok");
      worker.sock.destroy();
      await new Promise((r) => setTimeout(r, 20));

      const attacker = await WireWorker.connect(port);
      cleanup.push(attacker.sock);
      const badAck = await attacker.bind("w-ticket", badWorker.token);
      assert.equal(badAck[1], "error");
      assert.equal(badAck[3], "relay bind ticket invalid");
    } finally {
      for (const s of cleanup) s.destroy();
      await srv.stop();
    }
  });
});

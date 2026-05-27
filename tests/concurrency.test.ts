/**
 * Unit tests for ConcurrencyGate + its IicpTcpServer wiring. TS port of the
 * Python test_concurrency.py matrix.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { encode as cborEncode, decode as cborDecode } from "cbor-x";

import { CapacityExceededError, ConcurrencyGate } from "../src/concurrency.js";
import {
  IicpTcpServer,
  IICP_MAGIC,
  FRAMING_VERSION,
  FRAME_HEADER_LEN,
  MsgType,
  encodeFrame,
} from "../src/iicp_tcp.js";

const HOST = "127.0.0.1";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, HOST, () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

// ── Primitive ──────────────────────────────────────────────────────────────

describe("ConcurrencyGate primitive", () => {
  it("rejects max_concurrent < 1", () => {
    assert.throws(() => new ConcurrencyGate(0), /max_concurrent must be >= 1/);
  });

  it("activeJobs and load track acquisitions", async () => {
    const g = new ConcurrencyGate(2);
    assert.equal(g.activeJobs, 0);
    assert.equal(g.load, 0);
    g.acquire();
    assert.equal(g.activeJobs, 1);
    assert.equal(g.load, 0.5);
    g.acquire();
    assert.equal(g.activeJobs, 2);
    assert.equal(g.load, 1);
    g.release();
    assert.equal(g.activeJobs, 1);
    g.release();
    assert.equal(g.activeJobs, 0);
  });

  it("acquire throws CapacityExceededError when full", () => {
    const g = new ConcurrencyGate(2);
    g.acquire();
    g.acquire();
    try {
      g.acquire();
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof CapacityExceededError);
      assert.equal((e as CapacityExceededError).maxConcurrent, 2);
    }
  });

  it("run() helper releases slot on success", async () => {
    const g = new ConcurrencyGate(1);
    const out = await g.run(async () => "result");
    assert.equal(out, "result");
    assert.equal(g.activeJobs, 0);
  });

  it("run() helper releases slot on error", async () => {
    const g = new ConcurrencyGate(1);
    try {
      await g.run(async () => {
        throw new Error("boom");
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal((e as Error).message, "boom");
    }
    assert.equal(g.activeJobs, 0);
  });
});

// ── IicpTcpServer integration ──────────────────────────────────────────────

async function sendCall(port: number, callId: string): Promise<{ msgType: number; payload: Buffer }> {
  return new Promise(async (resolve, reject) => {
    const sock = net.connect(port, HOST);
    sock.once("error", reject);

    const buf: Buffer[] = [];
    let total = Buffer.alloc(0);
    let needHeader = true;
    let frameLen = 0;
    let initSeen = false;

    sock.on("data", (chunk: Buffer) => {
      total = Buffer.concat([total, chunk]);
      while (true) {
        if (needHeader) {
          if (total.length < FRAME_HEADER_LEN) return;
          frameLen = FRAME_HEADER_LEN + total.readUInt32BE(8);
          needHeader = false;
        }
        if (total.length < frameLen) return;
        const frame = total.subarray(0, frameLen);
        total = Buffer.from(total.subarray(frameLen));
        needHeader = true;

        if (!initSeen) {
          initSeen = true;
          // Sent ACK; send CALL next
          const callPayload = {
            2: "sess",
            3: "urn:iicp:intent:llm:chat:v1",
            15: callId,
            5: Buffer.from(JSON.stringify({ messages: [] })),
          };
          sock.write(encodeFrame(MsgType.CALL, Buffer.from(cborEncode(callPayload))));
        } else {
          const msgType = frame.readUInt8(5);
          const payload = Buffer.from(frame.subarray(FRAME_HEADER_LEN));
          sock.destroy();
          resolve({ msgType, payload });
          return;
        }
      }
    });

    sock.on("connect", () => {
      sock.write(encodeFrame(MsgType.INIT, Buffer.from(cborEncode({ 1: FRAMING_VERSION }))));
    });
  });
}

describe("IicpTcpServer ConcurrencyGate integration", () => {
  it("under-capacity CALL passes through", async () => {
    const port = await freePort();
    const gate = new ConcurrencyGate(2);
    const server = new IicpTcpServer({
      host: HOST,
      port,
      nodeId: "gated",
      handler: async () => ({ result: { ok: true } }),
      concurrencyGate: gate,
    });
    await server.start();
    try {
      const { msgType, payload } = await sendCall(port, "c1");
      assert.equal(msgType, MsgType.RESPONSE);
      const body = cborDecode(payload) as Record<number, unknown>;
      assert.equal(body[100], undefined, `unexpected error: ${body[100]} ${body[101]}`);
    } finally {
      await server.stop();
    }
  });

  it("at-capacity third CALL returns 429 IICP-E021", async () => {
    const port = await freePort();
    const gate = new ConcurrencyGate(2);
    // Slow handler keyed off external promise so we can hold the slots
    let releaseHandlers: () => void = () => {};
    const holdAll = new Promise<void>((res) => (releaseHandlers = res));
    const server = new IicpTcpServer({
      host: HOST,
      port,
      nodeId: "gated",
      handler: async () => {
        await holdAll;
        return { result: { ok: true } };
      },
      concurrencyGate: gate,
    });
    await server.start();
    try {
      // Fire two long-running calls in the background; they'll take both slots
      const c1 = sendCall(port, "c1");
      const c2 = sendCall(port, "c2");
      // Wait for both slots to be occupied
      for (let i = 0; i < 50; i++) {
        if (gate.activeJobs >= 2) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(gate.activeJobs, 2, "slots should be full before third call");
      // Third call hits capacity gate
      const { msgType, payload } = await sendCall(port, "c3");
      assert.equal(msgType, MsgType.RESPONSE);
      const body = cborDecode(payload) as Record<number, unknown>;
      assert.equal(body[100], 429);
      assert.match(String(body[101]), /IICP-E021/);
      // Cleanup
      releaseHandlers();
      await c1;
      await c2;
    } finally {
      await server.stop();
    }
  });
});

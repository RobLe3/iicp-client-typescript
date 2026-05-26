/**
 * IicpTcpServer integration tests — TypeScript port of iicp-client-python's
 * tests/test_iicp_tcp.py. Same protocol matrix as the adapter's
 * /tmp/iicp_test_client.py: INIT/ACK, PING-with-echo, empty PING, DISCOVER,
 * CALL via handler, CLOSE, bad-magic, and the iter-1410 framing-fix regression.
 *
 * Runs via: node --test (via npm test).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { encode as cborEncode, decode as cborDecode } from "cbor-x";

import {
  IicpTcpClient,
  IicpTcpClientError,
  IicpTcpServer,
  IICP_MAGIC,
  FRAMING_VERSION,
  FRAME_HEADER_LEN,
  MsgType,
  encodeFrame,
} from "../src/iicp_tcp.js";

const HOST = "127.0.0.1";
const TIMEOUT_MS = 5000;

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

interface ReadFrame {
  msgType: number;
  payload: Buffer;
}

function connectAndCollect(host: string, port: number) {
  return new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(port, host);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

async function readFrame(socket: net.Socket): Promise<ReadFrame> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let needed = FRAME_HEADER_LEN;
    let mode: "header" | "payload" = "header";
    let payloadLen = 0;
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error("readFrame timeout"));
    }, TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const total = Buffer.concat(chunks);
      if (mode === "header" && total.length >= FRAME_HEADER_LEN) {
        if (!total.subarray(0, 4).equals(IICP_MAGIC)) {
          clearTimeout(timer);
          socket.off("data", onData);
          reject(new Error(`bad magic: ${total.subarray(0, 4).toString("hex")}`));
          return;
        }
        const msgType = total.readUInt8(5);
        payloadLen = total.readUInt32BE(8);
        if (total.length >= FRAME_HEADER_LEN + payloadLen) {
          clearTimeout(timer);
          socket.off("data", onData);
          // Stash leftover bytes for next read
          const leftover = total.subarray(FRAME_HEADER_LEN + payloadLen);
          if (leftover.length) socket.unshift(leftover);
          resolve({ msgType, payload: Buffer.from(total.subarray(FRAME_HEADER_LEN, FRAME_HEADER_LEN + payloadLen)) });
          return;
        }
        mode = "payload";
        needed = FRAME_HEADER_LEN + payloadLen;
      }
      if (mode === "payload" && total.length >= needed) {
        clearTimeout(timer);
        socket.off("data", onData);
        const msgType = total.readUInt8(5);
        const leftover = total.subarray(needed);
        if (leftover.length) socket.unshift(leftover);
        resolve({
          msgType,
          payload: Buffer.from(total.subarray(FRAME_HEADER_LEN, needed)),
        });
      }
    };
    socket.on("data", onData);
  });
}

// ── Shared server fixture ─────────────────────────────────────────────────────

describe("IicpTcpServer", () => {
  let server: IicpTcpServer;
  let port: number;

  before(async () => {
    port = await freePort();
    server = new IicpTcpServer({
      host: HOST,
      port,
      nodeId: "test-node-id",
      handler: async (task) => ({ result: { echo: task.payload } }),
      discoverLookup: async (intent) => [
        { node_id: "fake-1", endpoint: "http://fake.example:8080", intent },
        { node_id: "fake-2", endpoint: "http://fake.example:8080", intent },
      ],
    });
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  it("INIT → ACK echoes framing_version and node_id", async () => {
    const sock = await connectAndCollect(HOST, port);
    sock.write(encodeFrame(MsgType.INIT, Buffer.from(cborEncode({ 1: FRAMING_VERSION }))));
    const f = await readFrame(sock);
    assert.equal(f.msgType, MsgType.ACK);
    const body = cborDecode(f.payload) as Record<number, unknown>;
    assert.equal(body[1], FRAMING_VERSION);
    assert.equal(body[2], "test-node-id");
    sock.destroy();
  });

  it("PING with echo → PONG round-trips bytes", async () => {
    const sock = await connectAndCollect(HOST, port);
    sock.write(encodeFrame(MsgType.INIT, Buffer.from(cborEncode({ 1: FRAMING_VERSION }))));
    await readFrame(sock); // consume ACK

    const echo = Buffer.from("ts-tcp-roundtrip-2026");
    sock.write(encodeFrame(MsgType.PING, Buffer.from(cborEncode({ 1: echo }))));
    const f = await readFrame(sock);
    assert.equal(f.msgType, MsgType.PONG);
    const body = cborDecode(f.payload) as Record<number, unknown>;
    const got = body[1];
    assert.ok(Buffer.isBuffer(got) || got instanceof Uint8Array);
    assert.deepEqual(Buffer.from(got as Uint8Array), echo);
    sock.destroy();
  });

  it("empty PING → PONG with no echo", async () => {
    const sock = await connectAndCollect(HOST, port);
    sock.write(encodeFrame(MsgType.INIT, Buffer.from(cborEncode({ 1: FRAMING_VERSION }))));
    await readFrame(sock);

    sock.write(encodeFrame(MsgType.PING, Buffer.from(cborEncode({}))));
    const f = await readFrame(sock);
    assert.equal(f.msgType, MsgType.PONG);
    const body = f.payload.length ? (cborDecode(f.payload) as Record<number, unknown>) : {};
    assert.equal(body[1], undefined);
    sock.destroy();
  });

  it("DISCOVER → RESPONSE via discoverLookup callback", async () => {
    const sock = await connectAndCollect(HOST, port);
    sock.write(encodeFrame(MsgType.INIT, Buffer.from(cborEncode({ 1: FRAMING_VERSION }))));
    await readFrame(sock);

    const intent = "urn:iicp:intent:llm:chat:v1";
    sock.write(encodeFrame(MsgType.DISCOVER, Buffer.from(cborEncode({ 2: "sess-d1", 3: intent }))));
    const f = await readFrame(sock);
    assert.equal(f.msgType, MsgType.RESPONSE);
    const body = cborDecode(f.payload) as Record<number, unknown>;
    assert.equal(body[2], "sess-d1");
    assert.equal(body[3], intent);
    const nodes = body[20] as Record<string, unknown>[];
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].node_id, "fake-1");
    sock.destroy();
  });

  it("CALL → RESPONSE invokes handler with JSON-decoded payload", async () => {
    const sock = await connectAndCollect(HOST, port);
    sock.write(encodeFrame(MsgType.INIT, Buffer.from(cborEncode({ 1: FRAMING_VERSION }))));
    await readFrame(sock);

    const jsonPayload = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
    sock.write(
      encodeFrame(
        MsgType.CALL,
        Buffer.from(
          cborEncode({
            2: "sess-c1",
            3: "urn:iicp:intent:llm:chat:v1",
            15: "call-0001",
            5: jsonPayload,
          })
        )
      )
    );
    const f = await readFrame(sock);
    assert.equal(f.msgType, MsgType.RESPONSE);
    const body = cborDecode(f.payload) as Record<number, unknown>;
    assert.equal(body[2], "sess-c1");
    assert.equal(body[15], "call-0001");
    assert.equal(body[100], undefined, `unexpected error: ${body[100]} ${body[101]}`);
    const result = body[5];
    assert.ok(Buffer.isBuffer(result) || result instanceof Uint8Array);
    const decoded = cborDecode(result as Uint8Array) as Record<string, unknown>;
    const echo = decoded.echo as Record<string, unknown>;
    const messages = echo.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0].content, "hi");
    sock.destroy();
  });

  it("CLOSE → server hangs up cleanly", async () => {
    const sock = await connectAndCollect(HOST, port);
    sock.write(encodeFrame(MsgType.INIT, Buffer.from(cborEncode({ 1: FRAMING_VERSION }))));
    await readFrame(sock);

    sock.write(encodeFrame(MsgType.CLOSE, Buffer.alloc(0)));
    // Wait for socket to close from server side
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), TIMEOUT_MS);
      sock.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      sock.once("end", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    assert.ok(sock.destroyed || sock.readableEnded);
  });

  it("BAD MAGIC → server closes connection", async () => {
    const sock = await connectAndCollect(HOST, port);
    sock.write(Buffer.concat([Buffer.from("XXXX"), Buffer.alloc(FRAME_HEADER_LEN - 4)]));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), TIMEOUT_MS);
      sock.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    assert.ok(sock.destroyed || sock.readableEnded);
  });

  it("REGRESSION (iter-1410): payload-bearing frames don't close the session", async () => {
    // Send INIT + PING back-to-back as one write — pre-fix the session loop
    // closed after INIT because decode would error on missing payload bytes.
    const sock = await connectAndCollect(HOST, port);
    const init = encodeFrame(MsgType.INIT, Buffer.from(cborEncode({ 1: FRAMING_VERSION })));
    const ping = encodeFrame(MsgType.PING, Buffer.from(cborEncode({ 1: Buffer.from("x") })));
    sock.write(Buffer.concat([init, ping]));
    const f1 = await readFrame(sock);
    const f2 = await readFrame(sock);
    assert.equal(f1.msgType, MsgType.ACK);
    assert.equal(f2.msgType, MsgType.PONG);
    sock.destroy();
  });
});

// ── IicpTcpClient round-trip tests against the server fixture ───────────────

describe("IicpTcpClient", () => {
  let server: IicpTcpServer;
  let port: number;

  before(async () => {
    port = await freePort();
    server = new IicpTcpServer({
      host: HOST,
      port,
      nodeId: "client-test-node",
      handler: async (task) => ({ result: { echo: task.payload } }),
      discoverLookup: async (intent) => [
        { node_id: "fake-c1", endpoint: "http://fake.example:8080", intent },
        { node_id: "fake-c2", endpoint: "http://fake.example:8080", intent },
      ],
    });
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  it("iter-1418: connect + handshake populates peerNodeId and framingVersion", async () => {
    const client = new IicpTcpClient({ host: HOST, port });
    await client.connect();
    try {
      await client.handshake();
      assert.equal(client.framingVersion, FRAMING_VERSION);
      assert.equal(client.peerNodeId, "client-test-node");
    } finally {
      await client.disconnect();
    }
  });

  it("iter-1418: ping with echo returns echoed bytes", async () => {
    const client = new IicpTcpClient({ host: HOST, port });
    await client.connect();
    try {
      await client.handshake();
      const echo = Buffer.from("ts-client-ping-2026");
      const got = await client.ping(echo);
      assert.ok(got);
      assert.deepEqual(got, echo);
    } finally {
      await client.disconnect();
    }
  });

  it("iter-1418: ping empty returns null", async () => {
    const client = new IicpTcpClient({ host: HOST, port });
    await client.connect();
    try {
      await client.handshake();
      const got = await client.ping();
      assert.equal(got, null);
    } finally {
      await client.disconnect();
    }
  });

  it("iter-1418: discover returns the lookup's nodes array", async () => {
    const client = new IicpTcpClient({ host: HOST, port });
    await client.connect();
    try {
      await client.handshake();
      const nodes = await client.discover("urn:iicp:intent:llm:chat:v1");
      assert.equal(nodes.length, 2);
      assert.equal(nodes[0].node_id, "fake-c1");
    } finally {
      await client.disconnect();
    }
  });

  it("iter-1418: call returns handler result (CBOR-encoded JSON round-trip)", async () => {
    const client = new IicpTcpClient({ host: HOST, port });
    await client.connect();
    try {
      await client.handshake();
      const result = await client.call(
        "urn:iicp:intent:llm:chat:v1",
        { messages: [{ role: "user", content: "hi from ts client" }] },
        { callId: "call-ts-1" }
      );
      const echo = result.echo as Record<string, unknown>;
      const messages = echo.messages as Array<Record<string, unknown>>;
      assert.equal(messages[0].content, "hi from ts client");
    } finally {
      await client.disconnect();
    }
  });

  it("iter-1418: call raises IicpTcpClientError on server error_code", async () => {
    const port2 = await freePort();
    const noHandlerServer = new IicpTcpServer({ host: HOST, port: port2, nodeId: "no-handler" });
    await noHandlerServer.start();
    try {
      const client = new IicpTcpClient({ host: HOST, port: port2 });
      await client.connect();
      try {
        await client.handshake();
        let threw = false;
        try {
          await client.call("urn:iicp:intent:llm:chat:v1", {});
        } catch (e) {
          threw = true;
          assert.ok(e instanceof IicpTcpClientError);
          assert.match((e as Error).message, /503/);
        }
        assert.ok(threw, "expected IicpTcpClientError on no-handler server");
      } finally {
        await client.disconnect();
      }
    } finally {
      await noHandlerServer.stop();
    }
  });

  it("iter-1418: full session — handshake + ping + discover + call + close", async () => {
    const client = new IicpTcpClient({ host: HOST, port });
    await client.connect();
    try {
      await client.handshake();
      assert.deepEqual(await client.ping(Buffer.from("x")), Buffer.from("x"));
      const nodes = await client.discover("urn:iicp:intent:llm:chat:v1");
      assert.equal(nodes.length, 2);
      const result = await client.call("urn:iicp:intent:llm:chat:v1", { k: "v" }, { callId: "c1" });
      const echo = result.echo as Record<string, unknown>;
      assert.equal(echo.k, "v");
      await client.close();
    } finally {
      await client.disconnect();
    }
  });
});

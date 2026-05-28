// ADR-041 tier-3 / #341 — relay-as-last-resort R2 (TypeScript parity)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RelayWorkerClient } from "../src/relay_worker_client.js";

describe("RelayWorkerClient", () => {
  it("constructs with correct properties", () => {
    const handler = async (t: Record<string, unknown>) => ({ result: t });
    const client = new RelayWorkerClient({
      workerId: "w-001",
      intent: "urn:iicp:intent:llm:chat:v1",
      relayHost: "relay.example.com",
      relayPort: 9485,
      handler,
      models: ["qwen2.5:0.5b"],
    });
    assert.equal((client as never as { _workerId: string })._workerId, "w-001");
    assert.equal((client as never as { _relayHost: string })._relayHost, "relay.example.com");
    assert.equal((client as never as { _relayPort: number })._relayPort, 9485);
    assert.deepEqual((client as never as { _models: string[] })._models, ["qwen2.5:0.5b"]);
  });

  it("start() returns a stop function", () => {
    const handler = async (t: Record<string, unknown>) => t;
    const client = new RelayWorkerClient({
      workerId: "w-002",
      intent: "urn:x",
      relayHost: "localhost",
      relayPort: 19485, // port not actually listened on — just testing stop()
      handler,
    });
    const stop = client.start();
    assert.equal(typeof stop, "function");
    stop(); // stop immediately
  });

  it("_handleCall invokes handler and writes RESPONSE frame", async () => {
    const cbor = await import("cbor-x");
    const written: Buffer[] = [];
    const fakeSocket = { write: (b: Buffer) => written.push(b), destroyed: false } as never;

    const handler = async (_t: Record<string, unknown>) => ({ answer: 99 });
    const client = new RelayWorkerClient({
      workerId: "w-003",
      intent: "urn:x",
      relayHost: "h",
      relayPort: 9,
      handler,
    });

    const payload = cbor.encode({ 15: "call-xyz", 5: Buffer.from(JSON.stringify({ q: "?" })) });
    await (client as never as { _handleCall: (p: Buffer, s: unknown) => Promise<void> })._handleCall(payload, fakeSocket);

    assert.equal(written.length, 1);
    const frame = written[0];
    assert.equal(frame[5], 0x06, "msg type should be RESPONSE (0x06)");
    const plen = frame.readUInt32BE(8);
    const resp = cbor.decode(frame.slice(12, 12 + plen)) as Record<number, unknown>;
    assert.equal(resp[15], "call-xyz");
    const result = JSON.parse(Buffer.isBuffer(resp[5]) ? resp[5].toString() : String(resp[5])) as { answer: number };
    assert.equal(result.answer, 99);
  });
});

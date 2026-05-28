// ADR-016: IICP client SDK conformance — ADR-041 tier-3 / #341 relay R1 (TypeScript parity)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RelaySessionRegistry, RelayWorkerSession } from "../src/relay_session.js";

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

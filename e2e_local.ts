// Local E2E: TS SDK serving node -> real Ollama -> client round-trip.
// Exercises Block B (backends), C/D (health capacity), E (idempotency), F (mesh relay).
import { IicpNode, getBackendHandler } from "./src/index.js";

const OLLAMA = "http://localhost:11434/v1";
const MODEL = "qwen2.5:0.5b";
const INTENT = "urn:iicp:intent:llm:chat:v1";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${!cond && detail ? ` — ${detail}` : ""}`);
}

async function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: resp.status, body: json as Record<string, unknown> };
}

async function get(port: number, path: string) {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
}

async function main() {
  console.log("=".repeat(60));
  console.log("E2E: TypeScript SDK (v0.6.0) — local, real Ollama backend");
  console.log("=".repeat(60));

  const handler = getBackendHandler("openai_compat", { baseUrl: OLLAMA, model: MODEL });
  const stops: Array<() => void> = [];

  // [1] real round-trip
  console.log("\n[1] Serving node + real chat round-trip (Block B)");
  const nodeA = new IicpNode({ nodeId: "e2e-ts-1", endpoint: "http://127.0.0.1:8501", intent: INTENT, model: MODEL });
  stops.push(nodeA.serve(handler, { host: "127.0.0.1", port: 8501 }));
  await new Promise((r) => setTimeout(r, 400));
  const r1 = await post(8501, "/v1/task", {
    task_id: "e2e-1",
    intent: INTENT,
    payload: { messages: [{ role: "user", content: "Reply with exactly: PONG" }] },
  });
  check("task returns 200", r1.status === 200, `status=${r1.status}`);
  let content = "";
  try {
    content = (r1.body as any).result.choices[0].message.content;
  } catch {
    /* */
  }
  check("real Ollama completion returned", !!content, JSON.stringify(r1.body).slice(0, 200));
  console.log(`      model said: ${JSON.stringify(content).slice(0, 80)}`);

  // [2] health capacity fields
  console.log("\n[2] Health endpoint (Blocks C/D)");
  const h = await get(8501, "/iicp/health");
  check("health 200", h.status === 200);
  check("health has effective_max_concurrent", "effective_max_concurrent" in h.body, JSON.stringify(h.body));

  // [3] idempotency opt-in
  console.log("\n[3] Idempotency opt-in (Block E, IICP-E010)");
  const nodeI = new IicpNode({ nodeId: "e2e-ts-idem", endpoint: "http://127.0.0.1:8502", intent: INTENT, model: MODEL, enableIdempotency: true });
  stops.push(nodeI.serve(handler, { host: "127.0.0.1", port: 8502 }));
  await new Promise((r) => setTimeout(r, 300));
  const i1 = await post(8502, "/v1/task", { task_id: "dup-1", intent: INTENT, payload: { messages: [{ role: "user", content: "hi" }] } });
  const i2 = await post(8502, "/v1/task", { task_id: "dup-1", intent: INTENT, payload: { messages: [{ role: "user", content: "hi" }] } });
  check("first task 200", i1.status === 200, `s1=${i1.status}`);
  check("duplicate task_id -> 409", i2.status === 409, `s2=${i2.status}`);
  check("duplicate code IICP-E010", (i2.body as any)?.error?.code === "IICP-E010", JSON.stringify(i2.body));

  // [4] mesh relay round-trip
  console.log("\n[4] Mesh relay round-trip (Block F, ADR-022)");
  const nodeB = new IicpNode({ nodeId: "e2e-ts-B", endpoint: "http://127.0.0.1:8504", intent: INTENT, model: MODEL });
  stops.push(nodeB.serve(handler, { host: "127.0.0.1", port: 8504 }));
  const relayNode = new IicpNode({ nodeId: "e2e-ts-A", endpoint: "http://127.0.0.1:8503", intent: INTENT, model: MODEL, enableMesh: true, relayCapable: true });
  stops.push(relayNode.serve(handler, { host: "127.0.0.1", port: 8503 }));
  await new Promise((r) => setTimeout(r, 400));
  // inject B as known peer (no directory locally)
  (relayNode as any)._peerManager.mergePeers([{ node_id: "e2e-ts-B", endpoint: "http://127.0.0.1:8504" }]);
  const pe = await post(8503, "/v1/peers", { known_peers: [] });
  check("/v1/peers lists B", pe.status === 200 && (pe.body as any).peers.some((p: any) => p.node_id === "e2e-ts-B"), JSON.stringify(pe.body).slice(0, 200));
  const rel = await post(8503, "/v1/relay", {
    target_node_id: "e2e-ts-B",
    task: { task_id: "relay-1", intent: INTENT, payload: { messages: [{ role: "user", content: "Reply with exactly: RELAYOK" }] } },
  });
  check("relay returns 200", rel.status === 200, `sr=${rel.status}`);
  let rc = "";
  try {
    rc = (rel.body as any).result.choices[0].message.content;
  } catch {
    /* */
  }
  check("relay produced a real completion from B", !!rc, JSON.stringify(rel.body).slice(0, 200));
  const ru = await post(8503, "/v1/relay", { target_node_id: "nope", task: { task_id: "x", intent: INTENT, payload: {} } });
  check("relay unknown target -> 404 IICP-E030", ru.status === 404 && (ru.body as any)?.error?.code === "IICP-E030", `${ru.status} ${JSON.stringify(ru.body)}`);

  for (const s of stops) s();
  console.log("\n" + "=".repeat(60));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log("=".repeat(60));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

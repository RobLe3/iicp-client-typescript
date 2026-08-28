import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LifecycleConflict, LifecycleResumeUnavailable, LifecycleStore } from "../src/service_lifecycle.js";
const here=fileURLToPath(new URL(".",import.meta.url));
test("consumes the shared lifecycle transition fixture",()=>{const fixture=JSON.parse(readFileSync(join(here,"../parity/service-lifecycle-v1.json"),"utf8"));assert.equal(fixture.profile,"urn:iicp:profile:service-lifecycle:v1");for(const vector of fixture.vectors.filter((item:any)=>item.kind==="valid"||item.kind==="alias")){const store=new LifecycleStore();store.submit(vector.id,"idem-"+vector.id,"sha256:request");for(const [state] of vector.events.slice(1))store.transition(vector.id,state);const expected=vector.expected==="accept_as_expired"?"expired":vector.events.at(-1)[0];assert.equal(store.status(vector.id).state,expected,vector.id);}const invalid=fixture.vectors.find((item:any)=>item.id==="LIFECYCLE-03");const store=new LifecycleStore();store.submit("invalid","idem-invalid","digest");store.transition("invalid",invalid.events[1][0]);assert.throws(()=>store.transition("invalid",invalid.events[2][0]),LifecycleConflict);});
test("restart snapshot, bounded replay and late cancellation are deterministic",()=>{let now=1000;const original=new LifecycleStore(3,1000,()=>now);original.submit("task","idem","digest");original.transition("task","running");original.transition("task","streaming",{chunk:1});original.transition("task","streaming",{chunk:2});original.transition("task","streaming",{chunk:3});const restored=new LifecycleStore(3,1000,()=>now);restored.restore(original.snapshot());assert.throws(()=>restored.eventsAfter("task",0),LifecycleResumeUnavailable);assert.equal(restored.eventsAfter("task",1,1).length,1);assert.equal(restored.cancel("task").state,"cancelled");assert.equal(restored.cancel("task").state,"cancelled");now+=1001;assert.throws(()=>restored.status("task"));});

test("process crash snapshot restores the last committed state", () => {
  const root = mkdtempSync(join(tmpdir(), "iicp-lifecycle-crash-"));
  const snapshot = join(root, "snapshot.json");
  const worker = [
    'import { writeFileSync } from "node:fs";',
    // The package is CommonJS, so tsx exposes the module as the default export
    // when this standalone ESM crash worker imports the TypeScript source.
    'import lifecycle from "./src/service_lifecycle.ts";',
    'const { LifecycleStore } = lifecycle;',
    'const store = new LifecycleStore();',
    'store.submit("crash-task", "crash-idem", "sha256:request");',
    'store.transition("crash-task", "running");',
    'writeFileSync(process.env.IICP_TEST_SNAPSHOT, JSON.stringify(store.snapshot()));',
    'process.exit(17);',
  ].join("\n");
  try {
    const crashed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", worker], {
      cwd: join(here, ".."),
      env: { ...process.env, IICP_TEST_SNAPSHOT: snapshot },
    });
    assert.equal(crashed.status, 17);
    const restored = new LifecycleStore();
    restored.restore(JSON.parse(readFileSync(snapshot, "utf8")));
    assert.equal(restored.status("crash-task").state, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

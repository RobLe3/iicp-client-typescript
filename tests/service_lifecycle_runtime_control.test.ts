import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BackendCancellationRegistry, BoundedObserverBuffer, LifecycleConflict, ObserverLagged } from "../src/service_lifecycle.js";

const here=join(fileURLToPath(new URL(".",import.meta.url)),"..");
const fixture=JSON.parse(readFileSync(join(here,"parity/service-lifecycle-runtime-control-v1.json"),"utf8"));

test("consumes shared runtime cancellation vectors",()=>{
  for(const vector of fixture.cancellation){
    const registry=new BackendCancellationRegistry(); let calls=0;
    if(vector.handler==="registered") registry.register("task",()=>{calls+=1;return true;});
    assert.equal(registry.request("task",vector.state),vector.expected,vector.id);
    if(vector.expected==="cancel_signalled") {
      assert.equal(registry.request("task",vector.state),"cancel_signalled");
      assert.equal(calls,1);
    }
  }
  for(const vector of fixture.cancellation_evidence.vectors){
    const registry=new BackendCancellationRegistry();
    registry.register(vector.id,()=>true);
    assert.equal(registry.request(vector.id,"running"),"cancel_signalled");
    registry.report(vector.id,vector.reported);
    assert.deepEqual(registry.complete(vector.id),{
      task_id:vector.id,
      outcome:vector.expected,
      cleanup_complete:vector.cleanup_complete,
    });
  }
});

test("bounded observation reports lag, terminal closure and slot release",()=>{
  const buffer=new BoundedObserverBuffer(fixture.observation.capacity,1);
  buffer.subscribe("first");
  assert.throws(()=>buffer.subscribe("second"),LifecycleConflict);
  buffer.disconnect("first");
  buffer.subscribe("second");
  assert.equal(buffer.observerCount,1);
  for(const sequence of fixture.observation.published_sequences){
    buffer.publish({task_id:"task",sequence,state:"streaming",is_final:false,observed_at_ms:sequence});
  }
  for(const vector of fixture.observation.vectors){
    if(vector.expected_error){
      assert.throws(()=>buffer.poll(vector.after_sequence),(error:unknown)=>
        error instanceof ObserverLagged&&error.earliestAvailable===vector.earliest_available&&error.latestSequence===vector.latest_sequence
      );
    } else assert.deepEqual(buffer.poll(vector.after_sequence).map(event=>event.sequence),vector.expected_sequences,vector.id);
  }
  buffer.publish({task_id:"task",sequence:4,state:"completed",is_final:true,observed_at_ms:4});
  assert.equal(buffer.closed,true);
});

test("runtime buffers reject non-increasing sequences and unsupported cancellation",()=>{
  const registry=new BackendCancellationRegistry();
  registry.register("unsupported",()=>false);
  assert.equal(registry.request("unsupported","running"),"cancel_unsupported");
  const buffer=new BoundedObserverBuffer(2);
  buffer.publish({task_id:"task",sequence:1,state:"running",is_final:false,observed_at_ms:1});
  assert.throws(()=>buffer.publish({task_id:"task",sequence:1,state:"running",is_final:false,observed_at_ms:2}),LifecycleConflict);
});

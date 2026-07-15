/** Opt-in transport-neutral implementation of the pre-normative lifecycle profile. */
export const SERVICE_LIFECYCLE_PROFILE = "urn:iicp:profile:service-lifecycle:v1";
export const TERMINAL_LIFECYCLE_STATES = new Set(["rejected", "completed", "failed", "cancelled", "expired"]);
const transitions: Record<string, Set<string>> = {
  submitted: new Set(["accepted", "rejected", "expired"]),
  accepted: new Set(["queued", "running", "completed", "cancelled", "failed", "expired"]),
  queued: new Set(["running", "waiting", "cancelled", "failed", "expired"]),
  running: new Set(["waiting", "streaming", "completed", "cancelled", "failed", "expired"]),
  waiting: new Set(["queued", "running", "cancelled", "failed", "expired"]),
  streaming: new Set(["streaming", "waiting", "completed", "cancelled", "failed", "expired"]),
};
export interface LifecycleEvent { task_id:string; sequence:number; state:string; is_final:boolean; observed_at_ms:number; detail?:Record<string,unknown>; }
export interface LifecycleRecord { task_id:string; idempotency_key:string; request_digest:string; state:string; events:LifecycleEvent[]; updated_at_ms:number; }
export interface LifecycleSnapshot { profile:typeof SERVICE_LIFECYCLE_PROFILE; records:LifecycleRecord[]; }
export class LifecycleConflict extends Error {}
export class UnknownLifecycleTask extends Error {}
export class LifecycleResumeUnavailable extends Error { constructor(public readonly record:LifecycleRecord) { super("resume_unavailable"); } }

export class LifecycleStore {
  private readonly records = new Map<string,LifecycleRecord>();
  constructor(private readonly maxEvents=256, private readonly terminalStatusTtlMs=3_600_000, private readonly clock:()=>number=Date.now) {}
  submit(taskId:string,idempotencyKey:string,requestDigest:string):{record:LifecycleRecord;created:boolean} {
    const existing=this.records.get(taskId);
    if(existing){ if(existing.idempotency_key!==idempotencyKey||existing.request_digest!==requestDigest) throw new LifecycleConflict("task or idempotency identifier reused for different content"); return {record:structuredClone(existing),created:false}; }
    if([...this.records.values()].some(record=>record.idempotency_key===idempotencyKey)) throw new LifecycleConflict("idempotency identifier reused with a different task identifier");
    const now=this.clock(); const event:LifecycleEvent={task_id:taskId,sequence:0,state:"accepted",is_final:false,observed_at_ms:now};
    const record:LifecycleRecord={task_id:taskId,idempotency_key:idempotencyKey,request_digest:requestDigest,state:"accepted",events:[event],updated_at_ms:now}; this.records.set(taskId,record); return {record:structuredClone(record),created:true};
  }
  status(taskId:string):LifecycleRecord { const record=this.records.get(taskId); if(!record||(TERMINAL_LIFECYCLE_STATES.has(record.state)&&this.clock()-record.updated_at_ms>this.terminalStatusTtlMs)){this.records.delete(taskId);throw new UnknownLifecycleTask(taskId);} return structuredClone(record); }
  transition(taskId:string,requestedState:string,detail:Record<string,unknown>={}):LifecycleEvent { const record=this.records.get(taskId); if(!record) throw new UnknownLifecycleTask(taskId); const state=requestedState==="timed_out"?"expired":requestedState; if(!transitions[record.state]?.has(state)) throw new LifecycleConflict(`illegal transition ${record.state} -> ${state}`); const event:LifecycleEvent={task_id:taskId,sequence:record.events.at(-1)!.sequence+1,state,is_final:TERMINAL_LIFECYCLE_STATES.has(state),observed_at_ms:this.clock(),detail}; record.events.push(event); const max=Math.max(2,this.maxEvents); if(record.events.length>max) record.events.splice(0,record.events.length-max); record.state=state; record.updated_at_ms=event.observed_at_ms; return structuredClone(event); }
  cancel(taskId:string):LifecycleRecord { const current=this.status(taskId); if(!TERMINAL_LIFECYCLE_STATES.has(current.state)) this.transition(taskId,"cancelled",{outcome:"cancelled"}); return this.status(taskId); }
  eventsAfter(taskId:string,afterSequence:number,limit=this.maxEvents):LifecycleEvent[]{const record=this.status(taskId);if(afterSequence>=0&&afterSequence+1<record.events[0].sequence)throw new LifecycleResumeUnavailable(record);return record.events.filter(event=>event.sequence>afterSequence).slice(0,Math.max(1,limit));}
  snapshot():LifecycleSnapshot{return {profile:SERVICE_LIFECYCLE_PROFILE,records:[...this.records.values()].map(record=>structuredClone(record))};}
  restore(snapshot:LifecycleSnapshot):void{if(snapshot.profile!==SERVICE_LIFECYCLE_PROFILE)throw new LifecycleConflict("unsupported lifecycle snapshot profile");for(const record of snapshot.records){if(!record.events.length||record.events.some((event,index)=>event.sequence!==record.events[0].sequence+index))throw new LifecycleConflict("invalid lifecycle snapshot sequence");this.records.set(record.task_id,structuredClone(record));}}
}

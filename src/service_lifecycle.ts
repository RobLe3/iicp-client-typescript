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
export class ObserverLagged extends Error {
  constructor(public readonly earliestAvailable:number, public readonly latestSequence:number) {
    super("observer_lagged");
  }
}

export type BackendCancellationOutcome = "cancel_signalled" | "cancel_unsupported" | "already_terminal";
export type BackendCancellationHandler = () => boolean | void;

/** Opt-in bridge from lifecycle cancellation to an active backend handle. */
export class BackendCancellationRegistry {
  private readonly handlers = new Map<string,BackendCancellationHandler>();
  private readonly signalled = new Set<string>();

  register(taskId:string,handler:BackendCancellationHandler):void {
    this.handlers.set(taskId,handler);
    this.signalled.delete(taskId);
  }

  complete(taskId:string):void {
    this.handlers.delete(taskId);
    this.signalled.delete(taskId);
  }

  request(taskId:string,state:string):BackendCancellationOutcome {
    if(TERMINAL_LIFECYCLE_STATES.has(state)) {
      this.complete(taskId);
      return "already_terminal";
    }
    if(this.signalled.has(taskId)) return "cancel_signalled";
    const handler=this.handlers.get(taskId);
    if(!handler) return "cancel_unsupported";
    if(handler()===false) return "cancel_unsupported";
    this.signalled.add(taskId);
    return "cancel_signalled";
  }
}

/** Content-free ordered event buffer with explicit slow-consumer failure. */
export class BoundedObserverBuffer {
  private readonly events:LifecycleEvent[]=[];
  private readonly observers=new Set<string>();
  private terminal=false;

  constructor(private readonly capacity:number,private readonly maxObservers=32) {
    this.capacity=Math.max(1,capacity);
    this.maxObservers=Math.max(1,maxObservers);
  }

  subscribe(observerId:string):void {
    if(!this.observers.has(observerId)&&this.observers.size>=this.maxObservers) {
      throw new LifecycleConflict("observer capacity exhausted");
    }
    this.observers.add(observerId);
  }

  disconnect(observerId:string):void { this.observers.delete(observerId); }

  publish(event:LifecycleEvent):void {
    const last=this.events.at(-1);
    if(last&&event.sequence<=last.sequence) throw new LifecycleConflict("observer sequence must increase");
    this.events.push(structuredClone(event));
    if(this.events.length>this.capacity) this.events.splice(0,this.events.length-this.capacity);
    this.terminal=event.is_final;
  }

  poll(afterSequence:number):LifecycleEvent[] {
    const first=this.events[0]; const last=this.events.at(-1);
    if(first&&last&&afterSequence+1<first.sequence) throw new ObserverLagged(first.sequence,last.sequence);
    return this.events.filter(event=>event.sequence>afterSequence).map(event=>structuredClone(event));
  }

  get closed():boolean { return this.terminal; }
  get observerCount():number { return this.observers.size; }
}

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

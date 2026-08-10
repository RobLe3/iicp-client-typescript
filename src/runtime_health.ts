import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SubsystemState = "healthy"|"degraded"|"recovering"|"unavailable"|"not_applicable"|"unknown";
export interface ClassificationInput { lifecycle:string;runtime_age_ms:number;runtime_stale_after_ms:number;supervisor_required:boolean;supervisor_age_ms:number;supervisor_stale_after_ms:number;provider:SubsystemState;capacity_available:boolean;routing:SubsystemState;directory:SubsystemState;dns:SubsystemState;internet:SubsystemState;tunnel:SubsystemState }
export interface ClassificationOutput { liveness:"starting"|"live"|"not_live"|"indeterminate";readiness:"ready"|"degraded"|"not_ready";reason_codes:string[] }
export const RUNTIME_STALE_AFTER_MS=30_000;
export const SUPERVISOR_STALE_AFTER_MS=120_000;
export function classifyRuntimeHealth(i:ClassificationInput):ClassificationOutput {
 if(i.lifecycle==="starting")return{liveness:"starting",readiness:"not_ready",reason_codes:["STARTING"]};
 if(i.runtime_age_ms>i.runtime_stale_after_ms)return{liveness:"not_live",readiness:"not_ready",reason_codes:["RUNTIME_PROGRESS_STALE"]};
 if(i.supervisor_required&&i.supervisor_age_ms>i.supervisor_stale_after_ms)return{liveness:"not_live",readiness:"not_ready",reason_codes:["SUPERVISOR_PROGRESS_STALE"]};
 if(i.lifecycle==="stopping")return{liveness:"live",readiness:"not_ready",reason_codes:["STOPPING"]};
 const reasons:string[]=[];
 if(i.provider==="unavailable")reasons.push("PROVIDER_UNAVAILABLE");if(!i.capacity_available)reasons.push("NO_CAPACITY");if(i.routing==="unavailable")reasons.push("ROUTING_UNAVAILABLE");if(i.tunnel==="recovering")reasons.push("TUNNEL_RECOVERING");if(i.directory==="unavailable")reasons.push("DIRECTORY_UNAVAILABLE");if(i.dns==="unavailable")reasons.push("DNS_UNAVAILABLE");if(i.internet==="unavailable")reasons.push("INTERNET_UNAVAILABLE");
 const notReady=reasons.some(x=>["PROVIDER_UNAVAILABLE","NO_CAPACITY","ROUTING_UNAVAILABLE"].includes(x));
 return{liveness:"live",readiness:notReady?"not_ready":reasons.length?"degraded":"ready",reason_codes:reasons};
}
export class RuntimeHealth {
 readonly processEpoch=randomUUID(); private lifecycle="starting";private runtimeSequence=0;private supervisorSequence=0;private snapshotSequence=0;private runtimeAt=performance.now();private supervisorAt=performance.now();private supervisorRequired=false;private capacityAvailable=false;
 private subsystems:Record<string,SubsystemState>={provider:"unknown",routing:"unknown",tunnel:"unknown"};private external:Record<string,SubsystemState>={directory:"unknown",dns:"unknown",internet:"unknown"};
 markRunning(){this.lifecycle="running";this.capacityAvailable=true;this.subsystems.provider="healthy";this.subsystems.routing="healthy"} markStopping(){this.lifecycle="stopping"} advanceRuntime(){this.runtimeSequence++;this.runtimeAt=performance.now()} advanceSupervisor(){this.supervisorSequence++;this.supervisorAt=performance.now()} setSupervisorRequired(v:boolean){this.supervisorRequired=v} setExternal(n:string,v:SubsystemState){this.external[n]=v}
 snapshot(){const now=performance.now(),ra=Math.max(0,Math.trunc(now-this.runtimeAt)),sa=Math.max(0,Math.trunc(now-this.supervisorAt));this.snapshotSequence++;const result=classifyRuntimeHealth({lifecycle:this.lifecycle,runtime_age_ms:ra,runtime_stale_after_ms:RUNTIME_STALE_AFTER_MS,supervisor_required:this.supervisorRequired,supervisor_age_ms:sa,supervisor_stale_after_ms:SUPERVISOR_STALE_AFTER_MS,provider:this.subsystems.provider??"unknown",capacity_available:this.capacityAvailable,routing:this.subsystems.routing??"unknown",directory:this.external.directory??"unknown",dns:this.external.dns??"unknown",internet:this.external.internet??"unknown",tunnel:this.subsystems.tunnel??"unknown"});return{health_schema_version:1,process_epoch:this.processEpoch,pid:process.pid,sequence:this.snapshotSequence,emitted_at:new Date().toISOString(),lifecycle:this.lifecycle,...result,progress:{runtime:{sequence:this.runtimeSequence,age_ms:ra,stale_after_ms:RUNTIME_STALE_AFTER_MS,required:true},supervisor:{sequence:this.supervisorSequence,age_ms:sa,stale_after_ms:SUPERVISOR_STALE_AFTER_MS,required:this.supervisorRequired}},subsystems:{...this.subsystems},external_connectivity:{...this.external}}}
}
export function runtimeHealthPath(node:string){if(!node||!/^[A-Za-z0-9_.-]+$/.test(node))throw new Error("invalid node name");return path.join(os.homedir(),".iicp","run",node,"health-v1.json")}
export function writeRuntimeHealthSnapshot(file:string,snapshot:unknown){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});if(process.platform!=="win32")fs.chmodSync(path.dirname(file),0o700);const tmp=`${file}.tmp-${process.pid}`;fs.writeFileSync(tmp,`${JSON.stringify(snapshot,null,2)}\n`,{mode:0o600});const fd=fs.openSync(tmp,"r");fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(tmp,file)}

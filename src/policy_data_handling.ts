/** Opt-in evaluator for the pre-normative policy/data-handling profile. */
export interface PolicyDataDecision { eligible: boolean; reason: string }
export type PolicyDataRecord = Record<string, unknown>;
const known = new Set(["version","role","data_class","remote_routing","allowed_regions","retention","training_use","subprocessors","approval","tool_risk","requires_encryption","requires_receipt","requires_human_review","critical_requirements"]);
const approval:Record<string,number>={none:0,user:1,operator:2,human_review:3};
const toolRisk:Record<string,number>={none:0,read_only:1,write:2,privileged:3};
const reject=(reason:string):PolicyDataDecision=>({eligible:false,reason});
const obj=(value:unknown):PolicyDataRecord=>(value && typeof value === "object" ? value as PolicyDataRecord : {});
const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((item):item is string=>typeof item==="string"):[];

export function evaluatePolicyDataHandling(requirement:PolicyDataRecord,declaration:PolicyDataRecord,context:PolicyDataRecord={}):PolicyDataDecision {
  if(strings(requirement.critical_requirements).some(field=>!known.has(field))) return reject("unsupported_policy_requirement");
  if(requirement.remote_routing==="local_only") return reject("remote_routing_forbidden");
  if(!strings(declaration.accepted_data_classes).includes(String(requirement.data_class))) return reject("data_class_not_accepted");
  if(requirement.remote_routing==="requires_approval" && context.approval_granted!==true) return reject("approval_required");
  const regions=strings(requirement.allowed_regions);
  if(regions.length && !regions.includes(String(declaration.jurisdiction))) return reject("region_not_allowed");
  const rr=obj(requirement.retention), dr=obj(declaration.retention);
  if(rr.task_payload==="none" && dr.task_payload!=="none") return reject("retention_requirement_unsatisfied");
  if(rr.task_payload==="transient") {
    if(dr.task_payload!=="none" && dr.task_payload!=="transient") return reject("retention_requirement_unsatisfied");
    const requiredMax=typeof rr.max_seconds==="number"?rr.max_seconds:undefined;
    const declaredMax=dr.task_payload==="none"?0:(typeof dr.max_seconds==="number"?dr.max_seconds:undefined);
    if(requiredMax!==undefined && (declaredMax===undefined || declaredMax>requiredMax)) return reject("retention_requirement_unsatisfied");
  }
  if(requirement.training_use==="none" && declaration.training_use!=="none") return reject("training_use_requirement_unsatisfied");
  if(requirement.subprocessors==="none" && declaration.subprocessors!=="none") return reject("subprocessor_requirement_unsatisfied");
  if(typeof requirement.approval==="string" && (approval[String(declaration.approval??"none")]??-1) < (approval[requirement.approval]??99)) return reject("approval_requirement_unsatisfied");
  if(typeof requirement.tool_risk==="string" && (toolRisk[String(declaration.tool_risk??"privileged")]??99) > (toolRisk[requirement.tool_risk]??-1)) return reject("tool_risk_requirement_unsatisfied");
  if(requirement.requires_encryption===true && context.encryption_ready!==true) return reject("encryption_requirement_unsatisfied");
  if(requirement.requires_receipt===true && context.receipt_supported!==true) return reject("receipt_requirement_unsatisfied");
  if(requirement.requires_human_review===true && declaration.requires_human_review!==true) return reject("human_review_requirement_unsatisfied");
  return {eligible:true,reason:"compatible"};
}

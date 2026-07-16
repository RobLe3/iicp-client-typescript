import { createPublicKey, verify as edVerify } from "node:crypto";
const DOMAIN = "iicp:dispatch-route-ticket:v1\n";
const AUDIENCE = "iicp.directory.dispatch";
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
export interface DispatchRouteTicketClaims { v:number; typ:"dispatch-route-ticket"; iss:string; aud:string; jti:string; node_id:string; intent:string; iat:number; exp:number; policy_manifest_sha256?:string; }
function key(hex:string) { const raw=Buffer.from(hex,"hex"); if(raw.length!==32) throw new Error("bad key"); return createPublicKey({key:Buffer.concat([SPKI,raw]),format:"der",type:"spki"}); }
function pad(value:string) { const b=value.replace(/-/g,"+").replace(/_/g,"/"); return b+"=".repeat((4-b.length%4)%4); }
export function verifyDispatchRouteTicket(token:string, publicKeyHex:string, issuer:string, nodeId:string, intent:string, nowSec=Math.floor(Date.now()/1000)): DispatchRouteTicketClaims | null {
 const p=token.split("."); if(p.length!==2 || p[1].length!==128) return null;
 try { if(!edVerify(null,Buffer.from(DOMAIN+p[0]),key(publicKeyHex),Buffer.from(p[1],"hex"))) return null; const c=JSON.parse(Buffer.from(pad(p[0]),"base64").toString()) as DispatchRouteTicketClaims;
  if(c.v!==1||c.typ!=="dispatch-route-ticket"||c.iss!==issuer||c.aud!==AUDIENCE||c.node_id!==nodeId||c.intent!==intent||c.exp<=nowSec||!/^[0-9a-f]{24}$/.test(c.jti)) return null;
  if(c.policy_manifest_sha256!==undefined && !/^[0-9a-f]{64}$/.test(c.policy_manifest_sha256)) return null;
  return c;
 } catch { return null; }
}

export function policyManifestBindingMatches(claims: DispatchRouteTicketClaims, route: unknown): boolean {
  if (claims.policy_manifest_sha256 === undefined) return true;
  if (!route || typeof route !== "object") return false;
  const manifest = (route as Record<string, unknown>).node_policy_manifest;
  if (!manifest || typeof manifest !== "object") return false;
  const verification = (manifest as Record<string, unknown>).verification;
  if (!verification || typeof verification !== "object") return false;
  return (verification as Record<string, unknown>).canonical_sha256 === claims.policy_manifest_sha256;
}

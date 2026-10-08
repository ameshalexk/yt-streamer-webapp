// Remote authorization primitives, NOT a network endpoint. Never mount the dev relay publicly.
// Only a gateway that has independently verified its TLS/Access ingress may use this module.
import { createPublicKey, verify, randomUUID } from "node:crypto";
const OPS = new Set(["get_player_state","search_media","play_media","pause","resume","next","seek","set_volume","request_fullscreen"]);
const reject = () => { throw new Error("unauthorized"); };
const nonempty = value => typeof value === "string" && value.length > 0;
const decode = encoded => {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 12000) reject();
  try { return JSON.parse(Buffer.from(encoded,"base64url").toString("utf8")); } catch { reject(); }
};
const match = (a,b) => typeof a === "string" && a.length > 0 && a === b;

/** Fail-closed offline verifier for provider-issued RS256 JWTs.
 * Caller must retrieve JWKS from a trusted, pinned issuer via HTTPS and enforce ingress.
 * Never accept a token-supplied JWK/JWKS URL. No bearer token is stored.
 */
export function verifyAccessJwt(token,{jwks,issuer,audience,nowSeconds=Math.floor(Date.now()/1000)}={}) {
  if (typeof token !== "string" || token.length > 16000 || token.split(".").length !== 3
      || !nonempty(issuer) || !nonempty(audience)) reject();
  const [head,claims,sig] = token.split(".");
  const header=decode(head), body=decode(claims);
  if (!header || !body || header.alg !== "RS256" || typeof header.kid !== "string"
      || header.kid.length > 180 || !Array.isArray(jwks?.keys)) reject();
  const jwk=jwks.keys.find(k=>k.kid===header.kid && k.kty==="RSA" && k.use!=="enc"
    && (k.alg==null || k.alg==="RS256") && typeof k.n==="string" && typeof k.e==="string");
  if (!jwk) reject();
  let valid=false;
  try { valid=verify("RSA-SHA256",Buffer.from(head+"."+claims),
    createPublicKey({key:{kty:"RSA",n:jwk.n,e:jwk.e},format:"jwk"}),Buffer.from(sig,"base64url")); }
  catch { reject(); }
  if (!valid || body.iss!==issuer || !(Array.isArray(body.aud)?body.aud.includes(audience):body.aud===audience)
    || !nonempty(body.sub) || body.sub.length>300
    || !Number.isSafeInteger(body.exp) || nowSeconds>=body.exp
    || !Number.isSafeInteger(body.iat) || body.iat>nowSeconds+30 || body.exp-body.iat>86400
    || (body.nbf!==undefined && (!Number.isSafeInteger(body.nbf) || nowSeconds<body.nbf))) reject();
  return Object.freeze({subject:body.sub,issuer:body.iss,audience});
}

/** Internal approval state. A trusted paired-browser *gesture* must be checked BEFORE calling approve().
 * There is deliberately no HTTP route or client-supplied `approved` switch here.
 */
export class BrowserApprovalRegistry {
  #approvals=new Map(); #pending=new Map(); #now; #maxTtl;
  constructor({now=Date.now,maxTtlMs=300000}={}) {
    if(typeof now!=="function" || !Number.isInteger(maxTtlMs) || maxTtlMs<1000 || maxTtlMs>300000) reject();
    this.#now=now;this.#maxTtl=maxTtlMs;
  }
  /** A remote identity can REQUEST a grant, but only its paired browser connection can approve it. */
  request({identity,deviceId,connectionId,actions,ttlMs=120000}) {
    if(!identity || !nonempty(identity.subject) || !nonempty(identity.issuer)
      || !nonempty(deviceId) || !nonempty(connectionId) || !Array.isArray(actions)
      || actions.length<1 || actions.length>OPS.size || new Set(actions).size!==actions.length
      || actions.some(a=>!OPS.has(a)) || !Number.isInteger(ttlMs)
      || ttlMs<1000 || ttlMs>this.#maxTtl) reject();
    for(const [key,item] of this.#pending) if(this.#now()>=item.deadline) this.#pending.delete(key);
    if(this.#pending.size>=32) reject();
    const requestId=randomUUID();
    this.#pending.set(requestId,{identity:{subject:identity.subject,issuer:identity.issuer},
      deviceId,connectionId,actions,ttlMs,deadline:this.#now()+60000,status:"pending"});
    return {request_id:requestId,status:"pending_browser_approval",expires_at:this.#now()+60000};
  }
  approvePendingFromBrowser({requestId,deviceId,connectionId}) {
    const p=this.#pending.get(requestId);
    if(!p || p.status!=="pending" || this.#now()>=p.deadline
       || p.deviceId!==deviceId || p.connectionId!==connectionId) return false;
    const grant=this.approve({identity:p.identity,deviceId,connectionId,actions:p.actions,ttlMs:p.ttlMs});
    p.status="approved";p.approvalId=grant.approval_id;
    return true;
  }
  claim({identity,requestId}) {
    const p=this.#pending.get(requestId);
    if(!p || this.#now()>=p.deadline || !identity
       || !match(identity.subject,p.identity.subject) || !match(identity.issuer,p.identity.issuer)) return null;
    if(p.status!=="approved") return {status:"pending_browser_approval"};
    this.#pending.delete(requestId);
    return {status:"approved",approval_id:p.approvalId,device_id:p.deviceId};
  }
  approve({identity,deviceId,connectionId,actions,ttlMs=120000}) {
    if(!identity || !nonempty(identity.subject) || !nonempty(identity.issuer)
      || !nonempty(deviceId) || deviceId.length>80 || !nonempty(connectionId)
      || !Array.isArray(actions) || actions.length<1 || actions.some(a=>!OPS.has(a))
      || !Number.isInteger(ttlMs) || ttlMs<1000 || ttlMs>this.#maxTtl) reject();
    const approvalId=randomUUID();
    this.#approvals.set(approvalId,{subject:identity.subject,issuer:identity.issuer,
      deviceId,connectionId,actions:new Set(actions),expires:this.#now()+ttlMs});
    return {approval_id:approvalId,expires_at:this.#now()+ttlMs};
  }
  authorize({identity,approvalId,deviceId,connectionId,action}) {
    const a=this.#approvals.get(approvalId);
    if(!a)return false;
    if(this.#now()>=a.expires){this.#approvals.delete(approvalId);return false;}
    return Boolean(identity && match(identity.subject,a.subject) && match(identity.issuer,a.issuer)
      && deviceId===a.deviceId && connectionId===a.connectionId && a.actions.has(action));
  }
  revoke(approvalId){return this.#approvals.delete(approvalId);}
  revokeOwned(identity,approvalId) {
    const a=this.#approvals.get(approvalId);
    if(!a || !identity || !match(a.subject,identity.subject)||!match(a.issuer,identity.issuer))return false;
    return this.#approvals.delete(approvalId);
  }
  revokePendingConnection(deviceId,connectionId) {
    for(const [key,p] of this.#pending)if(p.deviceId===deviceId && p.connectionId===connectionId)this.#pending.delete(key);
  }
  revokeConnection(deviceId,connectionId){
    for(const [key,p] of this.#pending) if(p.deviceId===deviceId && p.connectionId===connectionId) this.#pending.delete(key);
    for(const [key,a] of this.#approvals){if(a.deviceId===deviceId&&a.connectionId===connectionId)this.#approvals.delete(key);}
  }
}

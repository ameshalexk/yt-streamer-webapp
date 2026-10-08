// Isolated server-side browser registration primitive for #30.
// No HTTP/WS route is exposed. Only a trusted origin authenticator may supply
// verifiedBrowserIdentity; never accept identity from an untrusted JS message.
import {randomBytes,randomUUID} from "node:crypto";

const VALID_ACTIONS=new Set(["get_player_state","search_media","play_media","pause",
  "resume","next","seek","set_volume","request_fullscreen"]);
const valid=x=>typeof x==="string"&&x.length>0&&x.length<=300;
const same=(a,b)=>a?.subject===b?.subject&&a?.issuer===b?.issuer;
const uuid=x=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
export class AuthenticatedBrowserRegistrationRegistry {
  #pending=new Map();#active=new Map();#now;#origins;
  constructor({allowedOrigins,now=Date.now}={}){
    if(!Array.isArray(allowedOrigins)||!allowedOrigins.length
       ||allowedOrigins.some(x=>typeof x!=="string"||!/^https:\/\/[^/]+$|^http:\/\/127\.0\.0\.1:\d+$/.test(x))
       ||typeof now!=="function")throw Error("invalid_registration_configuration");
    this.#origins=new Set(allowedOrigins);this.#now=now;
  }
  #clean(){
    for(const [k,v] of this.#pending)if(this.#now()>=v.expires)this.#pending.delete(k);
    for(const [k,v] of this.#active)if(this.#now()>=v.expires)this.#active.delete(k);
  }
  #check({verifiedBrowserIdentity,deviceId,connectionId,origin}){
    if(!valid(verifiedBrowserIdentity?.subject)||!valid(verifiedBrowserIdentity?.issuer)
       ||!uuid(deviceId)||!uuid(connectionId)||!this.#origins.has(origin))
      throw Error("browser_registration_denied");
  }
  // Called only AFTER server validates the browser's HttpOnly Access session,
  // TLS origin and WS connection. IDs are server assigned, not JS asserted.
  issue({verifiedBrowserIdentity,deviceId,connectionId,origin,actions}={}){
    this.#check({verifiedBrowserIdentity,deviceId,connectionId,origin});
    if(!Array.isArray(actions)||!actions.length||actions.length>VALID_ACTIONS.size
       ||new Set(actions).size!==actions.length||actions.some(a=>!VALID_ACTIONS.has(a)))
      throw Error("invalid_registration_actions");
    this.#clean();
    if(this.#pending.size>=64)throw Error("registration_capacity_exceeded");
    const nonce=randomBytes(32).toString("base64url");
    this.#pending.set(nonce,{identity:{subject:verifiedBrowserIdentity.subject,
      issuer:verifiedBrowserIdentity.issuer},deviceId,connectionId,origin,
      actions:[...actions],expires:this.#now()+60000});
    return {registration_nonce:nonce,expires_at:this.#now()+60000};
  }
  redeem({registrationNonce,verifiedBrowserIdentity,deviceId,connectionId,origin}={}){
    this.#check({verifiedBrowserIdentity,deviceId,connectionId,origin});
    this.#clean();
    const pending=this.#pending.get(registrationNonce);
    if(!pending||!same(pending.identity,verifiedBrowserIdentity)
       ||pending.deviceId!==deviceId||pending.connectionId!==connectionId
       ||pending.origin!==origin)return null;
    this.#pending.delete(registrationNonce); // consume BEFORE any further action
    // Re-pairing a device invalidates every prior registration for that device.
    for(const [k,v] of this.#active)if(v.deviceId===deviceId)this.#active.delete(k);
    const id=randomUUID(),expires=this.#now()+600000;
    this.#active.set(id,{...pending,expires,actions:new Set(pending.actions)});
    return {registration_id:id,device_id:deviceId,expires_at:expires,
      actions:[...pending.actions]};
  }
  authorize({registrationId,verifiedBrowserIdentity,deviceId,connectionId,action}={}){
    this.#clean();
    const v=this.#active.get(registrationId);
    return Boolean(v&&same(v.identity,verifiedBrowserIdentity)&&v.deviceId===deviceId
      &&v.connectionId===connectionId&&v.actions.has(action));
  }
  revokeConnection({deviceId,connectionId}={}){
    for(const [k,v] of this.#pending)if(v.deviceId===deviceId&&v.connectionId===connectionId)
      this.#pending.delete(k);
    for(const [k,v] of this.#active)if(v.deviceId===deviceId&&v.connectionId===connectionId)
      this.#active.delete(k);
  }
  revoke({registrationId,verifiedBrowserIdentity}={}){
    const v=this.#active.get(registrationId);
    if(!v||!same(v.identity,verifiedBrowserIdentity))return false;
    return this.#active.delete(registrationId);
  }
}

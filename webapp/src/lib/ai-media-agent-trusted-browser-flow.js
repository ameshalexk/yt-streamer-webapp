// Isolated authenticated browser-registration seam for #30.
// No public route: the WebSocket upgrade handler must call connect(req) AFTER
// the configured Access/TLS ingress. A browser cannot assert its own identity,
// device ID, connection ID, registration scope or origin.
import {randomUUID} from "node:crypto";
import {verifyAccessJwt} from "./ai-media-agent-remote-authorization.js";
import {AuthenticatedBrowserRegistrationRegistry} from "./ai-media-agent-browser-registration.js";

const deny=()=>{throw Error("trusted_browser_denied");};
function cookieJwt(raw){
  if(typeof raw!=="string"||raw.length>20000)return null;
  const matches=raw.split(";").map(x=>x.trim()).filter(x=>x.startsWith("CF_Authorization="));
  if(matches.length!==1)return null;
  const value=matches[0].slice("CF_Authorization=".length);
  return /^[A-Za-z0-9_.-]{20,16000}$/.test(value)?value:null;
}
export class TrustedBrowserRegistrationFlow {
  #connections=new WeakMap();#registry;#jwks;#audience;#subjects;#origins;#now;
  #lastUnknownKidRefresh=-Infinity;
  constructor({jwksProvider,audience,allowedSubjects,allowedOrigins,accessPolicyOnly=false,now=Date.now}={}){
    if(typeof jwksProvider?.get!=="function"||
       !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(jwksProvider.issuer||"")||
       typeof audience!=="string"||audience.length<8||
       !Array.isArray(allowedSubjects)||(!accessPolicyOnly&&!allowedSubjects.length)||
       allowedSubjects.some(x=>typeof x!=="string"||!x||x.length>300)||
       !Array.isArray(allowedOrigins)||!allowedOrigins.length||typeof now!=="function")
      throw Error("invalid_trusted_browser_configuration");
    this.#registry=new AuthenticatedBrowserRegistrationRegistry({allowedOrigins,now});
    this.#jwks=jwksProvider;this.#audience=audience;
    this.#subjects=accessPolicyOnly?null:new Set(allowedSubjects);this.#origins=new Set(allowedOrigins);this.#now=now;
  }
  // Only the actual HTTP upgrade request reaches this method. Cloudflare
  // normally forwards Cf-Access-Jwt-Assertion; a browser may also send its
  // HttpOnly CF_Authorization cookie. Neither is trusted without JWT signature
  // and exact audience verification. Do not accept headers describing users.
  async authenticateHttp(req){
    const h=req?.headers;
    if(req?.method!=="POST" || !this.#origins.has(h?.origin) ||
       h?.host!==new URL(h.origin).host ||
       (h["sec-fetch-site"] && h["sec-fetch-site"]!=="same-origin")) deny();
    const {identity,expiresAt}=await this.#verifyIdentity(h);
    return {subject:identity.subject,issuer:identity.issuer,expires_at:expiresAt};
  }
  async connect(req){
    const h=req?.headers;
    const origin=h?.origin;
    if(typeof origin!=="string"||!this.#origins.has(origin)||
       String(h?.upgrade||"").toLowerCase()!=="websocket"||
       !String(h?.connection||"").toLowerCase().split(",").some(x=>x.trim()==="upgrade"))
      deny();
    const {identity,expiresAt}=await this.#verifyIdentity(h);
    const handle=Object.freeze({});
    const context={identity:{subject:identity.subject,issuer:identity.issuer},
      deviceId:randomUUID(),connectionId:randomUUID(),origin,expiresAt,closed:false};
    this.#connections.set(handle,context);
    return {handle,device_id:context.deviceId,connection_id:context.connectionId,
      expires_at:expiresAt,subject:identity.subject};
  }
  async #verifyIdentity(h){
    const header=h["cf-access-jwt-assertion"];
    const cookie=cookieJwt(h.cookie);
    if(header!=null&&(typeof header!=="string"||!header))deny();
    if(header&&cookie&&header!==cookie)deny();
    const jwt=header||cookie;
    if(!jwt)deny();
    let identity,expiresAt;
    try{
      let jwks=await this.#jwks.get();
      const verifyCurrent=keys=>verifyAccessJwt(jwt,{jwks:keys,
        issuer:this.#jwks.issuer,audience:this.#audience,
        nowSeconds:Math.floor(this.#now()/1000)});
      try{
        identity=verifyCurrent(jwks);
      }catch(error){
        // Access rotates RSA signing keys. Refresh ONLY for a bounded unknown
        // key identifier from the already configured provider (never from JWT
        // jku/x5u), at most once per 30s. Bad signatures and expired tokens
        // fail closed without network amplification.
        let kid=null;
        try{
          const encoded=jwt.split(".")[0];
          if(encoded.length>0 && encoded.length<2048)
            kid=JSON.parse(Buffer.from(encoded,"base64url").toString("utf8"))?.kid;
        }catch{}
        if(typeof kid!=="string" || !/^[A-Za-z0-9_.-]{1,180}$/.test(kid)
           || jwks.keys?.some(k=>k.kid===kid)
           || typeof this.#jwks.refresh!=="function"
           || this.#now()-this.#lastUnknownKidRefresh<30000)throw error;
        this.#lastUnknownKidRefresh=this.#now();
        jwks=await this.#jwks.refresh();
        identity=verifyCurrent(jwks);
      }
      const body=JSON.parse(Buffer.from(jwt.split(".")[1],"base64url").toString("utf8"));
      expiresAt=body.exp*1000;
      if((this.#subjects&&!this.#subjects.has(identity.subject))||!Number.isSafeInteger(expiresAt)
         ||expiresAt<=this.#now())deny();
    }catch{deny();}
    return {identity,expiresAt};
  }
  #live(handle){
    const c=handle&&this.#connections.get(handle);
    if(!c||c.closed||this.#now()>=c.expiresAt)return null;
    return c;
  }
  issue(handle,actions){
    const c=this.#live(handle);if(!c)deny();
    return this.#registry.issue({verifiedBrowserIdentity:c.identity,
      deviceId:c.deviceId,connectionId:c.connectionId,origin:c.origin,actions});
  }
  redeem(handle,registrationNonce){
    const c=this.#live(handle);if(!c)return null;
    return this.#registry.redeem({registrationNonce,verifiedBrowserIdentity:c.identity,
      deviceId:c.deviceId,connectionId:c.connectionId,origin:c.origin});
  }
  authorize(handle,registrationId,action){
    const c=this.#live(handle);
    return Boolean(c&&this.#registry.authorize({registrationId,
      verifiedBrowserIdentity:c.identity,deviceId:c.deviceId,
      connectionId:c.connectionId,action}));
  }
  disconnect(handle){
    const c=handle&&this.#connections.get(handle);
    if(!c||c.closed)return false;
    c.closed=true;
    this.#registry.revokeConnection({deviceId:c.deviceId,connectionId:c.connectionId});
    this.#connections.delete(handle);
    return true;
  }
}

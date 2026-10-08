// ISOLATED remote MCP candidate for #30. Bind loopback only; NEVER forward /dev/*.
// Cloudflare Access TLS ingress and Access application configuration are external approval gates.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { devMcpTools } from "./ai-agent-dev-mcp.mjs";
import { verifyAccessJwt } from "../src/lib/ai-media-agent-remote-authorization.js";

const VERSION="2025-11-25";
const fail=(code,message,id=null)=>({jsonrpc:"2.0",id,error:{code,message}});
const result=(id,value)=>({jsonrpc:"2.0",id,result:value});
const output=value=>({isError:false,content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value});
const errorOutput=message=>({isError:true,content:[{type:"text",text:message}]});
const has=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const uuid=x=>typeof x==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const mcpTools=[
  {name:"list_devices",description:"List paired browser tab IDs for explicit authorization requests; listing does not confer control.",
    inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:"request_browser_approval",description:"Ask a selected paired browser for an explicit local click approval; no control until claimed.",
    inputSchema:{type:"object",properties:{device_id:{type:"string",format:"uuid"},
      actions:{type:"array",items:{type:"string",enum:devMcpTools.filter(t=>t.name!=="list_devices").map(t=>t.name)},minItems:1,maxItems:9}},required:["device_id","actions"],additionalProperties:false}},
  {name:"claim_browser_approval",description:"Claim an already-approved short-lived grant scoped to your Access identity and exact browser connection.",
    inputSchema:{type:"object",properties:{request_id:{type:"string",format:"uuid"}},required:["request_id"],additionalProperties:false}},
  {name:"revoke_browser_approval",description:"Revoke a short-lived grant; does not interrupt media already playing.",
    inputSchema:{type:"object",properties:{approval_id:{type:"string",format:"uuid"}},required:["approval_id"],additionalProperties:false}},
  ...devMcpTools.filter(t=>t.name!=="list_devices").map(t=>({
    ...t,inputSchema:{...t.inputSchema,required:[...t.inputSchema.required,"approval_id"],
      properties:{...t.inputSchema.properties,approval_id:{type:"string",format:"uuid"}}}
  })),
];
const specs=new Map(mcpTools.map(t=>[t.name,t]));
function validate(name,args){
  const spec=specs.get(name);
  if(!spec || !args || typeof args!=="object" || Array.isArray(args))return false;
  const s=spec.inputSchema;
  if(Object.keys(args).some(k=>!has(s.properties,k)) || (s.required||[]).some(k=>!has(args,k)))return false;
  for(const [k,v] of Object.entries(args)){
    const f=s.properties[k];
    if(f.type==="array"){
      if(!Array.isArray(v)||v.length<(f.minItems||0)||v.length>(f.maxItems||100)
        ||v.some(x=>typeof x!=="string" || !f.items.enum.includes(x))||new Set(v).size!==v.length)return false;
    } else if(f.type==="integer" || f.type==="number"){
      if(typeof v!=="number" || !Number.isFinite(v) || (f.type==="integer"&&!Number.isInteger(v))
        ||(f.minimum!==undefined && v<f.minimum)||(f.maximum!==undefined && v>f.maximum))return false;
    } else if(f.type==="string"){
      if(typeof v!=="string" || (f.minLength && v.length<f.minLength)||(f.maxLength && v.length>f.maxLength)
        ||(f.format==="uuid"&&!uuid(v)))return false;
    }else return false;
  }
  return true;
}
function json(res,code,value,headers={}){
  res.writeHead(code,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",
    "x-content-type-options":"nosniff","referrer-policy":"no-referrer",...headers});
  res.end(JSON.stringify(value));
}
async function readJson(req){
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>16384)throw Error("body_limit");chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** Fetch only one administratively configured Access team domain, never token-provided URLs.
 * No stale-on-error behavior. This module deliberately doesn't configure a Cloudflare Tunnel.
 */
export function createPinnedCloudflareJwksProvider({teamDomain,fetchImpl=fetch,now=Date.now,
  ttlMs=300000}={}){
  if(typeof teamDomain!=="string"|| !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)
     || typeof fetchImpl!=="function"||typeof now!=="function"
     ||!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>600000)throw Error("invalid_jwks_configuration");
  const uri="https://"+teamDomain+"/cdn-cgi/access/certs";
  let cached=null,expiry=0;
  async function refresh(){
    const response=await fetchImpl(uri,{redirect:"error",signal:AbortSignal.timeout(4000),
      headers:{accept:"application/json"}});
    if(!response.ok)throw Error("jwks_unavailable");
    const bytes=await response.text();
    if(bytes.length>65536)throw Error("jwks_too_large");
    const value=JSON.parse(bytes);
    if(!Array.isArray(value?.keys)||value.keys.length<1||value.keys.length>20
      ||value.keys.some(k=>k.kty!=="RSA"||typeof k.kid!=="string"
        ||!k.n||!k.e|| (k.use!=null && k.use!=="sig")))throw Error("invalid_jwks");
    cached={keys:value.keys};expiry=now()+ttlMs;
    return cached;
  }
  return {
    get:()=>cached && now()<expiry?Promise.resolve(cached):refresh(),
    refresh,
    issuer:"https://"+teamDomain,
    uri,
  };
}
/** A remote HTTP listener separate from dev relay. The relay is injected in-process,
 * not reached by forwarding its bearer-only HTTP or WebSocket port.
 * Public TLS termination/Access enforcement MUST be separately reviewed.
 */
export async function startLocalRemoteMcpGateway({relay,teamDomain,audience,allowedSubjects,
  jwksProvider,port=0,host="127.0.0.1",now=Date.now}={}){
  if(host!=="127.0.0.1" || !relay?.registry || !relay?.approvals
    ||!relay?.remoteHooks || typeof audience!=="string" || audience.length<8
    ||!Array.isArray(allowedSubjects)||allowedSubjects.length<1
    ||allowedSubjects.some(x=>typeof x!=="string"||x.length<1||x.length>300)
    ||typeof now!=="function")throw Error("invalid_remote_mcp_configuration");
  const keySource=jwksProvider||createPinnedCloudflareJwksProvider({teamDomain,now});
  if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(keySource.issuer||"")
    ||(teamDomain && keySource.issuer!=="https://"+teamDomain)
    ||typeof keySource.get!=="function")throw Error("untrusted_jwks_configuration");
  const allowed=new Set(allowedSubjects), used=new Map(), calls=new Map();
  // A standard Streamable HTTP MCP client automatically echoes this server-issued
  // session header. Bind the random session to the verified Access principal and
  // reject duplicate JSON-RPC IDs for its entire bounded lifetime. Legacy stateless
  // clients may instead supply a per-call X-AI-Request-Id UUID as before.
  const sessions=new Map(), SESSION_TTL_MS=15*60000, MAX_SESSIONS=128;
  let lastUnknownKidRefresh=-Infinity;
  function pruneSessions(){
    for(const [id,s] of sessions)if(now()>=s.expires)sessions.delete(id);
  }
  function sessionFor(header,identity){
    if(typeof header!=="string" || header.length>128)return null;
    const s=sessions.get(header);
    if(!s || now()>=s.expires || s.subject!==identity.subject || s.issuer!==identity.issuer)return null;
    return s;
  }
  function throttle(subject){
    const at=now(),hits=(calls.get(subject)||[]).filter(t=>at-t<60000);
    if(hits.length>=60)return false;
    hits.push(at);calls.set(subject,hits);return true;
  }
  async function handle(req,res){
    if(req.url!=="/remote/mcp")return json(res,404,{error:"not_found"});
    if(req.method!=="POST")return json(res,405,{error:"method_not_allowed"});
    // Remote MCP is server-to-server, no browser CORS/credential-bearing requests.
    if(req.headers.origin)return json(res,403,{error:"origin_not_allowed"});
    if(!String(req.headers["content-type"]||"").startsWith("application/json"))
      return json(res,415,fail(-32600,"json_content_type_required"));
    const accept=String(req.headers.accept||"");
    if(!accept.includes("application/json")||!accept.includes("text/event-stream"))
      return json(res,406,fail(-32600,"accept_header_required"));
    if(req.headers["mcp-protocol-version"] && req.headers["mcp-protocol-version"]!==VERSION)
      return json(res,400,fail(-32600,"unsupported_protocol_version"));
    let identity;
    try{
      const token=req.headers["cf-access-jwt-assertion"];
      let jwks=await keySource.get();
      try{
        identity=verifyAccessJwt(token,{jwks,issuer:keySource.issuer,audience,
          nowSeconds:Math.floor(now()/1000)});
      }catch(error){
        // Only refresh on a missing key ID; malformed, expired or bad-signature
        // tokens must never cause network refresh. Cooldown blocks kid-flood DoS.
        let kid=null;
        try{
          const head=typeof token==="string"?token.split(".")[0]:"";
          if(head.length>0&&head.length<2048)
            kid=JSON.parse(Buffer.from(head,"base64url").toString("utf8"))?.kid;
        }catch{}
        if(typeof kid!=="string"||kid.length>180||jwks.keys?.some(k=>k.kid===kid)
           ||typeof keySource.refresh!=="function"
           ||now()-lastUnknownKidRefresh<30000)throw error;
        lastUnknownKidRefresh=now();
        jwks=await keySource.refresh();
        identity=verifyAccessJwt(token,{jwks,issuer:keySource.issuer,audience,
          nowSeconds:Math.floor(now()/1000)});
      }
      if(!allowed.has(identity.subject))throw Error("subject_not_allowed");
    }catch{return json(res,401,{error:"unauthorized"});}
    if(!throttle(identity.subject))return json(res,429,{error:"rate_limited"});
    let call;
    try{call=await readJson(req);}catch{return json(res,400,fail(-32700,"invalid_json"));}
    pruneSessions();
    const sessionHeader=req.headers["mcp-session-id"];
    const session=sessionHeader?sessionFor(sessionHeader,identity):null;
    if(sessionHeader && !session && call?.method!=="initialize")
      return json(res,404,{error:"invalid_mcp_session"});
    if(call?.jsonrpc==="2.0" && call.method==="notifications/initialized"
       && call.id===undefined){
      res.writeHead(202,{"cache-control":"no-store"});res.end();return;
    }
    if(!call || call.jsonrpc!=="2.0"||typeof call.method!=="string"
      || !(Number.isSafeInteger(call.id)||(typeof call.id==="string"&&call.id.length>0&&call.id.length<=64)))
      return json(res,400,fail(-32600,"invalid_request"));
    if(call.method==="initialize"){
      if(!["2025-11-25","2025-03-26"].includes(call.params?.protocolVersion))
        return json(res,400,fail(-32602,"unsupported_client_version",call.id));
      if(sessions.size>=MAX_SESSIONS)return json(res,429,{error:"session_capacity_exceeded"});
      const sessionId=randomBytes(32).toString("base64url");
      sessions.set(sessionId,{issuer:identity.issuer,subject:identity.subject,
        expires:now()+SESSION_TTL_MS,seen:new Set()});
      return json(res,200,result(call.id,{protocolVersion:VERSION,
        capabilities:{tools:{}},serverInfo:{name:"yt-streamer-remote-candidate",version:"0.1.0"}}),
        {"mcp-session-id":sessionId});
    }
    if(call.method==="ping")return json(res,200,result(call.id,{}));
    if(call.method==="tools/list")return json(res,200,result(call.id,{tools:mcpTools}));
    if(call.method!=="tools/call")return json(res,200,fail(-32601,"method_not_found",call.id));
    const action=call.params?.name,args=call.params?.arguments||{};
    if(!validate(action,args))return json(res,200,result(call.id,errorOutput("invalid_tool_arguments")));
    // Session mode: the standard MCP client's JSON-RPC request ID is unique
    // within a server-issued, unguessable principal-bound session. Record it
    // BEFORE dispatch; retries of uncertain writes are always denied.
    // Header mode: preserve legacy stateless UUID nonce replay protection.
    if(session){
      const requestKey=typeof call.id+":"+String(call.id);
      if(session.seen.has(requestKey))return json(res,409,fail(-32600,"replayed_request",call.id));
      if(session.seen.size>=2048)return json(res,429,{error:"session_request_limit"});
      session.seen.add(requestKey);
    }else{
      const nonce=req.headers["x-ai-request-id"];
      if(!uuid(nonce))return json(res,400,fail(-32600,"unique_request_id_required",call.id));
      const at=now();
      for(const [k,t] of used)if(at-t>=300000)used.delete(k);
      const replayKey=identity.issuer+"|"+identity.subject+"|"+nonce;
      if(used.has(replayKey))return json(res,409,fail(-32600,"replayed_request",call.id));
      if(used.size>=5000)return json(res,429,{error:"replay_capacity_exceeded"});
      used.set(replayKey,at);
    }
    let value;
    try{
      if(action==="list_devices")value={devices:relay.registry.list("owner")};
      else if(action==="request_browser_approval"){
        const connectionId=relay.registry.connectionFor("owner",args.device_id);
        if(!connectionId){value={status:"offline"};}
        else{
          const grant=relay.approvals.request({identity,deviceId:args.device_id,connectionId,actions:args.actions});
          if(!relay.remoteHooks.requestBrowserApproval({deviceId:args.device_id,connectionId,
            requestId:grant.request_id,subject:identity.subject,actions:args.actions})){
            relay.approvals.revokePendingConnection(args.device_id,connectionId);
            value={status:"offline"};
          }else value=grant;
        }
      }else if(action==="claim_browser_approval")value=relay.approvals.claim({identity,requestId:args.request_id})||{status:"not_found"};
      else if(action==="revoke_browser_approval"){
        // Revocation is scoped by the grant identity, not merely possession of an ID.
        value={revoked:relay.approvals.revokeOwned(identity,args.approval_id)};
      }else{
        const {device_id,approval_id,...mediaArgs}=args;
        const connectionId=relay.registry.connectionFor("owner",device_id);
        if(!connectionId || !relay.approvals.authorize({identity,approvalId:approval_id,
          deviceId:device_id,connectionId,action}))value={status:"unauthorized"};
        else value=await relay.registry.dispatch({principal:"owner",deviceId:device_id,action,args:mediaArgs});
      }
    }catch{value={status:"failed"};}
    return json(res,200,result(call.id,output(value)));
  }
  const server=http.createServer((req,res)=>{handle(req,res).catch(()=>json(res,500,{error:"internal_error"}));});
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,host,resolve);});
  return {origin:"http://127.0.0.1:"+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}

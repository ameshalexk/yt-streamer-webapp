// DEVELOPMENT-ONLY trusted Access browser WS -> existing MCP command registry.
// Bind to loopback; not imported by the production server. Never forward this
// listener to Cloudflare without separate ingress, CSRF/CSP and physical QA review.
import http from "node:http";
import {WebSocketServer} from "ws";
import {AgentSessionRegistry} from "../src/lib/ai-media-agent-session-registry.js";
import {BrowserApprovalRegistry} from "../src/lib/ai-media-agent-remote-authorization.js";

const ACTIONS=["get_player_state","search_media","play_media","pause","resume",
  "next","seek","set_volume","request_fullscreen"];
const rejectUpgrade=socket=>{
  if(socket.destroyed)return;
  socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
};

export async function startTrustedAccessBrowserRelay({trustedBrowserFlow,
  host="127.0.0.1",port=0,ttlMs=7000,timeoutMs=1500,maxConnections=8}={}){
  if(host!=="127.0.0.1" || typeof trustedBrowserFlow?.connect!=="function"
     || typeof trustedBrowserFlow?.issue!=="function"
     || typeof trustedBrowserFlow?.redeem!=="function"
     || typeof trustedBrowserFlow?.authorize!=="function"
     || typeof trustedBrowserFlow?.disconnect!=="function"
     || !Number.isInteger(maxConnections)||maxConnections<1||maxConnections>32)
    throw Error("trusted_loopback_configuration_required");
  const proofs=new Map(), clients=new Set();
  const approvals=new BrowserApprovalRegistry();
  // Browser registration always happens on the SERVER after verified Access
  // upgrade; the browser never supplies its principal, proof, or device ID.
  const registry=new AgentSessionRegistry({ttlMs,timeoutMs,
    authorizePairing:({principal,pairingProof,connectionId})=>
      principal==="owner" && !!pairingProof && proofs.get(connectionId)===pairingProof});
  const wss=new WebSocketServer({noServer:true,maxPayload:8192});
  const server=http.createServer((_req,res)=>{
    res.writeHead(404,{"cache-control":"no-store","x-content-type-options":"nosniff"});
    res.end();
  });
  let inflight=0;
  server.on("upgrade",async(req,socket,head)=>{
    if(req.url!=="/trusted/player" || clients.size+inflight>=maxConnections){
      rejectUpgrade(socket);return;
    }
    inflight++;
    let verified;
    try{
      // Cryptographic JWT verification, pinned issuer, audience, subject and
      // exact Origin happen BEFORE calling handleUpgrade.
      verified=await trustedBrowserFlow.connect(req);
      if(socket.destroyed){trustedBrowserFlow.disconnect(verified.handle);return;}
      const nonce=trustedBrowserFlow.issue(verified.handle,ACTIONS);
      const registration=trustedBrowserFlow.redeem(verified.handle,nonce.registration_nonce);
      if(!registration || !trustedBrowserFlow.authorize(verified.handle,
          registration.registration_id,"get_player_state"))throw Error("unverified_registration");
      wss.handleUpgrade(req,socket,head,ws=>{
        clients.add(ws);
        const secret=Object.freeze({});
        proofs.set(verified.connection_id,secret);
        let deviceId=null;
        const allowed=action=>trustedBrowserFlow.authorize(verified.handle,
          registration.registration_id,action);
        function send(frame){
          if(ws.readyState!==ws.OPEN)return false;
          if(frame.kind==="command" && !allowed(frame.action) ||
             frame.kind==="remote_approval_request" && !allowed("get_player_state")){
            ws.close(1008,"access_expired");return false;
          }
          ws.send(JSON.stringify(frame));return true;
        }
        try{
          // The only pairing proof is an unexported server object.
          const device=registry.register({principal:"owner",connectionId:verified.connection_id,
            pairingProof:secret,label:"Access browser",send});
          deviceId=device.device_id;
          ws.send(JSON.stringify({kind:"registered",...device}));
        }catch{ws.close(1008,"registration_denied");}
        ws.on("message",raw=>{
          if(!deviceId)return;
          let frame;
          try{frame=JSON.parse(String(raw));}catch{ws.close(1008,"invalid_json");return;}
          if(!allowed("get_player_state")){
            ws.close(1008,"access_expired");return;
          }
          if(frame?.kind==="heartbeat"){
            if(!registry.heartbeat({principal:"owner",deviceId,
              connectionId:verified.connection_id,state:frame.state}))
              ws.close(1012,"session_expired");
          }else if(frame?.kind==="ack"){
            registry.acknowledge({principal:"owner",deviceId,connectionId:verified.connection_id,
              commandId:frame.command_id,status:frame.status,state:frame.state,
              result:frame.result,error:frame.error});
          }else if(frame?.kind==="approve_remote_request"){
            const approved=typeof frame.request_id==="string"&&
              approvals.approvePendingFromBrowser({requestId:frame.request_id,
                deviceId,connectionId:verified.connection_id});
            send({kind:approved?"remote_approval_recorded":"remote_approval_rejected"});
          }else ws.close(1008,"invalid_message");
        });
        ws.on("close",()=>{
          clients.delete(ws);proofs.delete(verified.connection_id);
          approvals.revokeConnection(deviceId,verified.connection_id);
          if(deviceId)registry.disconnect({deviceId,connectionId:verified.connection_id});
          trustedBrowserFlow.disconnect(verified.handle);
        });
      });
    }catch{
      if(verified)trustedBrowserFlow.disconnect(verified.handle);
      rejectUpgrade(socket);
    }finally{inflight--;}
  });
  await new Promise((resolve,reject)=>{
    server.once("error",reject);server.listen(port,host,resolve);
  });
  const sweep=setInterval(()=>registry.sweep(),Math.min(1000,ttlMs));
  sweep.unref?.();
  return {
    origin:"http://127.0.0.1:"+server.address().port,registry,approvals,
    remoteHooks:{
      requestBrowserApproval({deviceId,connectionId,requestId,subject,actions}){
        return registry.connectionFor("owner",deviceId)===connectionId &&
          registry.notifyDevice("owner",deviceId,{
            kind:"remote_approval_request",device_id:deviceId,
            request_id:requestId,subject,actions});
      }
    },
    async close(){
      clearInterval(sweep);
      for(const ws of clients)ws.terminate();
      await new Promise(resolve=>wss.close(resolve));
      await new Promise(resolve=>server.close(resolve));
    }
  };
}

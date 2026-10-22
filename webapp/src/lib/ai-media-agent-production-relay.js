// Same-origin, Cloudflare-Access-verified browser playback relay.
// Only the existing Mac Control Unix socket may dispatch remote commands.
// Never expose /dev, credentials, or public HTTP controller routes.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomUUID,randomBytes} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {AgentSessionRegistry} from './ai-media-agent-session-registry.js';
import {BrowserApprovalRegistry} from './ai-media-agent-remote-authorization.js';
import {TrustedBrowserRegistrationFlow} from './ai-media-agent-trusted-browser-flow.js';
import {createPinnedCloudflareJwksProvider} from '../../scripts/ai-agent-remote-mcp.mjs';
import {startMacControlLocalBridge} from './ai-media-agent-mac-control-bridge.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROLS = new Set(['get_player_state','search_media','play_media','pause','resume','stop']);
const QUEUE_WINDOW_MS=120000;
const validKey=x=>typeof x==='string'&&UUID.test(x);
const safeName=x=>typeof x==='string'&&x.length>0&&x.length<=64&&/^[\p{L}\p{N} ._()-]+$/u.test(x);
const send=(ws,frame)=>{if(ws.readyState!==ws.OPEN)return false;ws.send(JSON.stringify(frame));return true;};
const reject=(socket)=>{if(!socket.destroyed)socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');};

export async function startProductionMediaRelay({server,controlDir,teamDomain,audience,
  allowedSubjects=[],origin='https://stream.ameshalex.com',jwksProvider}={}) {
  if(!server||typeof server.on!=='function'||typeof controlDir!=='string'||
     !path.isAbsolute(controlDir)||!/^https:\/\/[a-z0-9.-]+$/.test(origin)||
     typeof audience!=='string'||audience.length<8||
     !Array.isArray(allowedSubjects))throw Error('invalid_production_media_config');
  const keySource=jwksProvider||createPinnedCloudflareJwksProvider({teamDomain});
  const flow=new TrustedBrowserRegistrationFlow({jwksProvider:keySource,audience,
    allowedSubjects,accessPolicyOnly:allowedSubjects.length===0,allowedOrigins:[origin]});
  await fs.mkdir(controlDir,{recursive:true,mode:0o700});
  const st=await fs.lstat(controlDir);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||
     (typeof process.getuid==='function'&&st.uid!==process.getuid()))
    throw Error('unsafe_control_directory');
  const socketPath=path.join(controlDir,'bridge.sock');
  // Recover only an owner-owned, private socket whose listener is provably gone.
  // Never disconnect another live service or replace a changed filesystem inode.
  const previous=await fs.lstat(socketPath).catch(ex=>{
    if(ex.code==='ENOENT')return null;throw ex;
  });
  if(previous){
    if(!previous.isSocket()||(previous.mode&0o077)!==0||
       (typeof process.getuid==='function'&&previous.uid!==process.getuid()))
      throw Error('unsafe_existing_control_socket');
    const state=await new Promise(resolve=>{
      const probe=net.createConnection(socketPath);
      probe.setTimeout(1500,()=>{probe.destroy();resolve('timeout');});
      probe.once('connect',()=>{probe.destroy();resolve('active');});
      probe.once('error',ex=>{probe.destroy();resolve(ex.code||'error');});
    });
    if(state!=='ECONNREFUSED')throw Error('active_or_uncertain_control_socket');
    const current=await fs.lstat(socketPath);
    if(!current.isSocket()||current.ino!==previous.ino||current.dev!==previous.dev)
      throw Error('control_socket_changed');
    await fs.unlink(socketPath);
  }
  const selectionPath=path.join(controlDir,'selected-device.json');
  let selected=null;
  try {
    const file=await fs.lstat(selectionPath);
    if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0||file.size>1024)
      throw Error('unsafe_selection_file');
    const saved=JSON.parse(await fs.readFile(selectionPath,'utf8'));
    if(validKey(saved.device_key)&&typeof saved.subject==='string'&&saved.subject.length<300)
      selected={device_key:saved.device_key,subject:saved.subject};
  }catch(ex){if(ex.code!=='ENOENT')throw ex;}
  const registry=new AgentSessionRegistry({ttlMs:45000,timeoutMs:6500,maxSessions:16,
    authorizePairing:({principal,pairingProof})=>principal==='owner'&&pairingProof===proof});
  const approvals=new BrowserApprovalRegistry();
  const proof=Object.freeze({});
  const clients=new Map();
  const tickets=new Map();
  const TICKET_MS=15000;
  const purgeTickets=()=>{
    for(const [ticket,claim] of tickets)if(Date.now()>=claim.expires)tickets.delete(ticket);
  };
  async function bootstrap(req){
    // Access-protected SAME-ORIGIN HTTP fetch, not a guessed WebSocket JWT.
    // No user/identity is trusted unless the pinned Access signature verifies.
    const identity=await flow.authenticateHttp(req);
    purgeTickets();
    if(tickets.size>=64)throw Error('pairing_capacity');
    const ticket=randomBytes(32).toString('base64url');
    const expires=Math.min(Date.now()+TICKET_MS,identity.expires_at);
    if(expires<=Date.now())throw Error('access_expired');
    tickets.set(ticket,{subject:identity.subject,issuer:identity.issuer,
      expires,accessExpires:identity.expires_at});
    return {ticket,expires_at:expires};
  }
  let queued=null,bridge,closed=false;
  const wss=new WebSocketServer({noServer:true,maxPayload:8192});
  let pendingUpgrades=0;
  const eligible=()=>[...clients.values()].filter(c=>c.ready&&c.consent&&
    registry.connectionFor('owner',c.deviceId)===c.connectionId);
  const devices=()=>eligible().map(c=>({device_key:c.key,device_id:c.deviceId,
    label:c.label,selected:Boolean(selected&&selected.device_key===c.key&&selected.subject===c.subject),
    online:true,state:registry.list('owner').find(x=>x.device_id===c.deviceId)?.state||null}));
  const chosen=()=>{
    const online=eligible();
    if(selected)return online.find(c=>selected.device_key===c.key&&selected.subject===c.subject)||null;
    return online.length===1?online[0]:null;
  };
  async function remember(c){
    selected={device_key:c.key,subject:c.subject};
    const tmp=selectionPath+'.'+randomUUID();
    try{await fs.writeFile(tmp,JSON.stringify(selected)+'\n',{mode:0o600,flag:'wx'});
      await fs.rename(tmp,selectionPath);
    }finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
  }
  async function dispatch(action,args={}){
    const target=chosen();
    if(!target){
      if(!selected&&eligible().length>1)return {status:'ambiguous_target',devices:devices()};
      if(action==='resume'&&selected){queued={...selected,action,expires:Date.now()+QUEUE_WINDOW_MS};
        return {status:'queued_until_reconnect',expires_at:queued.expires};}
      return {status:'offline',reason:'selected_browser_not_connected'};
    }
    const result=await registry.dispatch({principal:'owner',deviceId:target.deviceId,action,args});
    return {...result,device_key:target.key};
  }
  const directControls={
    devices,
    async run(name,args){
      if(name==='select_device'){
        const candidates=eligible().filter(c=>c.key===args.device_key);
        if(candidates.length!==1)return {status:'not_found'};
        await remember(candidates[0]);queued=null;
        return {status:'selected',device_key:args.device_key,label:candidates[0].label};
      }
      const action=({pause_selected:'pause',resume_selected:'resume',stop_selected:'stop',
        state_selected:'get_player_state',search_selected:'search_media',play_selected:'play_media'})[name];
      if(!CONTROLS.has(action))return {status:'unsupported'};
      if(action==='pause'||action==='stop')queued=null;
      const result=await dispatch(action,args);
      return result;
    }
  };
  const relay={registry,approvals,directControls,remoteHooks:{
    requestBrowserApproval({deviceId,connectionId,requestId,subject,actions}){
      const c=[...clients.values()].find(x=>x.deviceId===deviceId&&x.connectionId===connectionId);
      return Boolean(c&&send(c.ws,{kind:'remote_approval_request',device_id:deviceId,
        request_id:requestId,subject,actions}));
    }
  }};
  const onUpgrade=(req,socket,head)=>{
    // Any upgraded socket remains untrusted and inert until it redeems a
    // one-time ticket from an independently JWT-verified HTTP request.
    if(req.url!=='/ai-agent/player'||req.headers.origin!==origin||
       String(req.headers.upgrade||'').toLowerCase()!=='websocket'||
       clients.size>=16){reject(socket);return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      const context={ws,deviceId:null,connectionId:randomUUID(),
        subject:null,expiresAt:0,consent:false,ready:false};
      clients.set(ws,context);
      const identifyTimer=setTimeout(()=>ws.close(1008,'pairing_timeout'),6000);
      const authorized=()=>context.ready&&Date.now()<context.expiresAt;
      ws.on('message',raw=>{
        let msg;try{msg=JSON.parse(String(raw));}catch{ws.close(1008,'bad_json');return;}
        if(!context.ready){
          if(msg?.kind!=='hello'||!validKey(msg.tab_key)||msg.consent!==true||
             !safeName(msg.label)||typeof msg.ticket!=='string'||
             !/^[A-Za-z0-9_-]{43}$/.test(msg.ticket)){
            ws.close(1008,'pairing_required');return;
          }
          try{
            const ticket=tickets.get(msg.ticket);
            tickets.delete(msg.ticket); // one-use even after a failed attempt
            if(!ticket||Date.now()>=ticket.expires)throw Error('ticket_expired');
            context.expiresAt=ticket.accessExpires;
            context.subject=ticket.subject;
            for(const old of clients.values()){
              if(old===context||!old.ready||old.key!==msg.tab_key||old.subject!==context.subject)continue;
              old.ws.close(1001,'tab_reconnected');
              approvals.revokeConnection(old.deviceId,old.connectionId);
              registry.disconnect({deviceId:old.deviceId,connectionId:old.connectionId});
              old.ready=false;
            }
            context.key=msg.tab_key;context.label=msg.label;context.consent=true;
            const assigned=registry.register({principal:'owner',pairingProof:proof,
              connectionId:context.connectionId,label:msg.label,
              send:frame=>authorized()&&send(ws,frame)});
            context.deviceId=assigned.device_id;context.ready=true;
            clearTimeout(identifyTimer);
            send(ws,{kind:'registered',...assigned,tab_key:context.key});
            if(queued&&selected&&queued.device_key===context.key&&queued.subject===context.subject){
              const job=queued;queued=null;
              if(Date.now()<job.expires)setImmediate(()=>void dispatch(job.action).catch(()=>{}));
            }
          }catch{ws.close(1008,'pairing_denied');}
          return;
        }
        if(!authorized()){ws.close(1008,'access_expired');return;}
        if(msg?.kind==='heartbeat'){
          if(!registry.heartbeat({principal:'owner',deviceId:context.deviceId,
            connectionId:context.connectionId,state:msg.state}))ws.close(1012,'expired');
        }else if(msg?.kind==='ack'){
          registry.acknowledge({principal:'owner',deviceId:context.deviceId,
            connectionId:context.connectionId,commandId:msg.command_id,
            status:msg.status,state:msg.state,result:msg.result,error:msg.error});
        }else if(msg?.kind==='approve_remote_request'){
          if(approvals.approvePendingFromBrowser({requestId:msg.request_id,
            deviceId:context.deviceId,connectionId:context.connectionId}))
            send(ws,{kind:'remote_approval_recorded'});
        }else ws.close(1008,'invalid_message');
      });
      ws.on('close',()=>{
        clearTimeout(identifyTimer);clients.delete(ws);
        approvals.revokeConnection(context.deviceId,context.connectionId);
        if(context.deviceId)registry.disconnect({deviceId:context.deviceId,
          connectionId:context.connectionId});
      });
      ws.on('error',()=>{});
    });
  };
  server.on('upgrade',onUpgrade);
  const sweep=setInterval(()=>{registry.sweep();purgeTickets();if(queued&&Date.now()>=queued.expires)queued=null;},5000);
  sweep.unref?.();
  try{bridge=await startMacControlLocalBridge({relay,
    socketPath,maxRequestsPerMinute:80});}
  catch(ex){clearInterval(sweep);server.off('upgrade',onUpgrade);await new Promise(r=>wss.close(r));throw ex;}
  return {socketPath:bridge.socketPath,devices,bootstrap,async close(){
    if(closed)return;closed=true;clearInterval(sweep);server.off('upgrade',onUpgrade);
    for(const ws of clients.keys())ws.terminate();
    await bridge.close();await new Promise(r=>wss.close(r));
  }};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import net from 'node:net';
import {startProductionMediaRelay} from '../src/lib/ai-media-agent-production-relay.js';

const origin='https://stream.ameshalex.com';
const issuer='https://secure-test.cloudflareaccess.com';
const audience='safe-production-test-audience';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'testkey',alg:'RS256',use:'sig'};
const provider={issuer,get:async()=>({keys:[jwk]})};
const encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt({aud=audience,sub='browser-user'}={}){
 const now=Math.floor(Date.now()/1000);
 const head=encode({alg:'RS256',kid:'testkey'});
 const payload=encode({iss:issuer,aud,sub,iat:now-1,exp:now+600});
 const data=head+'.'+payload;
 return data+'.'+sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url');
}
const pauseState={playback_phase:'paused',paused:true,position_seconds:53,media_id:'abcdefABC12'};
const playingState={playback_phase:'playing',paused:false,position_seconds:54,media_id:'abcdefABC12'};
function control(socket,action,args={}){
 return new Promise((resolve,reject)=>{
  const conn=net.createConnection(socket),id=randomUUID();let data='';
  conn.setTimeout(3500,()=>conn.destroy(Error('control_timeout')));
  conn.once('connect',()=>conn.write(JSON.stringify({id,action,args})+'\n'));
  conn.on('data',chunk=>{data+=chunk.toString();if(data.includes('\n')){
   try{const response=JSON.parse(data.split('\n')[0]);assert.equal(response.id,id);resolve(response);conn.end();}
   catch(error){reject(error);conn.destroy();}
  }});
  conn.on('error',reject);
 });
}
async function bootstrap(port,token,requestOrigin=origin){
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:'/api/ai-agent/bootstrap',
   method:'POST',headers:{host:'stream.ameshalex.com',origin:requestOrigin,
    'sec-fetch-site':'same-origin','cf-access-jwt-assertion':token,
    'content-type':'application/json'}},res=>{
    let body='';res.setEncoding('utf8');res.on('data',s=>body+=s);
    res.once('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(body)});}catch(ex){reject(ex);}});
   });
  req.on('error',reject);req.end('{}');
 });
}
async function openBrowser(port,token,key,{label='iPhone YT Streamer',originHeader=origin,
 consent=true,overrideTicket=null}={}){
 const pair=await bootstrap(port,token,originHeader);
 if(pair.status!==200)throw Error('bootstrap_'+pair.status);
 return connectWithTicket(port,overrideTicket??pair.body.ticket,key,{label,originHeader,consent});
}
function connectWithTicket(port,ticket,key,{label='iPhone YT Streamer',originHeader=origin,
 consent=true}={}){
 return new Promise((resolve,reject)=>{
  // Crucial regression: WebSocket contains NO Cloudflare JWT/cookie.
  const ws=new WebSocket('ws://127.0.0.1:'+port+'/ai-agent/player',{
   headers:{origin:originHeader}});
  let live=false,paused=true;
  ws.on('open',()=>ws.send(JSON.stringify({kind:'hello',tab_key:key,label,consent,ticket})));
  ws.on('message',bytes=>{
   const data=JSON.parse(String(bytes));
   if(data.kind==='registered'){
    live=true;ws.send(JSON.stringify({kind:'heartbeat',state:pauseState}));
    resolve({ws,deviceId:data.device_id,key});
   }
   if(data.kind==='command'){
    if(data.action==='resume')paused=false;
    if(data.action==='pause'||data.action==='stop')paused=true;
    ws.send(JSON.stringify({kind:'ack',command_id:data.command_id,status:'completed',
     state:paused?pauseState:playingState,
     result:data.action==='search_media'?{results:[{media_id:'abcdefABC12',title:'Sample'}]}:undefined}));
   }
  });
  ws.on('error',ex=>{if(!live)reject(ex);});
  ws.on('close',()=>{if(!live)reject(Error('browser_rejected'));});
 });
}
function testServer(){
 let relay;
 const server=http.createServer((req,res)=>{
  if(req.url==='/api/ai-agent/bootstrap'&&req.method==='POST'){
   void relay.bootstrap(req).then(result=>{
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(result));
   }).catch(()=>{
    res.writeHead(401,{'content-type':'application/json'});
    res.end(JSON.stringify({error:'signed_access_required'}));
   });
  }else{res.writeHead(404);res.end();}
 });
 return {server,setRelay:r=>{relay=r;}};
}
async function eventually(fn,limit=2000){
 const since=Date.now();while(Date.now()-since<limit){if(await fn())return;await new Promise(r=>setTimeout(r,25));}
 throw Error('condition_not_met');
}
test('production Access browser relay and one-call private controls select exact device, reconnect and queue safely',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yt-ai-prod-'));
 const {server,setRelay}=testServer();
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port;
 const relay=await startProductionMediaRelay({server,controlDir:dir,audience,jwksProvider:provider});
 setRelay(relay);
 t.after(async()=>{await relay.close();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const socket=relay.socketPath;
 const keyA=randomUUID(),keyB=randomUUID();
 const a=await openBrowser(port,jwt(),keyA);
 const b=await openBrowser(port,jwt({sub:'other-authorized-browser'}),keyB,{label:'Tesla YT Streamer'});
 const list=await control(socket,'list_devices');
 assert.equal(list.result.devices.length,2);
 assert.equal((await control(socket,'resume_selected')).result.status,'ambiguous_target');
 assert.equal((await control(socket,'select_device',{device_key:keyA})).result.status,'selected');
 assert.equal((await control(socket,'resume_selected')).result.status,'completed');
 assert.equal((await control(socket,'pause_selected')).result.state.paused,true);
 assert.equal((await control(socket,'state_selected')).result.state.position_seconds,53);
 assert.equal((await control(socket,'search_selected',{query:'sample song'})).result.result.results[0].media_id,'abcdefABC12');
 assert.equal((await control(socket,'play_selected',{media_id:'abcdefABC12'})).result.status,'completed');
 const target=(await control(socket,'list_devices')).result.devices;
 assert.equal(target.find(x=>x.device_key===keyA).selected,true);
 assert.equal(target.find(x=>x.device_key===keyB).selected,false);
 a.ws.close();
 await eventually(()=>relay.devices().length===1);
 const queued=await control(socket,'resume_selected');
 assert.equal(queued.result.status,'queued_until_reconnect');
 const again=await openBrowser(port,jwt(),keyA);
 await eventually(()=>relay.devices().length===2);
 assert.equal((await control(socket,'pause_selected')).result.status,'completed');
 b.ws.close();again.ws.close();
});
test('unverified or foreign-origin browser cannot register a production device',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yt-ai-prod-deny-'));
 const {server,setRelay}=testServer();
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const relay=await startProductionMediaRelay({server,controlDir:dir,audience,jwksProvider:provider});
 setRelay(relay);
 t.after(async()=>{await relay.close();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const port=server.address().port;
 for(const [token,requestOrigin] of [[jwt({aud:'wrong-app'}),origin],[jwt(),'https://evil.test']]){
  await assert.rejects(()=>openBrowser(port,token,randomUUID(),{originHeader:requestOrigin}));
 }
 assert.equal((await control(relay.socketPath,'list_devices')).result.devices.length,0);
});

test('signed HTTP bootstrap is required; tickets are single-use; unauthenticated WS is inert',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yt-ai-ticket-'));
 const {server,setRelay}=testServer();
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const relay=await startProductionMediaRelay({server,controlDir:dir,audience,jwksProvider:provider});
 setRelay(relay);
 t.after(async()=>{await relay.close();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const port=server.address().port;
 assert.equal((await bootstrap(port,'not-a-jwt')).status,401);
 assert.equal((await bootstrap(port,jwt(),'https://attacker.test')).status,401);
 const claim=await bootstrap(port,jwt());
 assert.equal(claim.status,200);
 assert.match(claim.body.ticket,/^[A-Za-z0-9_-]{43}$/);
 const registered=await connectWithTicket(port,claim.body.ticket,randomUUID());
 await assert.rejects(()=>connectWithTicket(port,claim.body.ticket,randomUUID()),/browser_rejected/);
 await assert.rejects(()=>connectWithTicket(port,'bogus',randomUUID()),/browser_rejected/);
 await assert.rejects(()=>connectWithTicket(port,claim.body.ticket,randomUUID(),{originHeader:'https://attacker.test'}));
 assert.equal(relay.devices().length,1);
 registered.ws.close();
});


test('TeslaMon opt-in uses signed Access + exact registered WS tab, no implicit fallback or replay',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tm-access-integration-'));
 const {server,setRelay}=testServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 let relay;
 try{
   relay=await startProductionMediaRelay({
     server,controlDir:dir,audience,jwksProvider:provider,enableTeslaMon:true
   });
   setRelay(relay);
   const authorized={
     method:'POST',headers:{
       host:'stream.ameshalex.com',origin,
       'sec-fetch-site':'same-origin',
       'cf-access-jwt-assertion':jwt()
     }
   };
   const invalid={
     method:'POST',headers:{...authorized.headers,
       'cf-access-jwt-assertion':jwt({aud:'wrong-audience'})}
   };
   await assert.rejects(()=>relay.teslamon.devices(invalid));
   assert.equal(relay.teslamon.enabled,true);
   const keyA=randomUUID(),keyB=randomUUID();
   const a=await openBrowser(port,jwt(),keyA);
   const b=await openBrowser(port,jwt(),keyB,{label:'Decoy browser'});
   t.after(()=>{a.ws.terminate();b.ws.terminate();});
   const sentA=[],sentB=[];
   a.ws.on('message',raw=>{
     const event=JSON.parse(String(raw));if(event.kind==='command')sentA.push(event.action);
   });
   b.ws.on('message',raw=>{
     const event=JSON.parse(String(raw));if(event.kind==='command')sentB.push(event.action);
   });
   const devices=await relay.teslamon.devices(authorized);
   assert.equal(devices.devices.length,2);
   assert.equal(devices.selectedDeviceKey,null);
   const unselected=await relay.teslamon.command(authorized,{tool:'pause',args:{}});
   assert.notEqual(unselected.status,'observed');
   assert.equal(sentA.length+sentB.length,0);
   assert.equal((await relay.teslamon.select(authorized,keyA)).status,'selected');
   const paused=await relay.teslamon.command(authorized,{tool:'pause',args:{}});
   assert.equal(paused.status,'observed');
   assert.equal(paused.playbackPhase,'paused');
   const playing=await relay.teslamon.command(authorized,{tool:'resume',args:{}});
   assert.equal(playing.status,'observed');
   assert.equal(playing.playbackPhase,'playing');
   assert.equal(sentB.length,0);
   assert.deepEqual(sentA.slice(0,4),[
     'pause','get_player_state','resume','get_player_state'
   ]);
   const selectedB=await relay.teslamon.select(authorized,keyB);
   assert.equal(selectedB.status,'selected');
   const bPaused=await relay.teslamon.command(authorized,{tool:'pause',args:{}});
   assert.equal(bPaused.status,'observed');
   assert.equal(sentB.length,2);
   const played=await relay.teslamon.command(authorized,{
     tool:'search_and_play',args:{query:'Sample video'}
   });
   assert.equal(played.status,'accepted');
   assert.ok(sentB.includes('search_media'));
   assert.ok(sentB.includes('play_media'));
   // Revoke explicit browser availability and prove no queue/replay.
   b.ws.close();
   await eventually(()=>relay.devices().length===1);
   const commandCount=sentA.length+sentB.length;
   const stale=await relay.teslamon.command(authorized,{tool:'resume',args:{}});
   assert.notEqual(stale.status,'observed');
   assert.equal(sentA.length+sentB.length,commandCount);
 }finally{
   if(relay)await relay.close();
   await new Promise(resolve=>server.close(resolve));
   await fs.rm(dir,{recursive:true,force:true});
 }
});

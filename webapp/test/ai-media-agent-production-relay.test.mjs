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
function openBrowser(port,token,key,{label='iPhone YT Streamer',originHeader=origin,consent=true}={}){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket('ws://127.0.0.1:'+port+'/ai-agent/player',{
   headers:{origin:originHeader,'cf-access-jwt-assertion':token}});
  let live=false,paused=true;
  ws.on('open',()=>ws.send(JSON.stringify({kind:'hello',tab_key:key,label,consent})));
  ws.on('message',bytes=>{
   const data=JSON.parse(String(bytes));
   if(data.kind==='registered'){live=true;
    ws.send(JSON.stringify({kind:'heartbeat',state:pauseState}));
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
async function eventually(fn,limit=2000){
 const since=Date.now();while(Date.now()-since<limit){if(await fn())return;await new Promise(r=>setTimeout(r,25));}
 throw Error('condition_not_met');
}
test('production Access browser relay and one-call private controls select exact device, reconnect and queue safely',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yt-ai-prod-'));
 const server=http.createServer((_req,res)=>{res.writeHead(404);res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port;
 const relay=await startProductionMediaRelay({server,controlDir:dir,audience,jwksProvider:provider});
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
 const server=http.createServer((_req,res)=>res.end());
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const relay=await startProductionMediaRelay({server,controlDir:dir,audience,jwksProvider:provider});
 t.after(async()=>{await relay.close();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const port=server.address().port;
 for(const [token,requestOrigin] of [[jwt({aud:'wrong-app'}),origin],[jwt(),'https://evil.test']]){
  await assert.rejects(()=>openBrowser(port,token,randomUUID(),{originHeader:requestOrigin}));
 }
 assert.equal((await control(relay.socketPath,'list_devices')).result.devices.length,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {AgentSessionRegistry} from '../src/lib/ai-media-agent-session-registry.js';
import {openTeslaMonCommandLedger} from '../src/lib/teslamon-command-ledger.js';
import {createTeslaMonPrivateCoordinator} from '../src/lib/teslamon-coordinator.js';

const K=['11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'];
const C=['33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'];
const V=['AAAaa00000_','BBBbb11111_'];
const command=(id,name,args={})=>({
  jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}
});
async function demo(fn,{results=1,autoAck=true,timeoutMs=100,onSend,
  fullscreenAck='completed',stateTitle='Current media',
  audioObservation='element_playing_output_unverified'}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teslamon-compose-'));
  let ledger;
  try{
    ledger=await openTeslaMonCommandLedger({dir,timeoutMs:110});
    const proof=Object.freeze({});
    const active=new Map();
    const sent=[];
    const registry=new AgentSessionRegistry({
      ttlMs:45000,timeoutMs,
      authorizePairing:({principal,pairingProof})=>principal==='owner'&&pairingProof===proof
    });
    const peers=[];
    const subject='fixture-signed-user',controllerId='verified-controller';
    for(let i=0;i<2;i++){
      const state={media_id:V[0],title:stateTitle,playback_phase:'playing',
        fullscreen_kind:'none',audio_observation:audioObservation,secret:'DROP'};
      active.set(i,state);
      const connectionId=C[i];
      const device=registry.register({
        principal:'owner',pairingProof:proof,label:i===0?'selected':'decoy',
        connectionId,send:frame=>{
          sent.push({index:i,frame});
          onSend?.(frame);
          if(autoAck)queueMicrotask(()=>{
            if(frame.action==='play_media'){
              state.media_id=frame.args.media_id;state.playback_phase='playing';
            }else if(frame.action==='pause')state.playback_phase='paused';
            else if(frame.action==='resume')state.playback_phase='playing';
            else if(frame.action==='request_fullscreen'&&
              ['completed','accepted'].includes(fullscreenAck))
              state.fullscreen_kind='in_page';
            else if(frame.action==='exit_fullscreen')state.fullscreen_kind='none';
            registry.acknowledge({
              principal:'owner',deviceId:device.device_id,
              connectionId,commandId:frame.command_id,
              status:frame.action==='play_media'?'accepted':
                frame.action==='request_fullscreen'?fullscreenAck:'completed',
              state:{...state},
              result:frame.action==='search_media'?{
                results:V.slice(0,results).map((v,j)=>({
                  media_id:v,title:'Fixture '+(j+1),creator:'Test'
                }))
              }:undefined
            });
          });
          return true;
        }
      });
      peers.push({
        verified:true,origin:'https://stream.ameshalex.com',
        deviceId:device.device_id,deviceKey:K[i],connectionId,
        subject,controllerId,authExpiresAt:Date.now()+60000,
        tabConsent:true,explicitSelection:true
      });
    }
    let selected=0,override=null;
    const coordinator=createTeslaMonPrivateCoordinator({
      registry,ledger,
      readSelection:()=>override|| (selected===null?null:{...peers[selected]}),
      readController:()=>({
        verified:true,origin:'https://stream.ameshalex.com',subject,
        controllerId,authExpiresAt:Date.now()+60000
      }),
      readBrowser:id=>{
        const x=peers.find(p=>p.deviceId===id);
        return x?{
          verified:true,subject:x.subject,deviceId:x.deviceId,
          deviceKey:x.deviceKey,connectionId:x.connectionId,
          tabConsent:x.tabConsent
        }:null;
      }
    });
    const mcp=coordinator.createMcpHandler();
    const init=await mcp.handle({
      jsonrpc:'2.0',id:1,method:'initialize',
      params:{protocolVersion:'2025-11-25',capabilities:{},
        clientInfo:{name:'composed-teslamon-test',version:'1'}}
    });
    assert.equal(init.result.protocolVersion,'2025-11-25');
    await mcp.handle({jsonrpc:'2.0',method:'notifications/initialized'});
    const api={
      mcp,coordinator,ledger,sent,peers,registry,
      setSelected:i=>{selected=i;},
      revoke:()=>{override={...peers[selected??0],explicitSelection:false};},
      clearRevoke:()=>{override=null;},
      call:async(id,name,args={})=>
        (await mcp.handle(command(id,name,args))).result.structuredContent,
      rawCall:async(id,name,args={})=>mcp.handle(command(id,name,args))
    };
    await fn(api);
    mcp.close();
  }finally{
    if(ledger?.pending===0&&ledger.status==='open')await ledger.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
}

test('private MCP lists six tools and composes selected search/play with journal',async()=>{
  await demo(async x=>{
    const list=await x.mcp.handle({jsonrpc:'2.0',id:2,method:'tools/list'});
    assert.equal(list.result.tools.length,6);
    const result=await x.call(3,'search_and_play',{query:'one official trailer'});
    assert.equal(result.status,'observed');
    assert.equal(result.playbackPhase,'playing');
    assert.equal(result.fullscreenMode,'in_page');
    assert.equal(x.ledger.size,2);
    assert.deepEqual(x.sent.map(y=>y.frame.action),
      ['search_media','play_media','get_player_state','request_fullscreen',
        'get_player_state']);
    assert.ok(x.sent.every(y=>y.index===0));
  });
});

test('ambiguous result goes back through MCP and a token plays one selected result',async()=>{
  await demo(async x=>{
    const found=await x.call(3,'search_and_play',{query:'two trailers'});
    assert.equal(found.status,'needs_selection');
    assert.equal(found.choices.length,2);
    assert.ok(found.choices.every(y=>!('media_id'in y)));
    assert.deepEqual(x.sent.map(y=>y.frame.action),['search_media']);
    const chosen=await x.call(4,'search_and_play',{
      candidate_token:found.choices[1].candidate_token
    });
    assert.equal(chosen.status,'observed');
    assert.equal(chosen.playbackPhase,'playing');
    assert.equal(chosen.fullscreenMode,'in_page');
    assert.equal(x.sent[1].frame.args.media_id,V[1]);
    assert.equal(x.ledger.size,2);
    assert.equal((await x.call(5,'search_and_play',{
      candidate_token:found.choices[1].candidate_token
    })).status,'failed');
    assert.equal(x.ledger.size,2);
  },{results:2});
});

test('fullscreen user gesture outcome is journaled without downgrading playback',async()=>{
  await demo(async x=>{
    const result=await x.coordinator.executeIntent({
      ok:true,tool:'search_and_play',args:{query:'gesture trailer'},
      binding:x.peers[0],expiresAt:Date.now()+30000
    });
    assert.equal(result.status,'observed');
    assert.equal(result.playbackPhase,'playing');
    assert.equal(result.fullscreenMode,'unknown');
    assert.equal(result.fullscreenStatus,'needs_user_gesture');
    assert.equal(x.ledger.size,2);
    assert.deepEqual(x.sent.map(y=>y.frame.action),[
      'search_media','play_media','get_player_state','request_fullscreen'
    ]);
  },{fullscreenAck:'needs_user_gesture'});
});

test('playback state exposes only bounded snapshot metadata',async()=>{
  await demo(async x=>{
    const state=await x.call(3,'get_playback_state');
    assert.equal(state.status,'observed');
    assert.equal(state.mediaId,V[0]);
    assert.equal(state.title,'scriptalert(1)/script'+'T'.repeat(139));
    assert.equal(state.title.length,160);
    assert.ok(Number.isFinite(Date.parse(state.observedAt)));
    assert.equal(state.audioObservation,'element_playing_output_unverified');
    assert.equal('secret' in state,false);
  },{stateTitle:'<script>alert(1)</script>'+'T'.repeat(300)});
});

test('pause and resume prove state with readback; only mutations hit journal',async()=>{
  await demo(async x=>{
    const pause=await x.call(3,'pause');
    assert.equal(pause.status,'observed');
    assert.equal(pause.playbackPhase,'paused');
    const resume=await x.call(4,'resume');
    assert.equal(resume.status,'observed');
    assert.equal(resume.playbackPhase,'playing');
    const read=await x.call(5,'get_playback_state');
    assert.equal(read.status,'observed');
    assert.equal(read.playbackPhase,'playing');
    assert.equal(x.ledger.size,2);
    assert.deepEqual(x.sent.map(y=>y.frame.action),
      ['pause','get_player_state','resume','get_player_state','get_player_state']);
  });
});

test('fullscreen runs through exact tab and verifies entry and exit readback',async()=>{
  await demo(async x=>{
    const entered=await x.call(3,'request_fullscreen');
    assert.equal(entered.status,'observed');
    assert.equal(entered.fullscreenMode,'in_page');
    const exited=await x.call(4,'exit_fullscreen');
    assert.equal(exited.status,'observed');
    assert.equal(exited.fullscreenMode,'none');
    assert.deepEqual(x.sent.map(x=>x.frame.action),
      ['request_fullscreen','get_player_state','exit_fullscreen','get_player_state']);
    assert.equal(x.ledger.size,2);
  });
});

test('forbidden tools, arbitrary targeting and raw URLs never reach player',async()=>{
  await demo(async x=>{
    assert.equal((await x.rawCall(3,'shell')).result.isError,true);
    assert.equal((await x.call(4,'pause',{deviceKey:K[1]})).status,'failed');
    assert.equal((await x.call(5,'search_and_play',
      {media_url:'https://youtube.com/watch?v='+V[1]})).status,'failed');
    assert.equal(x.sent.length,0);
  });
});

test('no selected tab prevents MCP dispatch; does not fallback to sole online device',async()=>{
  await demo(async x=>{
    x.setSelected(null);
    x.registry.disconnect({deviceId:x.peers[1].deviceId,
      connectionId:x.peers[1].connectionId});
    const result=await x.call(3,'resume');
    assert.equal(result.status,'failed');
    assert.equal(x.sent.length,0);
  });
});

test('changing selection invalidates previously minted candidate token',async()=>{
  await demo(async x=>{
    const first=await x.call(3,'search_and_play',{query:'two videos'});
    x.setSelected(1);
    const reply=await x.call(4,'search_and_play',{
      candidate_token:first.choices[0].candidate_token
    });
    assert.equal(reply.status,'failed');
    assert.equal(x.sent.length,1);
    assert.equal(x.ledger.size,0);
  },{results:2});
});

test('revoked explicit selection stops new command, preserves old player',async()=>{
  await demo(async x=>{
    x.revoke();
    const result=await x.call(3,'pause');
    assert.equal(result.status,'failed');
    assert.equal(x.sent.length,0);
    assert.equal(x.ledger.size,0);
  });
});

test('timed-out mutation remains uncertain and blocks later different mutation ID',async()=>{
  await demo(async x=>{
    const first=await x.call(3,'pause');
    assert.equal(first.status,'uncertain');
    assert.equal(x.ledger.quarantined,true);
    const second=await x.call(4,'resume');
    assert.equal(second.status,'uncertain');
    assert.equal(second.code,'unreconciled_prior_mutation');
    assert.equal(x.sent.length,1);
  },{autoAck:false,timeoutMs:150});
});

test('coordinator forwards cancellation after search and never starts play',async()=>{
  const controller=new AbortController();
  await demo(async x=>{
    const peer=x.peers[0];
    const result=await x.coordinator.executeIntent({
      ok:true,tool:'search_and_play',args:{query:'search only'},
      binding:peer,expiresAt:Date.now()+30000
    },{signal:controller.signal});
    assert.equal(result.status,'cancelled');
    assert.deepEqual(x.sent.map(y=>y.frame.action),['search_media']);
    assert.equal(x.ledger.size,0);
  },{onSend:frame=>{
    if(frame.action==='search_media')controller.abort();
  }});
});

test('coordinator journals cancelled dispatched play as uncertain and never replays',async()=>{
  const controller=new AbortController();
  await demo(async x=>{
    const peer=x.peers[0];
    const result=await x.coordinator.executeIntent({
      ok:true,tool:'search_and_play',args:{query:'play once'},
      binding:peer,expiresAt:Date.now()+30000
    },{signal:controller.signal});
    assert.equal(result.status,'uncertain');
    assert.equal(x.ledger.quarantined,true);
    assert.equal(x.ledger.size,1);
    assert.deepEqual(x.sent.map(y=>y.frame.action),['search_media','play_media']);
  },{onSend:frame=>{
    if(frame.action==='play_media')controller.abort();
  }});
});

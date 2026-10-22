import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AgentSessionRegistry} from '../src/lib/ai-media-agent-session-registry.js';
import {createTeslaMonSelectedRelay} from '../src/lib/teslamon-selected-relay.js';
import {createTeslaMonCandidateService} from '../src/lib/teslamon-candidates.js';

const NOW=Date.parse('2026-10-22T17:00:00Z');
const KEY_A='11111111-1111-4111-8111-111111111111';
const KEY_B='22222222-2222-4222-8222-222222222222';
const CONN_A='33333333-3333-4333-8333-333333333333';
const CONN_B='44444444-4444-4444-8444-444444444444';
const VIDEO_A='AAAaa00000_';
const VIDEO_B='BBBbb11111_';
const getRequest=()=>({tool:'search_and_play',args:{query:'test trailer'}});
const selectToken=token=>({tool:'search_and_play',args:{candidate_token:token}});

function fixture({
  selectedIndex=0,results=[{media_id:VIDEO_A,title:'Good',creator:'Official'}],
  paused=false,autoAck=true
}={}){
  let now=NOW;
  const proof=Object.freeze({});
  const registry=new AgentSessionRegistry({
    now:()=>now,authorizePairing:({principal,pairingProof})=>
      principal==='owner'&&pairingProof===proof,
    ttlMs:45000,timeoutMs:45,rateLimit:90
  });
  const sent=[],players=new Map();
  const connected=[],registered=new Map();
  const verifiedController=Object.freeze({
    verified:true,origin:'https://stream.ameshalex.com',
    subject:'signed-owner',controllerId:'verified-controller',
    authExpiresAt:NOW+120000
  });
  function connect(index,connectionId){
    const label=index===0?'target':'decoy';
    const observed={media_id:VIDEO_A,playback_phase:paused?'paused':'playing',
      title:'Good'};
    players.set(index,observed);
    const device=registry.register({
      principal:'owner',pairingProof:proof,label,connectionId,
      send:frame=>{
        sent.push({index,frame});
        if(autoAck){
          queueMicrotask(()=>{
            const active=players.get(index);
            if(frame.action==='play_media'){
              active.media_id=frame.args.media_id;active.playback_phase='playing';
            }else if(frame.action==='pause')active.playback_phase='paused';
            else if(frame.action==='resume')active.playback_phase='playing';
            registry.acknowledge({
              principal:'owner',deviceId:device.device_id,connectionId,
              commandId:frame.command_id,status:
                frame.action==='play_media'?'accepted':'completed',
              state:{...active},result:frame.action==='search_media'?
                {results}:undefined
            });
          });
        }
        return true;
      }
    });
    const entry={index,deviceId:device.device_id,
      deviceKey:index===0?KEY_A:KEY_B,
      connectionId,subject:'signed-owner',
      controllerId:'verified-controller',
      authExpiresAt:now+120000,verified:true,
      origin:'https://stream.ameshalex.com',
      explicitSelection:true,tabConsent:true};
    connected[index]=entry;
    registered.set(entry.deviceId,Object.freeze({
      verified:true,subject:entry.subject,deviceId:entry.deviceId,
      deviceKey:entry.deviceKey,connectionId:entry.connectionId,
      tabConsent:true
    }));
    return entry;
  }
  connect(0,CONN_A);connect(1,CONN_B);
  let current=selectedIndex;
  const readSelection=()=>current===null?null:{...connected[current]};
  const relay=createTeslaMonSelectedRelay({
    registry,readSelection,readController:()=>verifiedController,
    readBrowser:deviceId=>registered.get(deviceId)||null,
    now:()=>now
  });
  const service=createTeslaMonCandidateService({
    getAuthority:relay.getAuthority,dispatch:relay.dispatch,clock:()=>now
  });
  const makeCommand=(action='pause',args={})=>({
    action,args,commandId:randomUUID(),
    binding:{
      origin:'https://stream.ameshalex.com',
      subject:'signed-owner',controllerId:'verified-controller',
      deviceKey:connected[current??0]?.deviceKey||KEY_A,
      connectionId:connected[current??0]?.connectionId||CONN_A
    },expiresAt:now+30000
  });
  return {
    registry,relay,service,sent,connected,players,makeCommand,
    updateSelection(change){Object.assign(connected[current??0],change);},
    setSelected(index){current=index;},
    get selected(){return current;},
    disconnect(index){
      return registry.disconnect({
        deviceId:connected[index].deviceId,
        connectionId:connected[index].connectionId
      });
    },
    reconnect(index){
      const previous=connected[index];
      registry.disconnect({deviceId:previous.deviceId,
        connectionId:previous.connectionId});
      return connect(index,randomUUID());
    },
    advance(ms){now+=ms;}
  };
}

test('real registry dispatches only to exact selected tab, never decoy',async()=>{
  const f=fixture();
  const result=await f.service.searchAndPlay(getRequest());
  assert.equal(result.status,'observed');
  assert.deepEqual(f.sent.map(x=>x.index),[0,0,0,0,0]);
  assert.deepEqual(f.sent.map(x=>x.frame.action),
    ['search_media','play_media','get_player_state','request_fullscreen','get_player_state']);
  assert.equal(f.sent[1].frame.args.media_id,VIDEO_A);
  assert.equal(f.sent.some(x=>x.index===1),false);
});

test('selected second tab also routes solely to second device',async()=>{
  const f=fixture({selectedIndex:1});
  const result=await f.service.searchAndPlay(getRequest());
  assert.equal(result.status,'observed');
  assert.deepEqual(f.sent.map(x=>x.index),[1,1,1,1,1]);
});

test('sole online tab cannot be inferred without explicit selected identity',async()=>{
  const f=fixture();
  f.setSelected(null);
  f.disconnect(1);
  assert.equal(await f.relay.getAuthority(),null);
  assert.equal((await f.service.searchAndPlay(getRequest())).status,'failed');
  assert.equal(f.sent.length,0);
});

test('mismatched verified principal/controller/device key or expired Access is denied',async()=>{
  for(const alteration of [
    {verified:false},{origin:'https://streamha.ameshalex.com'},
    {explicitSelection:false},{tabConsent:false},
    {subject:''},{controllerId:''},{deviceKey:KEY_B},
    {authExpiresAt:NOW-1},{connectionId:CONN_B}
  ]){
    const f=fixture();f.updateSelection(alteration);
    assert.equal(await f.relay.getAuthority(),null);
    assert.notEqual((await f.service.searchAndPlay(getRequest())).status,'observed');
    assert.equal(f.sent.length,0,JSON.stringify(alteration));
  }
});

test('unselected/foreign command binding cannot reach a different browser',async()=>{
  const f=fixture();
  for(const change of [
    {subject:'other'}, {controllerId:'other'},
    {deviceKey:KEY_B},{connectionId:CONN_B},
    {origin:'https://streamha.ameshalex.com'}
  ]){
    const cmd=f.makeCommand();cmd.binding={...cmd.binding,...change};
    const result=await f.relay.dispatch(cmd);
    assert.equal(result.status,'offline',JSON.stringify(change));
  }
  assert.equal(f.sent.length,0);
});

test('validated play arguments reject any arbitrary media URL or cross-player action',async()=>{
  const f=fixture();
  for(const [action,args] of [
    ['play_media',{media_id:'https://youtube.com/watch?v=AAAaa00000_'}],
    ['play_media',{media_id:'not-eleven'}],
    ['seek',{position_seconds:5}],
    ['stop',{}],
    ['pause',{target:'different-browser'}]
  ]){
    const result=await f.relay.dispatch(f.makeCommand(action,args));
    assert.equal(result.status,'failed');
  }
  assert.equal(f.sent.length,0);
});

test('real registry ACK supplies bounded readback and no audio guarantee',async()=>{
  const f=fixture();
  const result=await f.relay.dispatch(f.makeCommand('get_player_state'));
  assert.equal(result.status,'completed');
  assert.equal(result.state.media_id,VIDEO_A);
  assert.ok(Number.isFinite(Date.parse(result.state.observed_at)));
  assert.equal(result.state.observed_at,new Date(NOW).toISOString());
  assert.equal(result.state.audio_observation,undefined);
  assert.equal(f.sent.length,1);
});

test('registry commandId duplicate is never dispatched twice',async()=>{
  const f=fixture();
  const command=f.makeCommand('pause');
  const one=await f.relay.dispatch(command);
  assert.equal(one.status,'completed');
  const two=await f.relay.dispatch(command);
  assert.equal(two.status,'uncertain');
  assert.equal(two.code,'duplicate_command_id');
  assert.equal(f.sent.length,1);
});

test('selection switches between dispatch and response cannot claim success',async()=>{
  const f=fixture({autoAck:false});
  const command=f.makeCommand('pause');
  const pending=f.relay.dispatch(command);
  await new Promise(r=>setImmediate(r));
  assert.equal(f.sent.length,1);
  const record=f.sent[0];
  f.setSelected(1);
  const accepted=f.registry.acknowledge({
    principal:'owner',
    deviceId:f.connected[0].deviceId,
    connectionId:f.connected[0].connectionId,
    commandId:record.frame.command_id,status:'completed',
    state:{media_id:VIDEO_A,playback_phase:'paused'}
  });
  assert.equal(accepted,true);
  const result=await pending;
  assert.equal(result.status,'uncertain');
  assert.equal(result.code,'target_changed_after_dispatch');
  assert.equal(f.sent.length,1);
});

test('disconnected target and reconnect do not replay queued resume',async()=>{
  const f=fixture();
  const first=f.makeCommand('resume');
  f.disconnect(0);
  const after=await f.relay.dispatch(first);
  assert.equal(after.status,'offline');
  assert.equal(f.sent.length,0);
  f.reconnect(0);
  assert.equal(f.sent.length,0);
  const old=await f.relay.dispatch(first);
  assert.equal(old.status,'offline');
  assert.equal(f.sent.length,0);
});

test('candidate from previous connection cannot play after reconnect',async()=>{
  const f=fixture({results:[
    {media_id:VIDEO_A,title:'One'},
    {media_id:VIDEO_B,title:'Two'}
  ]});
  const search=await f.service.searchAndPlay(getRequest());
  assert.equal(search.status,'needs_selection');
  const token=search.choices[0].candidate_token;
  f.reconnect(0);
  const choice=await f.service.searchAndPlay(selectToken(token));
  assert.notEqual(choice.status,'observed');
  assert.equal(f.sent.length,1);
});

test('timeout remains uncertain and cannot become queued command on reconnection',async()=>{
  const f=fixture({autoAck:false});
  const command=f.makeCommand('resume');
  const response=await f.relay.dispatch(command);
  assert.equal(response.status,'uncertain');
  assert.equal(response.code,'timeout_uncertain');
  assert.equal(f.sent.length,1);
  f.reconnect(0);
  assert.equal(f.sent.length,1);
});


test('erroring identity/selection/browser resolvers fail closed without playback',async()=>{
  const f=fixture();
  for(const failed of ['readSelection','readController','readBrowser']){
    const readers={
      readSelection:()=>({...f.connected[0]}),
      readController:()=>({
        verified:true,origin:'https://stream.ameshalex.com',
        subject:'signed-owner',controllerId:'verified-controller',
        authExpiresAt:NOW+120000
      }),
      readBrowser:()=>({
        verified:true,subject:'signed-owner',
        deviceId:f.connected[0].deviceId,
        deviceKey:KEY_A,connectionId:CONN_A,tabConsent:true
      })
    };
    readers[failed]=()=>{throw Error('unavailable');};
    const adapter=createTeslaMonSelectedRelay({
      registry:f.registry,...readers,now:()=>NOW
    });
    assert.equal(await adapter.getAuthority(),null);
    const result=await adapter.dispatch(f.makeCommand('pause'));
    assert.equal(result.status,'offline');
  }
  assert.equal(f.sent.length,0);
});

test('registry dispatch exceptions surface as uncertain with no blind retry',async()=>{
  const f=fixture();
  const registry={
    connectionFor:(principal,id)=>f.registry.connectionFor(principal,id),
    dispatch:async()=>{throw Error('transport lost');}
  };
  const adapter=createTeslaMonSelectedRelay({
    registry,now:()=>NOW,
    readSelection:()=>({...f.connected[0]}),
    readController:()=>({
      verified:true,origin:'https://stream.ameshalex.com',
      subject:'signed-owner',controllerId:'verified-controller',
      authExpiresAt:NOW+120000
    }),
    readBrowser:()=>({
      verified:true,subject:'signed-owner',
      deviceId:f.connected[0].deviceId,deviceKey:KEY_A,
      connectionId:CONN_A,tabConsent:true
    })
  });
  const result=await adapter.dispatch(f.makeCommand('pause'));
  assert.equal(result.status,'uncertain');
  assert.equal(result.code,'registry_dispatch_failed');
  assert.equal(f.sent.length,0);
});

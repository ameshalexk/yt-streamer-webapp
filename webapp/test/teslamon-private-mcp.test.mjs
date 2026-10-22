import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createTeslaMonMcpHandler,TESLAMON_MCP_TOOLS} from '../src/lib/teslamon-private-mcp.js';

const NOW=1792670000000;
const auth=()=>({
  origin:'https://stream.ameshalex.com',subject:'fixture-owner',
  controllerId:'controller-1',deviceKey:'11111111-1111-4111-8111-111111111111',
  connectionId:'22222222-2222-4222-8222-222222222222',
  explicitSelection:true,tabConsent:true,authExpiresAt:NOW+90000
});
const msg=(id,method,params)=>({jsonrpc:'2.0',id,method,params});
const ack=c=>({
  commandId:c.commandId,subject:c.binding.subject,deviceKey:c.binding.deviceKey,
  connectionId:c.binding.connectionId,status:'observed',
  observedAt:NOW+75,playbackPhase:'paused',fullscreenMode:'none'
});
const fixture=(override={})=>{
  let count=0,id=0;
  const h=createTeslaMonMcpHandler({
    getAuthority:override.authority??auth,
    dispatch:override.dispatch??(async c=>{count++;return ack(c);}),
    executeIntent:override.executeIntent,
    clock:()=>NOW+50,
    makeId:()=>String(++id).padStart(8,'0')+'-3333-4333-8333-333333333333'
  });
  const start=async()=>{
    const init=await h.handle(msg(1,'initialize',{
      protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1'},
      capabilities:{}
    }));
    assert.equal(init.result.protocolVersion,'2025-11-25');
    await h.handle({jsonrpc:'2.0',method:'notifications/initialized'});
  };
  return {h,start,get count(){return count}};
};
const call=(id,name,args={})=>msg(id,'tools/call',{name,arguments:args});

test('handshake is mandatory; lists exactly six strict tools',async()=>{
  const f=fixture();
  assert.equal((await f.h.handle(msg(2,'tools/list'))).error.code,-32000);
  assert.equal((await f.h.handle(msg(3,'initialize',{
    protocolVersion:'invalid',clientInfo:{name:'x'}
  }))).error.code,-32602);
  await f.start();
  const tools=(await f.h.handle(msg(6,'tools/list'))).result.tools;
  assert.equal(tools.length,6);
  assert.deepEqual(tools.map(x=>x.name),TESLAMON_MCP_TOOLS.map(x=>x.name));
  for(const t of tools)assert.equal(t.inputSchema.additionalProperties,false);
  assert.equal((await f.h.handle(msg(4,'prompts/list'))).error.code,-32601);
  assert.equal((await f.h.handle(msg(5,'resources/list'))).error.code,-32601);
  f.h.close();
});

test('only explicit verified origin and tab can reach private dispatch',async()=>{
  for(const change of [
    {origin:'https://streamha.ameshalex.com'},
    {origin:'https://wrong.example'}, {explicitSelection:false},
    {tabConsent:false},{subject:''},{authExpiresAt:NOW-1}
  ]){
    let called=0;
    const f=fixture({
      authority:()=>({...auth(),...change}),
      dispatch:async c=>{called++;return ack(c);}
    });
    await f.start();
    const r=await f.h.handle(call(2,'pause'));
    assert.equal(r.result.isError,true);
    assert.equal(called,0);
    f.h.close();
  }
});

test('shell, file, device commands, URLs, and extra args are never dispatched',async()=>{
  let called=0;
  const f=fixture({dispatch:async c=>{called++;return ack(c);}});
  await f.start();
  let id=10;
  for(const name of ['shell','file_write','tesla_unlock','mac_control','stop']){
    const r=await f.h.handle(call(id++,name));
    assert.equal(r.result.isError,true);
  }
  for(const data of [
    {name:'pause',arguments:{deviceKey:'other'}},
    {name:'pause',arguments:{owner:'wrong'}},
    {name:'search_and_play',arguments:{query:'title',target:'other'}},
    {name:'search_and_play',arguments:{media_url:'https://bad.example'}},
    {name:'search_and_play',arguments:{query:'title',candidate_token:'A'.repeat(24)}},
    {name:'pause',arguments:[],secret:'bad'}
  ]){
    const r=await f.h.handle(msg(id++,'tools/call',data));
    assert.equal(r.result?.isError===true || Boolean(r.error),true);
  }
  assert.equal(called,0);
  f.h.close();
});

test('only correlated current readback qualifies as observed',async()=>{
  const good=fixture();
  await good.start();
  const p=await good.h.handle(call(2,'pause'));
  assert.equal(p.result.structuredContent.status,'observed');
  assert.equal(p.result.structuredContent.playbackPhase,'paused');
  good.h.close();
  for(const patch of [
    {status:'accepted'}, {status:'uncertain'},
    {subject:'other'}, {deviceKey:'different'},{connectionId:'stale'},
    {observedAt:NOW-200000},{fullscreenMode:'fantasy'}
  ]){
    const f=fixture({dispatch:async c=>({...ack(c),...patch})});
    await f.start();
    const r=await f.h.handle(call(2,'get_playback_state'));
    assert.equal(r.result.structuredContent.observed,
      patch.status==='accepted'||patch.status==='uncertain'?false:undefined);
    if(patch.status!=='accepted'&&patch.status!=='uncertain'){
      assert.equal(r.result.structuredContent.status,'uncertain');
      assert.equal(r.result.isError,true);
    }
    f.h.close();
  }
});

test('identical RPC id cannot repeat playback and conflict is rejected',async()=>{
  let effects=0;
  const f=fixture({dispatch:async c=>{effects++;return ack(c);}});
  await f.start();
  const first=await f.h.handle(call(2,'resume'));
  const again=await f.h.handle(call(2,'resume'));
  assert.deepEqual(first,again);
  assert.equal(effects,1);
  assert.equal((await f.h.handle(call(2,'pause'))).error.code,-32600);
  assert.equal(effects,1);
  f.h.close();
});

test('concurrent mutations are serialized and cancel does not claim rollback',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  let effects=0;
  const f=fixture({dispatch:async c=>{effects++;await gate;return ack(c);}});
  await f.start();
  const first=f.h.handle(call(2,'resume'));
  await new Promise(resolve=>setImmediate(resolve));
  const concurrent=await f.h.handle(call(3,'pause'));
  assert.equal(concurrent.result.structuredContent.code,'target_busy');
  await f.h.handle({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:2}});
  release();
  const result=await first;
  assert.equal(result.result.structuredContent.status,'uncertain');
  assert.equal(result.result.structuredContent.code,'cancelled_after_dispatch');
  assert.equal(effects,1);
  f.h.close();
});

test('unrelated cancellation request cannot cancel someone else\'s command',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture({dispatch:async c=>{await gate;return ack(c);}});
  await f.start();
  const active=f.h.handle(call(2,'pause'));
  await new Promise(resolve=>setImmediate(resolve));
  await f.h.handle({jsonrpc:'2.0',method:'notifications/cancelled',
    params:{requestId:999}});
  release();
  const result=await active;
  assert.equal(result.result.structuredContent.status,'observed');
  f.h.close();
});

test('actual child-process stdio MCP protocol with synthetic target',async()=>{
  const script=fileURLToPath(new URL('./fixtures/teslamon-private-mcp-fixture.mjs',import.meta.url));
  const child=spawn(process.execPath,[script],{stdio:['pipe','pipe','pipe']});
  const waiting=new Map();
  const lines=createInterface({input:child.stdout});
  lines.on('line',text=>{
    const response=JSON.parse(text);
    const done=waiting.get(response.id);
    if(done){waiting.delete(response.id);done(response);}
  });
  const send=(data)=>new Promise(resolve=>{
    waiting.set(data.id,resolve);
    child.stdin.write(JSON.stringify(data)+'\n');
  });
  try{
    const init=await send(msg(1,'initialize',{
      protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1'},capabilities:{}
    }));
    assert.equal(init.result.serverInfo.name,'teslamon-private-playback-fixture');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    assert.equal((await send(msg(2,'tools/list'))).result.tools.length,6);
    const result=await send(call(3,'pause'));
    assert.equal(result.result.structuredContent.status,'observed');
    assert.equal((await send(call(4,'shell'))).result.isError,true);
  }finally{
    child.stdin.end();
    const exit=new Promise(resolve=>child.once('exit',resolve));
    await Promise.race([exit,new Promise(resolve=>setTimeout(()=>{child.kill();resolve()},1800))]);
    lines.close();
  }
});


test('coordinator responses cannot spoof playback or expose arbitrary results',async()=>{
  const replies=[
    {status:'observed',observed:true,playbackPhase:'speaker_confirmed'},
    {status:'needs_selection',choices:[{
      candidate_token:'A'.repeat(32),title:'Ok',creator:'Channel'
    },{candidate_token:'B'.repeat(32),title:'Bad',creator:'bad\ncreator'}]},
    {status:'secret_success',privateToken:'DO-NOT-EXPOSE'}
  ];
  for(const reply of replies){
    const f=fixture({executeIntent:async()=>reply});
    await f.start();
    const r=await f.h.handle(call(2,'pause'));
    assert.equal(r.result.structuredContent.status,'uncertain');
    assert.equal(r.result.isError,true);
    assert.equal(JSON.stringify(r).includes('DO-NOT-EXPOSE'),false);
    f.h.close();
  }
});

test('coordinator exposes bounded fullscreen status while playback remains observed',async()=>{
  for(const fullscreenStatus of [
    'observed','needs_user_gesture','unsupported','uncertain','failed','cancelled'
  ]){
    const f=fixture({executeIntent:async()=>({
      status:'observed',observed:true,playbackPhase:'playing',
      fullscreenMode:'unknown',fullscreenStatus,
      mediaId:'AAAaa00000_',title:'Trusted title',
      observedAt:new Date(NOW).toISOString(),
      audioObservation:'element_playing_output_unverified',privateField:'DROP'
    })});
    await f.start();
    const result=await f.h.handle(call(2,'search_and_play',{query:'play this'}));
    assert.deepEqual(result.result.structuredContent,{
      status:'observed',observed:true,playbackPhase:'playing',
      fullscreenMode:'unknown',fullscreenStatus,mediaId:'AAAaa00000_',
      title:'Trusted title',observedAt:new Date(NOW).toISOString(),
      audioObservation:'element_playing_output_unverified'
    });
    assert.equal(result.result.isError,undefined);
    f.h.close();
  }
});

test('coordinator metadata sanitizer bounds and drops executable or arbitrary fields',async()=>{
  const f=fixture({executeIntent:async()=>({
    status:'observed',observed:true,playbackPhase:'playing',fullscreenMode:'native',
    mediaId:'bad<script>',title:'<script>alert(1)</script>'+'T'.repeat(300),
    observedAt:'not-a-time',audioObservation:'javascript:alert(1)',privateField:'DROP'
  })});
  await f.start();
  const result=await f.h.handle(call(2,'search_and_play',{query:'metadata'}));
  const value=result.result.structuredContent;
  assert.equal(value.status,'observed');
  assert.equal(value.mediaId,undefined);
  assert.equal(value.title,'scriptalert(1)/script'+'T'.repeat(139));
  assert.equal(value.title.length,160);
  assert.doesNotMatch(value.title,/[<>]/);
  assert.equal(value.observedAt,undefined);
  assert.equal(value.audioObservation,undefined);
  assert.equal(value.privateField,undefined);
  assert.equal(JSON.stringify(result).includes('DROP'),false);
  f.h.close();
});

test('unexpected coordinator failure is uncertain, never definitive failed',async()=>{
  const f=fixture({executeIntent:async()=>{throw Error('private sensitive');}});
  await f.start();
  const r=await f.h.handle(call(2,'resume'));
  assert.equal(r.result.structuredContent.status,'uncertain');
  assert.equal(r.result.structuredContent.code,'private_dispatch_uncertain');
  assert.equal(JSON.stringify(r).includes('private sensitive'),false);
  f.h.close();
});

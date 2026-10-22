import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTeslaMonCodexProtocolDriver,getTeslaMonCodexRuntimeAvailability,
  startTeslaMonCodexRuntime,submitTeslaMonCodexRuntime
} from '../src/lib/teslamon-codex-runtime.js';
import {TESLAMON_TOOLS} from '../src/lib/teslamon-contract.js';

class FakeTransport{
  listener=null;sent=[];closed=false;onTurnStart=null;onTurnStartBeforeResponse=null;onThreadStart=null;
  subscribe(listener){this.listener=listener;return ()=>{this.listener=null;};}
  async send(message){
    this.sent.push(message);
    if(message.method==='initialize')this.emit({id:message.id,result:{}});
    if(message.method==='thread/resume')this.emit({id:message.id,result:{thread:{id:message.params.threadId}}});
    if(message.method==='thread/start'){
      this.threadCounter=(this.threadCounter??0)+1;
      this.lastThreadStart=message.params;
      const result={id:message.id,result:{thread:{id:`thread-${this.threadCounter}`}}};
      if(this.onThreadStart){await this.onThreadStart({message,result,transport:this});return;}
      this.emit(result);
    }
    if(message.method==='turn/start'){
      this.turnCounter=(this.turnCounter??0)+1;
      const turnId=`turn-${this.turnCounter}`;
      const started={id:message.id,result:{turn:{id:turnId,status:'inProgress'}}};
      if(this.onTurnStartBeforeResponse)
        await this.onTurnStartBeforeResponse({threadId:message.params.threadId,turnId,transport:this});
      this.emit(started);
      this.emit({method:'turn/started',params:{threadId:message.params.threadId,
        turn:{id:turnId,status:'inProgress'}}});
      this.onTurnStart?.({threadId:message.params.threadId,turnId,transport:this});
    }
    if(message.method==='turn/interrupt'){
      this.lastInterrupt=message.params;this.emit({id:message.id,result:{}});
    }
  }
  emit(message){this.listener?.(message);}
  complete(threadId,turnId,status='completed'){
    this.emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status}}});
  }
  async close(){this.closed=true;}
}
const ctx=(patch={})=>({ownerId:'owner-1',controllerId:'controller-1',
  targetGeneration:'generation-1',cwd:'/tmp/teslamon-test',model:'gpt-6.1-sol',...patch});
const make=(overrides={})=>{
  const transport=overrides.transport??new FakeTransport();
  const calls=[];
  const driver=createTeslaMonCodexProtocolDriver({transport,
    dispatchPlayback:async(call,opts)=>{calls.push({call,opts});return {status:'accepted'};},
    clock:()=>1000,rpcTimeoutMs:overrides.rpcTimeoutMs??300,turnTimeoutMs:overrides.turnTimeoutMs??1000,
    interruptGraceMs:100
  });
  return {transport,driver,calls};
};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('product availability is permanently fail-closed without an external verified mechanism',async()=>{
  assert.deepEqual(getTeslaMonCodexRuntimeAvailability(),{
    available:false,code:'runtime_confinement_unverified'
  });
  assert.deepEqual(await startTeslaMonCodexRuntime(),{ok:false,code:'runtime_confinement_unverified'});
  assert.deepEqual(await submitTeslaMonCodexRuntime(),{ok:false,code:'runtime_confinement_unverified'});
});

test('driver performs initialize handshake and starts a persistent thread with exactly six playback tools',async()=>{
  const f=make();
  assert.deepEqual(await f.driver.initialize(),{ok:true});
  assert.equal(f.transport.sent[0].method,'initialize');
  assert.equal(f.transport.sent[0].params.capabilities.experimentalApi,true);
  assert.deepEqual(f.transport.sent[1],{method:'initialized',params:{}});
  assert.equal(f.driver.initialized,true);
  const started=await f.driver.ensureContext(ctx());
  assert.equal(started.ok,true);
  assert.equal(f.transport.lastThreadStart.ephemeral,false);
  assert.equal(f.transport.lastThreadStart.sandbox,'read-only');
  assert.equal(f.transport.lastThreadStart.approvalPolicy,'never');
  const dyn=f.transport.lastThreadStart.dynamicTools;
  assert.equal(dyn.length,1);assert.equal(dyn[0].name,'teslamon');
  assert.deepEqual(dyn[0].tools.map(t=>t.name),TESLAMON_TOOLS);
  assert.equal(dyn[0].tools.length,6);
  assert.deepEqual(await f.driver.ensureContext(ctx()),{ok:true,threadId:'thread-1',reused:true});
  assert.equal(f.transport.sent.filter(m=>m.method==='thread/start').length,1);
  f.driver.close();
});

test('model tool request routes only an exact valid playback call and bounds call count',async()=>{
  const f=make();await f.driver.initialize();const c=ctx();
  await f.driver.ensureContext(c);
  f.transport.onTurnStart=({threadId,turnId,transport})=>{
    for(let i=0;i<7;i++)transport.emit({id:`tool-${i}`,method:'item/tool/call',params:{
      threadId,turnId,callId:`call-${i}`,namespace:'teslamon',tool:'pause',arguments:{}}});
    setImmediate(()=>transport.complete(threadId,turnId));
  };
  const result=await f.driver.submit(c,'pause');
  assert.equal(result.status,'completed');
  await flush();
  assert.equal(f.calls.length,6);
  const rejected=f.transport.sent.find(m=>m.id==='tool-6');
  assert.equal(rejected.result.success,false);
  assert.equal(JSON.parse(rejected.result.contentItems[0].text).code,'invalid_or_excess_tool_call');
  f.driver.close();
});

test('unsupported server requests, namespaces, tools and invalid arguments never dispatch',async()=>{
  const f=make();await f.driver.initialize();const c=ctx();await f.driver.ensureContext(c);
  f.transport.onTurnStart=({threadId,turnId,transport})=>{
    transport.emit({id:'shell-1',method:'command/exec',params:{command:['echo','unsafe']}});
    for(const [id,namespace,tool,args] of [
      ['wrong-ns','other','pause',{}],['wrong-tool','teslamon','shell',{}],
      ['extra-arg','teslamon','pause',{deviceKey:'forged'}]
    ])transport.emit({id,method:'item/tool/call',params:{threadId,turnId,callId:id,namespace,tool,arguments:args}});
    setImmediate(()=>transport.complete(threadId,turnId));
  };
  await f.driver.submit(c,'please pause');await flush();
  assert.equal(f.calls.length,0);
  const denied=f.transport.sent.filter(m=>m.error?.code===-32601);
  assert.equal(denied.length,1);
  f.driver.close();
});

test('contexts are isolated by owner/controller/target generation and target change retires old thread',async()=>{
  const f=make();await f.driver.initialize();
  await f.driver.ensureContext(ctx());
  await f.driver.ensureContext(ctx({ownerId:'owner-2'}));
  await f.driver.ensureContext(ctx({controllerId:'controller-2'}));
  await f.driver.ensureContext(ctx({targetGeneration:'generation-2'}));
  assert.equal(f.driver.contextCount,3);
  assert.equal(f.transport.sent.filter(m=>m.method==='thread/start').length,4);
  f.driver.invalidate({ownerId:'owner-1',controllerId:'controller-1'});
  assert.equal(f.driver.contextCount,2);
  f.driver.close();
});

test('one active turn per context; timeout interrupts and drops context without replay',async()=>{
  const f=make({turnTimeoutMs:1000});await f.driver.initialize();const c=ctx();
  await f.driver.ensureContext(c);
  f.transport.onTurnStart=()=>{};
  const first=f.driver.submit(c,'pause',{timeoutMs:1000});
  await flush();
  assert.deepEqual(await f.driver.submit(c,'resume'),{ok:false,code:'turn_already_active'});
  const timed=await first;
  assert.deepEqual(timed,{ok:false,code:'turn_timeout_uncertain'});
  assert.deepEqual(f.transport.lastInterrupt,{threadId:'thread-1',turnId:'turn-1'});
  assert.equal(f.driver.contextCount,0);
  assert.equal(f.transport.sent.filter(m=>m.method==='turn/start').length,1);
  f.driver.close();
});

test('explicit cancellation interrupts and does not automatically submit the turn again',async()=>{
  const f=make();await f.driver.initialize();const c=ctx();await f.driver.ensureContext(c);
  f.transport.onTurnStart=()=>{};
  const abort=new AbortController();
  const request=f.driver.submit(c,'resume',{signal:abort.signal});
  await flush();abort.abort();
  assert.deepEqual(await request,{ok:false,code:'turn_cancelled_uncertain'});
  assert.equal(f.transport.sent.filter(m=>m.method==='turn/interrupt').length,1);
  assert.equal(f.transport.sent.filter(m=>m.method==='turn/start').length,1);
  assert.equal(f.driver.contextCount,0);
  f.driver.close();
});

test('turns reuse a context after normal completion; transport failure closes without replay',async()=>{
  const f=make();await f.driver.initialize();const c=ctx();await f.driver.ensureContext(c);
  f.transport.onTurnStart=({threadId,turnId,transport})=>setImmediate(()=>transport.complete(threadId,turnId));
  assert.equal((await f.driver.submit(c,'pause')).status,'completed');
  assert.equal((await f.driver.ensureContext(c)).threadId,'thread-1');
  assert.equal(f.transport.sent.filter(m=>m.method==='thread/start').length,1);
  f.transport.onTurnStart=()=>{};
  f.transport.send=async message=>{
    if(message.method==='turn/start'){f.transport.sent.push(message);throw new Error('fixture transport failed');}
    await FakeTransport.prototype.send.call(f.transport,message);
  };
  const result=await f.driver.submit(c,'resume');
  assert.deepEqual(result,{ok:false,code:'turn_start_failed'});
  assert.equal(f.driver.contextCount,0);
  assert.equal(f.transport.sent.filter(m=>m.method==='turn/start').length,2);
  f.driver.close();
});


test('persisted thread id resumes the same Codex thread across driver instances',async()=>{
  const store=new Map();
  const storeApi={get:key=>store.get(key)??null,set:(key,id)=>store.set(key,id),delete:key=>store.delete(key)};
  const first=make();
  const d1=createTeslaMonCodexProtocolDriver({transport:first.transport,threadStore:storeApi,
    dispatchPlayback:async()=>({status:'accepted'})});
  await d1.initialize();
  const started=await d1.ensureContext(ctx());
  assert.equal(started.threadId,'thread-1');
  d1.close();
  assert.equal(store.size,1);
  const secondTransport=new FakeTransport();
  const d2=createTeslaMonCodexProtocolDriver({transport:secondTransport,threadStore:storeApi,
    dispatchPlayback:async()=>({status:'accepted'})});
  await d2.initialize();
  const resumed=await d2.ensureContext(ctx());
  assert.equal(resumed.threadId,'thread-1');
  assert.equal(resumed.resumed,true);
  assert.equal(secondTransport.sent.filter(m=>m.method==='thread/start').length,0);
  assert.equal(secondTransport.sent.filter(m=>m.method==='thread/resume').length,1);
  d2.invalidate({ownerId:'owner-1',controllerId:'controller-1'});
  assert.equal(store.size,0);
  d2.close();
});


test('concurrent same-context starts coalesce instead of creating two persistent threads',async()=>{
  const f=make();await f.driver.initialize();
  const pair=await Promise.all([f.driver.ensureContext(ctx()),f.driver.ensureContext(ctx())]);
  assert.equal(pair[0].threadId,pair[1].threadId);
  assert.equal(f.transport.sent.filter(m=>m.method==='thread/start').length,1);
  f.driver.close();
});

test('transport crash fails active turn uncertain, drops its reference and never replays',async()=>{
  const f=make();await f.driver.initialize();const c=ctx();await f.driver.ensureContext(c);
  f.transport.onTurnStart=()=>setImmediate(()=>f.transport.emit(new Error('fixture crash')));
  const result=await f.driver.submit(c,'pause');
  assert.deepEqual(result,{status:'uncertain',code:'transport_closed',turnId:'turn-1'});
  assert.equal(f.driver.contextCount,0);
  assert.equal(f.transport.closed,true);
  assert.equal(f.transport.sent.filter(m=>m.method==='turn/start').length,1);
  f.driver.close();
});

test('server request with an ID colliding with pending turn/start RPC is not resolved as its response',async()=>{
  const f=make();await f.driver.initialize();const c=ctx();await f.driver.ensureContext(c);
  f.transport.onTurnStart=({threadId,turnId,transport})=>{
    transport.emit({id:3,method:'item/tool/call',params:{threadId,turnId,
      callId:'collision-call',namespace:'teslamon',tool:'pause',arguments:{}}});
    setImmediate(()=>transport.complete(threadId,turnId));
  };
  const result=await f.driver.submit(c,'pause');
  assert.equal(result.status,'completed');
  assert.equal(f.transport.sent.filter(m=>m.method==='turn/start').length,1);
  assert.equal(f.calls.length,1);
  assert.equal(f.transport.sent.filter(m=>m.id===3&&m.result?.contentItems).length,1);
  f.driver.close();
});

test('stale turn/completed event cannot finish the current turn',async()=>{
  const f=make();await f.driver.initialize();const c=ctx();await f.driver.ensureContext(c);
  let starts=0,secondDone=false,activeTurn=null;
  f.transport.onTurnStart=({threadId,turnId,transport})=>{
    starts++;
    if(starts===1)setImmediate(()=>transport.complete(threadId,turnId));
    else{
      activeTurn={threadId,turnId};
      transport.complete(threadId,'turn-1');
    }
  };
  assert.equal((await f.driver.submit(c,'first')).status,'completed');
  const second=f.driver.submit(c,'second');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(secondDone,false);
  f.transport.complete(activeTurn.threadId,activeTurn.turnId);
  const secondResult=await second;secondDone=true;
  assert.equal(secondDone,true);
  assert.equal(secondResult.turnId,'turn-2');
  assert.equal(f.transport.sent.filter(m=>m.method==='turn/start').length,2);
  f.driver.close();
});

test('concurrent submissions admit one turn and reject the competing request',async()=>{
  const f=make();await f.driver.initialize();const c=ctx();await f.driver.ensureContext(c);
  f.transport.onTurnStart=({threadId,turnId,transport})=>setImmediate(()=>transport.complete(threadId,turnId));
  const [a,b]=await Promise.all([f.driver.submit(c,'pause'),f.driver.submit(c,'resume')]);
  assert.equal([a,b].filter(x=>x.status==='completed').length,1);
  assert.equal([a,b].filter(x=>x.code==='turn_already_active').length,1);
  assert.equal(f.transport.sent.filter(m=>m.method==='turn/start').length,1);
  f.driver.close();
});


test('pre-aborted submit sends neither thread creation nor turn start',async()=>{
  const f=make();await f.driver.initialize();const abort=new AbortController();abort.abort();
  assert.deepEqual(await f.driver.submit(ctx(),'pause',{signal:abort.signal}),
    {ok:false,code:'turn_cancelled_before_start'});
  assert.equal(f.transport.sent.some(m=>m.method==='thread/start'),false);
  assert.equal(f.transport.sent.some(m=>m.method==='turn/start'),false);
  f.driver.close();
});

test('abort during turn/start waits for the late exact turn ID and interrupts it',async()=>{
  const f=make();await f.driver.initialize();const c=ctx();await f.driver.ensureContext(c);
  let started;const entered=new Promise(resolve=>{started=resolve;});let release;
  const gate=new Promise(resolve=>{release=resolve;});
  f.transport.onTurnStartBeforeResponse=async({turnId})=>{started(turnId);await gate;};
  const abort=new AbortController();
  const request=f.driver.submit(c,'pause',{signal:abort.signal});
  const turnId=await entered;abort.abort();
  assert.deepEqual(await request,{ok:false,code:'turn_start_cancelled_uncertain'});
  release();await flush();await flush();
  assert.deepEqual(f.transport.lastInterrupt,{threadId:'thread-1',turnId});
  assert.equal(f.transport.sent.filter(m=>m.method==='turn/start').length,1);
  assert.equal(f.transport.sent.filter(m=>m.method==='turn/interrupt').length,1);
  assert.equal(f.driver.contextCount,0);
  f.driver.close();
});

test('new target generation prevents a late old thread start from publishing or persisting',async()=>{
  const store=new Map();const storeApi={get:key=>store.get(key)??null,set:(key,id)=>store.set(key,id),delete:key=>store.delete(key)};
  const f=make();const driver=createTeslaMonCodexProtocolDriver({transport:f.transport,
    dispatchPlayback:async()=>({status:'accepted'}),threadStore:storeApi,rpcTimeoutMs:1000});
  await driver.initialize();let releaseOld,enteredOld;
  const oldEntered=new Promise(resolve=>{enteredOld=resolve;});
  const oldGate=new Promise(resolve=>{releaseOld=resolve;});
  f.transport.onThreadStart=async({message,result,transport})=>{
    if(message.params.cwd==='/tmp/teslamon-test'){
      enteredOld();await oldGate;
    }
    transport.emit(result);
  };
  const oldPromise=driver.ensureContext(ctx());await oldEntered;
  const fresh=await driver.ensureContext(ctx({targetGeneration:'generation-2',cwd:'/tmp/fresh'}));
  assert.equal(fresh.ok,true);assert.equal(fresh.threadId,'thread-2');
  releaseOld();
  assert.deepEqual(await oldPromise,{ok:false,code:'target_generation_changed'});
  assert.equal(driver.contextCount,1);assert.equal(store.size,1);
  assert.equal([...store.values()][0],'thread-2');
  driver.close();
});

test('close invalidates a pending thread creation before it can publish',async()=>{
  const store=new Map();const storeApi={get:key=>store.get(key)??null,set:(key,id)=>store.set(key,id),delete:key=>store.delete(key)};
  const f=make();const driver=createTeslaMonCodexProtocolDriver({transport:f.transport,
    dispatchPlayback:async()=>({status:'accepted'}),threadStore:storeApi});
  await driver.initialize();let release,enteredResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  f.transport.onThreadStart=async({result,transport})=>{enteredResolve();await gate;transport.emit(result);};
  const creating=driver.ensureContext(ctx());await entered;driver.close();release();
  const result=await creating;
  assert.deepEqual(result,{ok:false,code:'runtime_closed'});
  assert.equal(driver.contextCount,0);assert.equal(store.size,0);assert.equal(f.transport.closed,true);
});

test('invalidate during pending turn/start interrupts the exact late turn and drops context',async()=>{
  const f=make();await f.driver.initialize();const c=ctx();await f.driver.ensureContext(c);
  let release,enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  f.transport.onTurnStartBeforeResponse=async({turnId})=>{enteredResolve(turnId);await gate;};
  const request=f.driver.submit(c,'pause');const turnId=await entered;
  assert.equal(f.driver.invalidate({ownerId:c.ownerId,controllerId:c.controllerId,
    targetGeneration:c.targetGeneration}),1);
  assert.deepEqual(await request,{ok:false,code:'turn_start_cancelled_uncertain'});
  release();await flush();await flush();
  assert.deepEqual(f.transport.lastInterrupt,{threadId:'thread-1',turnId});
  assert.equal(f.driver.contextCount,0);
  f.driver.close();
});


test('concurrent initialize handshakes are serialized',async()=>{
  const f=make();
  const [first,second]=await Promise.all([f.driver.initialize(),f.driver.initialize()]);
  assert.equal(first.ok,true);
  assert.deepEqual(second,{ok:false,code:'initialization_in_progress'});
  assert.equal(f.transport.sent.filter(m=>m.method==='initialize').length,1);
  assert.equal(f.driver.initialized,true);
  f.driver.close();
});

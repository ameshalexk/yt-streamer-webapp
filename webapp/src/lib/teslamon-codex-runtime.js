// Transport-neutral Codex App Server protocol driver for TeslaMon.
// This module does NOT spawn Codex, load credentials, or make a model request.
// Product activation remains fail-closed until App Server can prove that every
// non-TeslaMon capability is excluded. Do not wire the driver directly to HTTP.
import {randomUUID} from 'node:crypto';
import {TESLAMON_TOOLS,validateTeslaMonIntent} from './teslamon-contract.js';

const NAMESPACE='teslamon';
const MAX_TOOL_CALLS_PER_TURN=6;
const MAX_CONTEXTS=64;
const MAX_OUTPUT_CHARS=8000;
const isPlain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
  (Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
const failure=code=>Object.freeze({ok:false,code});
const errorRpc=(id,code,message)=>({id,error:{code,message}});
const toolSpecs=Object.freeze(TESLAMON_TOOLS.map(name=>Object.freeze({
  type:'function',name,description:`TeslaMon playback action: ${name.replaceAll('_',' ')}.`,
  inputSchema:Object.freeze({type:'object',additionalProperties:false,
    ...(name==='search_and_play'?{properties:{
      query:{type:'string',minLength:2,maxLength:160},
      candidate_token:{type:'string',pattern:'^[A-Za-z0-9_-]{16,96}$'}
    },oneOf:[{required:['query']},{required:['candidate_token']}]}:{properties:{}})
  })
})));
const dynamicTools=Object.freeze([Object.freeze({
  type:'namespace',name:NAMESPACE,description:'Six bounded TeslaMon playback actions.',
  tools:toolSpecs
})]);

/** Public product gate: no caller-controlled override exists. */
export function getTeslaMonCodexRuntimeAvailability(){
  return Object.freeze({available:false,code:'runtime_confinement_unverified'});
}
export async function startTeslaMonCodexRuntime(){
  return failure('runtime_confinement_unverified');
}
export async function submitTeslaMonCodexRuntime(){
  return failure('runtime_confinement_unverified');
}

/**
 * Protocol driver only. The injected transport must implement send(message),
 * subscribe(listener) -> unsubscribe, and close(). It never starts a process.
 * `dispatchPlayback` is a server-owned callback, not a model tool registry.
 * This driver is deliberately not a product activation API.
 */
export function createTeslaMonCodexProtocolDriver({
  transport,dispatchPlayback,threadStore,clock=Date.now,makeId=randomUUID,
  rpcTimeoutMs=5000,turnTimeoutMs=45000,interruptGraceMs=1500
}={}){
  if(!transport||typeof transport.send!=='function'||
    typeof transport.subscribe!=='function'||typeof transport.close!=='function'||
    typeof dispatchPlayback!=='function'||typeof clock!=='function'||
    typeof makeId!=='function'||(threadStore!==undefined&&
      (!isPlain(threadStore)||typeof threadStore.get!=='function'||
       typeof threadStore.set!=='function'||typeof threadStore.delete!=='function')))
    throw new TypeError('codex_protocol_dependencies_required');
  const localThreadStore=new Map();
  const threads=threadStore??{
    get:key=>localThreadStore.get(key)??null,
    set:(key,id)=>localThreadStore.set(key,id),
    delete:key=>localThreadStore.delete(key)
  };
  if(!Number.isSafeInteger(rpcTimeoutMs)||rpcTimeoutMs<100||rpcTimeoutMs>30000||
    !Number.isSafeInteger(turnTimeoutMs)||turnTimeoutMs<1000||turnTimeoutMs>120000||
    !Number.isSafeInteger(interruptGraceMs)||interruptGraceMs<100||interruptGraceMs>5000)
    throw new TypeError('invalid_runtime_deadlines');

  let closed=false,initialized=false,initializing=false,acknowledged=false,nextId=0;
  const contexts=new Map(),pending=new Map(),contextStarts=new Map();
  let unsubscribe;
  const rpc=(method,params,timeout=rpcTimeoutMs)=>new Promise((resolve,reject)=>{
    if(closed)return reject(new Error('transport_closed'));
    const id=++nextId;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('rpc_timeout'));},timeout);
    pending.set(id,{resolve,reject,timer});
    Promise.resolve(transport.send({id,method,params})).catch(error=>{
      const p=pending.get(id);if(!p)return;pending.delete(id);clearTimeout(timer);
      p.reject(error);
    });
  });
  const resolveRpc=(message)=>{
    const p=pending.get(message.id);if(!p)return false;
    pending.delete(message.id);clearTimeout(p.timer);
    if(message.error)p.reject(new Error('rpc_rejected'));
    else p.resolve(message.result);
    return true;
  };
  const syncStoreResult=value=>{
    if(value&&typeof value.then==='function')throw new TypeError('thread_store_must_be_synchronous');
    return value;
  };
  const contextKey=c=>JSON.stringify([c.ownerId,c.controllerId,c.targetGeneration]);
  const validateContext=c=>isPlain(c)&&
    typeof c.ownerId==='string'&&c.ownerId.length>0&&c.ownerId.length<=256&&
    typeof c.controllerId==='string'&&c.controllerId.length>0&&c.controllerId.length<=128&&
    (typeof c.targetGeneration==='string'&&c.targetGeneration.length>0&&c.targetGeneration.length<=128||Number.isSafeInteger(c.targetGeneration))&&
    typeof c.cwd==='string'&&c.cwd.startsWith('/')&&c.cwd.length<=2048&&!/[\x00-\x1f\x7f]/.test(c.cwd)&&
    typeof c.model==='string'&&c.model.length>0&&c.model.length<=128&&!/[\x00-\x1f\x7f]/.test(c.model);
  const sendToolReply=(id,success,text)=>transport.send({id,result:{success,
    contentItems:[{type:'inputText',text:text.slice(0,MAX_OUTPUT_CHARS)}]}});
  const rejectServerRequest=message=>transport.send(errorRpc(message.id,-32601,'method_not_allowed'));

  async function handleMessage(message){
    if(!isPlain(message))return;
    if(!Object.hasOwn(message,'method')&&Object.hasOwn(message,'id')&&
      (Object.hasOwn(message,'result')||Object.hasOwn(message,'error'))&&resolveRpc(message))return;
    if(typeof message.method!=='string')return;
    // The only accepted server-initiated request is the exact playback callback.
    if(Object.hasOwn(message,'id')){
      if(message.method!=='item/tool/call')return rejectServerRequest(message);
      const p=message.params;
      if(!isPlain(p)||typeof p.threadId!=='string'||p.threadId.length>256||
        typeof p.turnId!=='string'||p.turnId.length>256||
        typeof p.callId!=='string'||p.callId.length<1||p.callId.length>128||
        p.namespace!==NAMESPACE||
        !TESLAMON_TOOLS.includes(p.tool))
        return sendToolReply(message.id,false,'{"status":"failed","code":"tool_not_allowed"}');
      const context=[...contexts.values()].find(c=>c.threadId===p.threadId);
      const intent=validateTeslaMonIntent({tool:p.tool,args:p.arguments});
      const active=context?.active;
      if(context&&active)await active.startReady;
      if(!context||context.closed||!active||context.active!==active||
        context.abortController?.signal.aborted||context.activeTurnId!==p.turnId||
        !intent.ok||context.toolCalls>=MAX_TOOL_CALLS_PER_TURN||context.seenCallIds.has(p.callId))
        return sendToolReply(message.id,false,'{"status":"failed","code":"invalid_or_excess_tool_call"}');
      context.toolCalls++;context.seenCallIds.add(p.callId);
      try{
        const output=await dispatchPlayback(Object.freeze({
          tool:p.tool,args:intent.args,
          ownerId:context.ownerId,controllerId:context.controllerId,
          targetGeneration:context.targetGeneration
        }),{signal:context.abortController.signal});
        const text=JSON.stringify(output);
        if(typeof text!=='string'||text.length>MAX_OUTPUT_CHARS)
          return sendToolReply(message.id,false,'{"status":"uncertain","code":"invalid_tool_output"}');
        return sendToolReply(message.id,true,text);
      }catch{
        return sendToolReply(message.id,false,'{"status":"uncertain","code":"tool_dispatch_uncertain"}');
      }
    }
    if(message.method==='turn/started'&&isPlain(message.params?.turn)){
      // Record but do not authorize from this event: the turn/start RPC response
      // is the authority. Tool calls arriving before that response wait on startReady.
      const context=[...contexts.values()].find(c=>c.threadId===message.params.threadId);
      if(context?.active)context.active.startedNotificationId=message.params.turn.id;
      return;
    }
    if(message.method==='turn/completed'&&isPlain(message.params?.turn)){
      const turn=message.params.turn;
      const context=[...contexts.values()].find(c=>c.threadId===message.params.threadId);
      if(context?.active&&context.activeTurnId===turn.id){context.active.resolve({
        status:turn.status==='completed'?'completed':turn.status,
        turnId:turn.id,completedAt:clock()
      });}
      return;
    }
    if(message.method==='server/closed'||message.method==='transport/closed')failTransport();
  }
  unsubscribe=transport.subscribe(message=>{
    if(message instanceof Error){failTransport();return;}
    void handleMessage(message).catch(()=>{});
  });

  function closeContext(c,reason='context_closed'){
    if(c.closed)return;c.closed=true;c.abortController?.abort();
    const wasActive=Boolean(c.active);
    if(c.activeTurnId)void rpc('turn/interrupt',{threadId:c.threadId,turnId:c.activeTurnId},interruptGraceMs).catch(()=>{});
    if(reason!=='runtime_closed'||wasActive){try{syncStoreResult(threads.delete(c.key));}catch{}}
    if(c.active){
      c.active.resolveStartReady(false);
      c.active.resolve({status:'uncertain',code:reason,turnId:c.activeTurnId??null});
      c.active.cancel?.('cancelled');
      c.active=null;
    }
    contexts.delete(c.key);
  }
  function closeAll(reason){for(const c of [...contexts.values()])closeContext(c,reason);}
  function failTransport(){
    if(closed)return;closed=true;closeAll('transport_closed');
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('transport_closed'));}
    pending.clear();unsubscribe?.();void transport.close();
  }

  async function initialize(){
    if(initialized&&acknowledged)return {ok:true};
    if(initializing)return failure('initialization_in_progress');
    if(closed)return failure('transport_closed');
    initializing=true;
    try{
      await rpc('initialize',{clientInfo:{name:'teslamon',title:'TeslaMon',version:'0.1.0'},
        capabilities:{experimentalApi:true}});
      initialized=true;
      await transport.send({method:'initialized',params:{}});
      acknowledged=true;
      return {ok:true};
    }catch{return failure('app_server_initialize_failed');}
    finally{initializing=false;}
  }

  async function ensureContext(input){
    if(closed)return failure('transport_closed');
    if(!initialized||!acknowledged)return failure('app_server_not_initialized');
    if(!validateContext(input))return failure('invalid_context');
    const key=contextKey(input),prior=contexts.get(key);
    if(prior&&!prior.closed)return {ok:true,threadId:prior.threadId,reused:true};
    const starting=contextStarts.get(key);
    if(starting)return starting.promise;
    if(contexts.size+contextStarts.size>=MAX_CONTEXTS)return failure('runtime_context_limit');
    // A newer selected-target generation invalidates both published contexts and
    // pending starts for this same owner/controller before they can publish.
    for(const c of [...contexts.values()])if(c.ownerId===input.ownerId&&
      c.controllerId===input.controllerId&&c.targetGeneration!==input.targetGeneration)
      closeContext(c,'target_generation_changed');
    for(const start of contextStarts.values())if(start.ownerId===input.ownerId&&
      start.controllerId===input.controllerId&&start.targetGeneration!==input.targetGeneration)
      retireStart(start,'target_generation_changed');
    const record={key,ownerId:input.ownerId,controllerId:input.controllerId,
      targetGeneration:input.targetGeneration,invalidated:false,reason:null,promise:null};
    contextStarts.set(key,record);
    record.promise=Promise.resolve().then(async()=>{
      try{
        if(closed||record.invalidated)return failure(record.reason??'context_invalidated');
        const persistedId=syncStoreResult(threads.get(key));
        if(persistedId!==null&&persistedId!==undefined&&
          (typeof persistedId!=='string'||persistedId.length<1||persistedId.length>256||/[\x00-\x1f\x7f]/.test(persistedId)))
          return failure('invalid_persisted_thread_id');
        let result;
        if(typeof persistedId==='string'&&persistedId.length>0){
          result=await rpc('thread/resume',{threadId:persistedId,excludeTurns:true});
        }else{
          result=await rpc('thread/start',{
            model:input.model,cwd:input.cwd,approvalPolicy:'never',sandbox:'read-only',
            ephemeral:false,dynamicTools
          });
        }
        const threadId=result?.thread?.id;
        if(typeof threadId!=='string'||!threadId||threadId.length>256||/[\x00-\x1f\x7f]/.test(threadId))
          return failure(persistedId?'thread_resume_failed':'thread_start_failed');
        if(closed||record.invalidated||contextStarts.get(key)!==record)
          return failure(record.reason??'context_invalidated');
        // Store and publish synchronously after the final generation/close check.
        syncStoreResult(threads.set(key,threadId));
        if(closed||record.invalidated||contextStarts.get(key)!==record){
          try{syncStoreResult(threads.delete(key));}catch{}
          return failure(record.reason??'context_invalidated');
        }
        contexts.set(key,{key,ownerId:input.ownerId,controllerId:input.controllerId,
          targetGeneration:input.targetGeneration,threadId,active:null,activeTurnId:null,
          toolCalls:0,seenCallIds:new Set(),abortController:null,closed:false});
        return {ok:true,threadId,reused:false,resumed:typeof persistedId==='string'&&persistedId.length>0};
      }catch{return failure(record.reason??'thread_start_failed');}
      finally{if(contextStarts.get(key)===record)contextStarts.delete(key);}
    });
    return record.promise;
  }

  function retireStart(record,reason='context_invalidated'){
    if(!record||record.invalidated)return false;
    record.invalidated=true;record.reason=reason;
    if(contextStarts.get(record.key)===record)contextStarts.delete(record.key);
    return true;
  }

  async function submit(input,text,{signal,timeoutMs=turnTimeoutMs}={}){
    if(signal?.aborted)return failure('turn_cancelled_before_start');
    if(closed)return failure('transport_closed');
    if(typeof text!=='string'||text.length<1||text.length>4000)return failure('invalid_input');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)
      return failure('invalid_turn_deadline');
    const ready=await ensureContext(input);
    if(signal?.aborted)return failure('turn_cancelled_before_start');
    if(closed)return failure('transport_closed');
    if(!ready.ok)return ready;
    const context=contexts.get(contextKey(input));
    if(!context||context.closed)return failure('context_invalidated');
    if(context.active)return failure('turn_already_active');
    context.toolCalls=0;context.seenCallIds.clear();context.abortController=new AbortController();
    const active={resolve:null,promise:null,resolveStartReady:null,startReady:null};
    active.promise=new Promise(resolve=>{active.resolve=resolve;});
    active.startReady=new Promise(resolve=>{active.resolveStartReady=resolve;});
    context.active=active;context.activeTurnId=null;
    let turnId=null,timer,abortListener;
    const interrupted=new Promise(resolve=>{
      active.cancel=resolve;
      timer=setTimeout(()=>resolve('timeout'),timeoutMs);
      if(signal){abortListener=()=>resolve('cancelled');signal.addEventListener('abort',abortListener,{once:true});}
    });
    try{
      const startRequest=rpc('turn/start',{threadId:context.threadId,input:[{type:'text',text}],
        approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}})
        .then(value=>({kind:'started',value}),()=>({kind:'failed'}));
      const startOutcome=await Promise.race([startRequest,interrupted]);
      if(startOutcome==='timeout'||startOutcome==='cancelled'){
        context.abortController.abort();
        closeContext(context,startOutcome==='timeout'?'turn_start_timeout_uncertain':'turn_start_cancelled_uncertain');
        // If App Server eventually acknowledges the start, interrupt the exact
        // turn ID. Never reuse this context or replay the input.
        void startRequest.then(outcome=>{
          const lateTurnId=outcome.kind==='started'?outcome.value?.turn?.id:null;
          if(typeof lateTurnId==='string')return rpc('turn/interrupt',{
            threadId:context.threadId,turnId:lateTurnId
          },interruptGraceMs).catch(()=>{});
        });
        return failure(startOutcome==='timeout'?'turn_start_timeout_uncertain':'turn_start_cancelled_uncertain');
      }
      if(startOutcome.kind==='failed'){
        closeContext(context,'turn_start_failed');return failure('turn_start_failed');
      }
      if(context.closed||context.abortController.signal.aborted){
        closeContext(context,'turn_context_invalidated_uncertain');
        return failure('turn_context_invalidated_uncertain');
      }
      turnId=startOutcome.value?.turn?.id;
      if(typeof turnId!=='string'||!turnId){closeContext(context,'missing_turn_id');return failure('turn_start_failed');}
      context.activeTurnId=turnId;active.resolveStartReady(true);
      const done=await Promise.race([active.promise,interrupted]);
      if(done==='timeout'||done==='cancelled'){
        context.abortController.abort();
        // closeContext sends one best-effort interrupt and drops the context.
        // Never resume/replay a turn with an uncertain outcome.
        closeContext(context,done==='timeout'?'turn_timeout_uncertain':'turn_cancelled_uncertain');
        return failure(done==='timeout'?'turn_timeout_uncertain':'turn_cancelled_uncertain');
      }
      return done;
    }catch{
      if(contexts.has(context.key))closeContext(context,'turn_transport_uncertain');
      return failure(turnId?'turn_transport_uncertain':'turn_start_failed');
    }finally{
      clearTimeout(timer);if(signal&&abortListener)signal.removeEventListener('abort',abortListener);
      if(!context.closed){context.active=null;context.activeTurnId=null;context.abortController=null;}
    }
  }

  function invalidate({ownerId,controllerId,targetGeneration}={}){
    let count=0;
    for(const c of [...contexts.values()])if(
      (ownerId===undefined||c.ownerId===ownerId)&&
      (controllerId===undefined||c.controllerId===controllerId)&&
      (targetGeneration===undefined||c.targetGeneration===targetGeneration)){
      closeContext(c,'context_invalidated');count++;
    }
    for(const start of [...contextStarts.values()])if(
      (ownerId===undefined||start.ownerId===ownerId)&&
      (controllerId===undefined||start.controllerId===controllerId)&&
      (targetGeneration===undefined||start.targetGeneration===targetGeneration))
      if(retireStart(start,'context_invalidated'))count++;
    return count;
  }
  function close(){
    if(closed)return;closed=true;
    for(const start of [...contextStarts.values()])retireStart(start,'runtime_closed');
    closeAll('runtime_closed');
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('runtime_closed'));}
    pending.clear();unsubscribe?.();void transport.close();
  }
  return Object.freeze({initialize,ensureContext,submit,invalidate,close,
    get contextCount(){return contexts.size;},get initialized(){return initialized&&acknowledged;}});
}

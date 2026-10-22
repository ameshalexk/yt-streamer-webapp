// TeslaMon isolated MCP stdio transport. No YT Streamer/prod connection here.
// Runtime integrator MUST supply an authenticated relay-derived authority
// snapshot and private dispatcher. Neither is exposed as a model tool.
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {
  TESLAMON_TOOLS, validateTeslaMonIntent, bindTeslaMonCommand,
  validateTeslaMonObservation
} from './teslamon-contract.js';

const PROTOCOL='2025-11-25';
const PLAIN=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&
  (Object.getPrototypeOf(o)===Object.prototype||Object.getPrototypeOf(o)===null);
const allow=(o,keys)=>Object.keys(o).every(k=>keys.includes(k));
const rpcError=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
const rpcResult=(id,result)=>({jsonrpc:'2.0',id,result});
const asContent=(data,isError=false)=>({
  content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,
  ...(isError?{isError:true}:{})
});
const NO_ARGS=Object.freeze({type:'object',properties:{},additionalProperties:false});
const SEARCH_ARGS=Object.freeze({
  type:'object',
  properties:{
    query:{type:'string',minLength:2,maxLength:160},
    candidate_token:{type:'string',pattern:'^[A-Za-z0-9_-]{16,96}$'}
  },
  additionalProperties:false,
  oneOf:[{required:['query']},{required:['candidate_token']}]
});
const DESCRIPTIONS=Object.freeze({
  search_and_play:'Search an existing YouTube path or play one scoped prior search candidate. No arbitrary URL.',
  pause:'Pause the explicitly selected authorized YT Streamer player.',
  resume:'Resume the explicitly selected authorized YT Streamer player.',
  get_playback_state:'Read timestamped playback/fullscreen status of selected player.',
  request_fullscreen:'Ask selected player to enter fullscreen; browser activation may be required.',
  exit_fullscreen:'Ask selected player to exit fullscreen.'
});
export const TESLAMON_MCP_TOOLS=Object.freeze(TESLAMON_TOOLS.map(name=>Object.freeze({
  name,title:name.replaceAll('_',' '),description:DESCRIPTIONS[name],
  inputSchema:name==='search_and_play'?SEARCH_ARGS:NO_ARGS
})));
const serializeId=id=>JSON.stringify(id);

export function createTeslaMonMcpHandler({
  getAuthority, dispatch, clock=Date.now, makeId=randomUUID,
  responseTtlMs=60000,maxCompleted=128
}={}){
  if(typeof getAuthority!=='function'||typeof dispatch!=='function'||
    typeof clock!=='function'||typeof makeId!=='function')
    throw new TypeError('private_authority_and_dispatch_required');
  let initialized=false,acknowledged=false,closed=false;
  let active=null;
  const completed=new Map();
  const inflight=new Map();
  const cleanup=()=>{
    for(const [id,item] of completed)if(clock()-item.at>responseTtlMs)completed.delete(id);
    while(completed.size>maxCompleted)completed.delete(completed.keys().next().value);
  };
  async function callTool(params,rpcId){
    if(!PLAIN(params)||!allow(params,['name','arguments'])||
      typeof params.name!=='string')
      return rpcError(rpcId,-32602,'invalid_tool_parameters');
    const intent=validateTeslaMonIntent({tool:params.name,args:params.arguments??{}});
    if(!intent.ok)return rpcResult(rpcId,asContent({status:'failed',code:intent.error},true));
    if(active)return rpcResult(rpcId,asContent({status:'failed',code:'target_busy'},true));
    const controller=new AbortController();
    active={controller,rpcId};
    try{
      // A login string, target id or generation supplied through params is NEVER trusted.
      // getAuthority must extract current verification from a server-side relay.
      const authority=await getAuthority({signal:controller.signal});
      if(controller.signal.aborted)return rpcResult(rpcId,asContent({status:'cancelled'},true));
      const command=bindTeslaMonCommand(intent,authority,{
        commandId:makeId(),now:clock()
      });
      if(!command.ok)return rpcResult(rpcId,asContent({status:'failed',code:command.error},true));
      const reply=await dispatch(command,{signal:controller.signal});
      if(controller.signal.aborted)
        return rpcResult(rpcId,asContent({status:'uncertain',code:'cancelled_after_dispatch'},true));
      const observed=validateTeslaMonObservation(reply,command,clock());
      if(!observed.ok)
        return rpcResult(rpcId,asContent({status:'uncertain',code:observed.error},true));
      return rpcResult(rpcId,asContent({
        status:observed.status,observed:observed.observed,
        commandId:command.commandId,
        ...(observed.observed?{
          playbackPhase:observed.playbackPhase,
          fullscreenMode:observed.fullscreenMode,
          observedAt:observed.observedAt
        }:{})
      },['failed','offline','cancelled','uncertain'].includes(observed.status)));
    }catch{
      // Do not print exception detail: errors can contain private model/target data.
      return rpcResult(rpcId,asContent({status:'failed',code:'private_dispatch_failed'},true));
    }finally{
      if(active?.controller===controller)active=null;
    }
  }
  async function handle(message){
    if(closed)return null;
    if(!PLAIN(message)||message.jsonrpc!=='2.0')return rpcError(null,-32600,'invalid_request');
    const id=message.id;
    const hasId=typeof id==='string'||(Number.isSafeInteger(id)&&id>=0);
    const method=message.method;
    if(typeof method!=='string')return rpcError(hasId?id:null,-32600,'invalid_method');
    if(method==='notifications/cancelled'){
      if(active&&message.params?.requestId===active.rpcId)active.controller.abort();
      return null;
    }
    if(method==='notifications/initialized'){
      if(initialized)acknowledged=true;
      return null;
    }
    if(!hasId)return null;
    cleanup();
    const key=serializeId(id),fingerprint=JSON.stringify([method,message.params]);
    const done=completed.get(key);
    if(done)return done.fingerprint===fingerprint?
      done.reply:rpcError(id,-32600,'reused_rpc_id_with_different_request');
    const busy=inflight.get(key);
    if(busy)return busy.fingerprint===fingerprint?
      busy.promise:rpcError(id,-32600,'reused_rpc_id_with_different_request');
    const promise=(async()=>{
      if(method==='initialize'){
        if(initialized)return rpcError(id,-32600,'already_initialized');
        const p=message.params;
        if(!PLAIN(p)||!['2025-11-25','2025-06-18'].includes(p.protocolVersion)||
          !PLAIN(p.clientInfo))
          return rpcError(id,-32602,'invalid_initialize');
        initialized=true;
        return rpcResult(id,{protocolVersion:PROTOCOL,
          capabilities:{tools:{listChanged:false}},
          serverInfo:{name:'teslamon-private-playback-fixture',version:'0.1.0'}});
      }
      if(!initialized||!acknowledged)return rpcError(id,-32000,'not_initialized');
      if(method==='ping')return rpcResult(id,{});
      if(method==='tools/list')return rpcResult(id,{tools:TESLAMON_MCP_TOOLS});
      if(method==='tools/call')return callTool(message.params,id);
      return rpcError(id,-32601,'method_not_found');
    })();
    inflight.set(key,{fingerprint,promise});
    try{
      const reply=await promise;
      completed.set(key,{fingerprint,reply,at:clock()});
      cleanup();
      return reply;
    }finally{inflight.delete(key);}
  }
  return Object.freeze({
    handle,
    close(){closed=true;active?.controller.abort();inflight.clear();completed.clear();},
    get initialized(){return initialized&&acknowledged;}
  });
}

/** MCP stdio uses exactly one UTF-8 JSON-RPC frame per line; no HTTP listener. */
export async function serveTeslaMonMcpStdio(handler,{input=process.stdin,output=process.stdout}={}){
  if(!handler||typeof handler.handle!=='function')throw new TypeError('handler_required');
  const lines=createInterface({input,crlfDelay:Infinity});
  let pending=new Set();
  try{
    for await(const line of lines){
      if(Buffer.byteLength(line,'utf8')>16384){
        output.write(JSON.stringify(rpcError(null,-32700,'oversize_frame'))+'\n');
        continue;
      }
      let request;
      try{request=JSON.parse(line);}catch{
        output.write(JSON.stringify(rpcError(null,-32700,'parse_error'))+'\n');
        continue;
      }
      const task=Promise.resolve(handler.handle(request)).then(reply=>{
        if(reply!==null)output.write(JSON.stringify(reply)+'\n');
      }).catch(()=>{
        output.write(JSON.stringify(rpcError(null,-32603,'internal_error'))+'\n');
      });
      pending.add(task);
      void task.finally(()=>pending.delete(task));
    }
    await Promise.allSettled([...pending]);
  }finally{handler.close?.();}
}

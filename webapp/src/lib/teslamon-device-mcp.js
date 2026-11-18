// Authenticated, narrow Home Assistant MCP command adapter. Signed,
// allowlisted intent can execute immediately; no generic MCP tool names or
// arguments are ever forwarded. Mac Control retains click confirmation.
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';

const SDK_PARENT=path.join(os.homedir(),'Documents/Codex/2026-09-22/home-assistant-ai-agnostic/package.json');
const ENTITY=/^[a-z0-9_]{1,40}\.[a-z0-9_]{1,100}$/;
const ROOM=/^[\p{L}\p{N}_() '\-]{2,70}$/u;
const SESSION=/^[a-f0-9-]{36}$/i;
const IDENTITY=/^[a-f0-9]{64}$/;
const WRITES=new Set(['light_on','light_off','area_light_on','area_light_off',
  'switch_on','switch_off','fan_on','fan_off','thermostat_temp']);
const normalize=value=>String(value||'').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,180);
function safeResult(result){
  if(result.isError===true)return null;
  let data=result.structuredContent;
  if(!data){try{data=JSON.parse(result.content?.find(part=>part.type==='text')?.text||'null')}catch{return null;}}
  if(!data||data.success===false||data.isError)return null;
  return data;
}
export async function callHA(name,args,{transportFactory}={}){
  if(!['search_entities','get_entity_state','list_areas','control_light',
    'control_switch_fan','control_climate'].includes(name))throw Error('disallowed_mcp_tool');
  let c;
  try{
    let create=transportFactory;
    if(!create){
      const require=createRequire(SDK_PARENT);
      const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
      const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const {CallToolResultSchema}=require('@modelcontextprotocol/sdk/types.js');
      create=()=>({client:new Client({name:'teslamon-home-gateway',version:'1.0.0'}),
        transport:new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3848/mcp')),
        schema:CallToolResultSchema});
    }
    const pair=create();c=pair.client;
    await c.connect(pair.transport);
    // The installed provider advertises an optional output schema that this
    // SDK's automatic validator cannot parse. Validate the normal MCP
    // CallToolResult envelope and the narrow fields we actually consume.
    const answer=await c.request({method:'tools/call',params:{name,arguments:args}},
      pair.schema,{timeout:12000});
    const parsed=safeResult(answer);
    if(!parsed)throw Error('home_assistant_call_failed');
    return parsed;
  }finally{try{await c?.close()}catch{}}
}
export function createHACommandService({planner,call=callHA}={}){
  if(!planner?.plan||typeof call!=='function')throw Error('service_requires_planner');
  async function findEntity(target,domain,{allowAmbiguous=false}={}){
    const exact=ENTITY.test(target)?target.toLowerCase():null;
    if(exact){if(domain && !exact.startsWith(domain+'.'))return {error:'invalid_entity_domain'};
      return {id:exact};}
    const r=await call('search_entities',{query:target,...(domain?{domain}:{}),limit:12});
    const items=(Array.isArray(r.items)?r.items:[]).filter(item=>ENTITY.test(item.entity_id)&&
      (!domain||item.entity_id.startsWith(domain+'.')));
    if(items.length===1&&!r.has_more)return {id:items[0].entity_id,name:normalize(items[0].friendly_name)};
    if(allowAmbiguous)return {items};
    return {error:items.length===0?'entity_not_found':'ambiguous_entity',
      message:'Please use an exact Home Assistant entity ID.'};
  }
  const fmtItems=items=>items.slice(0,8).map(item=>
    `${normalize(item.friendly_name||item.entity_id)} (${item.entity_id}): ${normalize(item.state)}`).join('; ');
  async function read(plan){
    if(plan.op==='areas'){
      const res=await call('list_areas',{});
      const data=Array.isArray(res.items)?res.items:Array.isArray(res.areas)?res.areas:[];
      return {status:'ok',message:data.slice(0,15).map(a=>normalize(a.name||a.area_id)).join(', ')||'No areas found'};
    }
    if(!['state','search'].includes(plan.op))return {status:'unsupported',code:'unsupported_device_command'};
    const found=await findEntity(plan.target,null,{allowAmbiguous:true});
    if(found.id){
      const res=await call('get_entity_state',{entity_id:found.id});
      // Only safe scalar state fields. Never return attributes, tokens or raw tool payload.
      const item=res.entity||res;
      return {status:'ok',message:`${normalize(item.friendly_name||found.id)}: ${normalize(item.state)}${item.unit_of_measurement?' '+normalize(item.unit_of_measurement):''}`};
    }
    if(found.items?.length===1&&!plan.target.startsWith('light.')){
      const id=found.items[0].entity_id;
      const res=await call('get_entity_state',{entity_id:id});
      const item=res.entity||res;
      return {status:'ok',message:`${normalize(item.friendly_name||found.items[0].friendly_name||id)}: ${normalize(item.state)}`};
    }
    if(!found.items?.length)return {status:'failed',code:'entity_not_found'};
    return {status:'ok',message:fmtItems(found.items)+(found.items.length===8?' (more available)':'')};
  }
  async function plan(text,session,identity,{signal}={}){
    if(!SESSION.test(session)||!IDENTITY.test(identity))return {status:'failed',code:'invalid_device_request'};
    const result=await planner.plan(text,{signal});
    if(result.status!=='ok')return result;
    try{
      if(!WRITES.has(result.op))return await read(result);
      let name,args,targetSummary;
      if(['area_light_on','area_light_off'].includes(result.op)){
        if(!ROOM.test(result.target))return {status:'failed',code:'invalid_area'};
        name='control_light';targetSummary=`lights in ${result.target}`;
        args={area:result.target,action:result.op.endsWith('_on')?'turn_on':'turn_off'};
      }else if(['light_on','light_off','switch_on','switch_off','fan_on','fan_off'].includes(result.op)){
        const domain=result.op.split('_')[0];
        const match=await findEntity(result.target,domain);
        if(match.error)return {status:'failed',code:match.error,message:match.message};
        targetSummary=match.name||match.id;
        const action=result.op.endsWith('_on')?'turn_on':'turn_off';
        if(domain==='light'){name='control_light';args={entity_id:match.id,action};}
        else{name='control_switch_fan';args={domain,entity_id:match.id,action};}
      }else if(result.op==='thermostat_temp'){
        const match=await findEntity(result.target,'climate');
        if(match.error)return {status:'failed',code:match.error,message:match.message};
        name='control_climate';targetSummary=match.name||match.id;
        args={entity_id:match.id,action:'set_temperature',temperature:result.value};
      }else return {status:'unsupported',code:'unsupported_device_command'};
      const label=result.op==='thermostat_temp'?`Set ${targetSummary} to ${result.value}°F`:
        `${args.action==='turn_on'?'Turn on':'Turn off'} ${targetSummary}`;
      // The upstream HA MCP still requires confirm:true, but owner consent
      // is given by the authenticated, narrowly scoped hands-free command.
      // Do not create a browser approval token or wait for an extra tap.
      const applied=await call(name,{...args,confirm:true});
      if(applied?.success===false)return {status:'failed',code:'device_change_not_confirmed'};
      return {status:'ok',message:`${label} — completed`};
    }catch{return {status:'unavailable',code:'home_assistant_unavailable'};}
  }
  return Object.freeze({plan});
}

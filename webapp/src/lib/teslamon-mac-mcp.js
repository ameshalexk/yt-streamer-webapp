// Strict Mac Control MCP façade for Grok/Aura. No terminal, filesystem,
// messages, browser navigation, credentials, or arbitrary MCP names.
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const SDK_PARENT=path.join(os.homedir(),'Documents/Codex/2026-09-22/home-assistant-ai-agnostic/package.json');
const SESSION=/^[a-f0-9-]{36}$/i;
const IDENTITY=/^[a-f0-9]{64}$/;
const LABEL=/^[a-zA-Z0-9_.-]{3,120}$/;
const APPS=['Safari','Google Chrome','Finder','Notes','Calendar','Music','Photos','Preview','TextEdit'];
const appName=value=>APPS.find(name=>name.toLowerCase()===String(value).trim().toLowerCase());
const clean=value=>String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,100);
const ALLOWED_TOOLS=new Set(['system_info','network_status','window_list','app_is_installed',
  'launchd_status','app_open','window_focus']);
export async function callMac(name,args,{transportFactory}={}){
  if(!ALLOWED_TOOLS.has(name))throw Error('disallowed_mac_tool');
  let client;
  try{
    let create=transportFactory;
    if(!create){
      const require=createRequire(SDK_PARENT);
      const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
      const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const {CallToolResultSchema}=require('@modelcontextprotocol/sdk/types.js');
      create=()=>({client:new Client({name:'teslamon-limited-mac-client',version:'1.0.0'}),
        transport:new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3850/mcp')),
        schema:CallToolResultSchema});
    }
    const pair=create();client=pair.client;
    await client.connect(pair.transport);
    // Use the protocol's CallToolResult schema; the provider's optional JSON
    // output metadata is incompatible with the HA SDK version's validator.
    const result=await client.request({method:'tools/call',params:{name,arguments:args}},
      pair.schema,{timeout:12000});
    let data=result.structuredContent;
    if(!data){try{data=JSON.parse(result.content?.find(item=>item.type==='text')?.text||'null')}catch{}}
    if(result.isError===true||!data||data.success===false)throw Error('mac_mcp_action_failed');
    return data;
  }finally{try{await client?.close()}catch{}}
}
export function createMacCommandService({planner,call=callMac,now=Date.now}={}){
  if(!planner?.plan||typeof call!=='function')throw Error('service_requires_planner');
  const pending=new Map();
  const prune=()=>{
    for(const [id,entry] of pending)if(entry.expires<=now())pending.delete(id);
    while(pending.size>30)pending.delete(pending.keys().next().value);
  };
  async function plan(text,session,identity,{signal}={}){
    if(!SESSION.test(session)||!IDENTITY.test(identity))return {status:'failed',code:'invalid_device_request'};
    const result=await planner.plan(text,{signal});
    if(result.status!=='ok')return result;
    const target=result.target;
    try{
      if(result.op==='mac_info'){
        const data=await call('system_info',{});
        return {status:'ok',message:`macOS ${clean(data.macos?.product_version||'unknown')} · ${clean(data.architecture||'unknown')} · uptime ${clean(data.uptime?.human||'unknown')} · free disk ${clean(data.disk?.available_gib||'?')} GiB`};
      }
      if(result.op==='mac_network'){
        const data=await call('network_status',{});
        const iface=data.default_route?.interface;
        const primary=(data.interfaces||[]).find(x=>x.name===iface);
        const ipv4=primary?.addresses?.find(a=>a.family==='IPv4'&&!a.internal)?.address;
        return {status:'ok',message:`Mac network: ${clean(iface||'unknown')} · IPv4 ${clean(ipv4||'unavailable')} · DNS ${Array.isArray(data.dns_servers)?data.dns_servers.length:0} servers`};
      }
      if(result.op==='mac_windows'){
        const data=await call('window_list',{max_windows:30});
        const names=[...new Set((data.windows||[]).map(x=>clean(x.application)).filter(Boolean))];
        return {status:'ok',message:`Open apps: ${names.slice(0,14).join(', ')||'none reported'}`};
      }
      if(result.op==='mac_launchd_status'){
        if(!LABEL.test(target))return {status:'failed',code:'invalid_launch_agent'};
        const data=await call('launchd_status',{label:target});
        return {status:'ok',message:`${clean(target)}: ${clean(data.state||data.status|| (data.loaded?'loaded':'unknown'))}`};
      }
      if(result.op==='mac_app_installed'){
        const app=appName(target);
        if(!app)return {status:'unsupported',code:'app_not_allowlisted'};
        const data=await call('app_is_installed',{name:app});
        return {status:'ok',message:`${app}: ${data.installed?'installed':'not installed'}`};
      }
      if(!['mac_app_open','mac_window_focus'].includes(result.op))
        return {status:'unsupported',code:'unsupported_mac_command'};
      const app=appName(target);
      if(!app)return {status:'unsupported',code:'app_not_allowlisted'};
      const name=result.op==='mac_app_open'?'app_open':'window_focus';
      const args=name==='app_open'?{name:app}:{application:app,confirm:true};
      const label=name==='app_open'?`Open ${app} on the Mac`:`Focus ${app} on the Mac`;
      prune();const id=randomBytes(24).toString('hex');
      pending.set(id,{identity,session,name,args,label,expires:now()+90000});
      prune();
      return {status:'confirm_required',id,message:label,expiresInSeconds:90};
    }catch{return {status:'unavailable',code:'mac_control_unavailable'};}
  }
  async function confirm(id,session,identity){
    if(typeof id!=='string'||! /^[a-f0-9]{48}$/.test(id)||!SESSION.test(session)||!IDENTITY.test(identity))
      return {status:'failed',code:'invalid_confirmation'};
    prune();const task=pending.get(id);pending.delete(id);
    if(!task||task.identity!==identity||task.session!==session||task.expires<=now())
      return {status:'failed',code:'confirmation_expired'};
    try{
      await call(task.name,task.args);
      return {status:'ok',message:`${task.label} — completed`};
    }catch{return {status:'unavailable',code:'mac_control_unavailable'};}
  }
  return Object.freeze({plan,confirm});
}

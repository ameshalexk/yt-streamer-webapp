// Bounded natural-language intent extraction. Codex gets NO MCP tools or
// machine access; a separate server-side policy decides what MCP call to make.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';

const SCHEMA=fileURLToPath(new URL('./teslamon-device-plan.schema.json',import.meta.url));
const DEFAULT_BINARY=path.join(os.homedir(),'.codex/plugins/.plugin-appserver/codex-cli/bin/codex');
const FALLBACK_BINARY='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const DEFAULT_WORKSPACE=path.join(os.homedir(),'Library/Application Support/YTStreamerWebapp/private/teslamon-codex/workspace');
const OPS=new Set(['search','state','areas','light_on','light_off','area_light_on','area_light_off',
  'switch_on','switch_off','fan_on','fan_off','thermostat_temp','unsupported']);
const WRITE=new Set(['light_on','light_off','area_light_on','area_light_off',
  'switch_on','switch_off','fan_on','fan_off','thermostat_temp']);
const MAC_OPS=new Set(['mac_info','mac_network','mac_windows','mac_app_installed',
  'mac_app_open','mac_window_focus','mac_launchd_status','unsupported']);
const MAC_WRITE=new Set(['mac_app_open','mac_window_focus']);
const PROMPT=[
  'You are interpreting one Home Assistant smart-home request, not executing it.',
  'Return EXACTLY an object with op, target, value.',
  'Read intents: search for a device/list entities => search; status/state/temperature => state; list rooms => areas.',
  'Write intents: light_on, light_off, area_light_on, area_light_off, switch_on, switch_off, fan_on, fan_off, thermostat_temp.',
  'For a lighting room-wide request use area_light_on or area_light_off and target the exact room name.',
  'For an individual entity use its Home Assistant entity_id if the user supplied it, or its short friendly name.',
  'For thermostat_temp set value to requested Fahrenheit temperature (55 to 85).',
  'For other operations set value to null. For areas set target to empty string.',
  'Do not expand the user request into extra actions. No automation, scripts, locks, doors, garages, alarms, cameras, passwords, files, terminals or network access.',
  'For anything unsafe, ambiguous in purpose, unrelated or unsupported choose unsupported.',
  'You have no tools. Do not claim any action has run; the server will validate the plan and require a user click for changes.'
].join(' ');
const MAC_PROMPT=[
  'You are interpreting one Mac Control request, not executing it.',
  'Return exactly op, target, value. value is ALWAYS null.',
  'Read operations: mac_info (general Mac status), mac_network (network status), mac_windows (which apps are open), mac_app_installed (is an app installed), mac_launchd_status (check a launch agent label).',
  'Write operations: mac_app_open (launch an allowed application), mac_window_focus (bring an allowed app forward).',
  'mac_info, mac_network and mac_windows require empty target. Other ops target an exact application name or launchd service label.',
  'Only support Safari, Google Chrome, Finder, Notes, Calendar, Music, Photos, Preview or TextEdit for application targets.',
  'NEVER run terminal, scripts, files, messages, commands, browser navigation, security/privacy settings, system shutdown, process kill, installation or any other operations.',
  'If user asks for anything else return unsupported with empty target and null value.',
  'No tools available. Never claim anything was done. Mac writes require the user to click a confirmation in the browser.'
].join(' ');
export function validateDevicePlan(data,{provider='ha'}={}){
  if(!data||Array.isArray(data)||typeof data!=='object'||
     Object.keys(data).sort().join(',')!=='op,target,value'||
     !(provider==='mac'?MAC_OPS:OPS).has(data.op)||
     typeof data.target!=='string'||data.target.length>90||
     /[\x00-\x1f\x7f\\\/?#]/.test(data.target)||
     (data.value!==null&&(!Number.isInteger(data.value)||data.value<55||data.value>85)))
    return {status:'failed',code:'invalid_device_plan'};
  if(data.op==='unsupported')return {status:'unsupported',code:'unsupported_device_command'};
  if(provider==='mac'){
    if((['mac_info','mac_network','mac_windows'].includes(data.op)) !== (data.target==='') ||
       data.value!==null)return {status:'failed',code:'invalid_device_plan'};
    return {status:'ok',op:data.op,target:data.target.trim(),value:null,write:MAC_WRITE.has(data.op)};
  }
  if((data.op==='areas')!== (data.target==='') || (data.op!=='thermostat_temp'&&data.value!==null) ||
     (data.op==='thermostat_temp'&&!Number.isInteger(data.value)))
    return {status:'failed',code:'invalid_device_plan'};
  return {status:'ok',op:data.op,target:data.target.trim(),value:data.value,write:WRITE.has(data.op)};
}
export function createDevicePlanner({provider='ha',binary=existsSync(DEFAULT_BINARY)?DEFAULT_BINARY:FALLBACK_BINARY,
    workspace=DEFAULT_WORKSPACE,launch=spawn,timeoutMs=45000,
    supported=process.platform==='darwin',binaryExists=existsSync}={}){
  const available=supported&&path.isAbsolute(binary)&&path.isAbsolute(workspace)&&
    binaryExists(binary)&&binaryExists(workspace);
  let busy=false;
  async function plan(text,{signal}={}){
    if(!available)return {status:'unavailable',code:'codex_unavailable'};
    if(busy)return {status:'failed',code:'codex_busy'};
    if(typeof text!=='string'||text.length<2||text.length>220||/[\x00-\x1f\x7f]/.test(text))
      return {status:'failed',code:'invalid_device_request'};
    if(signal?.aborted)return {status:'failed',code:'codex_cancelled'};
    busy=true;
    try{return await new Promise(resolve=>{
      const args=['exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check',
        '--sandbox','read-only','-c','approval_policy="never"',
        '-C',workspace,'--output-schema',SCHEMA,'--json','-'];
      let child,buffer='',message='',done=false,forbidden=false,overflow=false,
        timedOut=false,serviceFailure=null,settled=false;
      const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);
        signal?.removeEventListener('abort',onAbort);resolve(value);};
      const stop=()=>{try{child?.kill('SIGTERM')}catch{}};
      const onAbort=()=>{timedOut=true;stop();};
      const timer=setTimeout(onAbort,timeoutMs);
      signal?.addEventListener('abort',onAbort,{once:true});
      try{child=launch(binary,args,{cwd:workspace,stdio:['pipe','pipe','pipe'],
        env:{HOME:os.homedir(),CODEX_HOME:path.join(os.homedir(),'.codex'),
          PATH:'/usr/bin:/bin:/opt/homebrew/bin',LANG:'en_US.UTF-8',TMPDIR:process.env.TMPDIR||'/tmp'}});}
      catch{finish({status:'unavailable',code:'codex_unavailable'});return;}
      const onLine=line=>{
        let evt;try{evt=JSON.parse(line)}catch{return;}
        if(evt.type==='item.completed'&&evt.item?.type==='agent_message'&&
          typeof evt.item.text==='string')message=evt.item.text;
        if(evt.type==='turn.completed')done=true;
        if(evt.item&&['mcp_tool_call','command_execution','file_change','web_search','tool_call'].includes(evt.item.type)){
          forbidden=true;stop();
        }
        if(evt.type==='error'||evt.type==='turn.failed'){
          const m=String(evt.message||evt.error?.message||'');
          if(/usage limit|rate limit|quota exceeded|too many requests/i.test(m))serviceFailure='codex_usage_limit';
          else if(!serviceFailure)serviceFailure='codex_unavailable';
        }
      };
      child.stdout.on('data',chunk=>{
        if(overflow)return;
        buffer+=String(chunk);
        if(buffer.length>64000){overflow=true;stop();return;}
        const lines=buffer.split('\n');buffer=lines.pop()||'';
        for(const line of lines)onLine(line);
      });
      child.stderr.on('data',()=>{}); // Never surface raw Codex diagnostics.
      child.stdin.on('error',()=>{});
      child.stdin.end((provider==='mac'?MAC_PROMPT:PROMPT)+'\n\nUser request: '+JSON.stringify(text));
      child.on('error',()=>finish({status:'unavailable',code:'codex_unavailable'}));
      child.on('close',code=>{
        if(buffer.trim())onLine(buffer);
        if(timedOut)return finish({status:'failed',code:'codex_timeout_or_cancelled'});
        if(overflow||forbidden)return finish({status:'failed',code:'codex_disallowed_tool'});
        if(serviceFailure)return finish({status:'unavailable',code:serviceFailure});
        if(code!==0||!done)return finish({status:'unavailable',code:'codex_unavailable'});
        let parsed;try{parsed=JSON.parse(message)}catch{return finish({status:'failed',code:'invalid_device_plan'})}
        finish(validateDevicePlan(parsed,{provider}));
      });
    });}finally{busy=false;}
  }
  return Object.freeze({available,plan,get active(){return busy;}});
}

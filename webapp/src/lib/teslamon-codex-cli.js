// TeslaMon natural-language reasoning via the user's existing Codex CLI sign-in.
// The model selects ONE bounded video command. The SAME browser tab executes it
// through its existing six-tool local player; Codex never receives control of a
// browser, filesystem mutation, arbitrary MCPs or device-control credentials.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';

const SCHEMA=fileURLToPath(new URL('./teslamon-codex-plan.schema.json',import.meta.url));
const TOOLS=new Set(['pause','resume','get_playback_state','search_and_play',
  'request_fullscreen','exit_fullscreen','ha_done','unsupported']);
const SESSION=/^[a-f0-9-]{36}$/i;
const VALID_LINE=/^[^\x00-\x1f\x7f]{1,220}$/;
const EXIT_ERROR='codex_unavailable';
// Codex service failures are not evidence that a prohibited tool was called.
// Display only a bounded retry time; never forward raw CLI diagnostic text.
function classifyCodexFailure(evt){
  const message=typeof evt?.message==='string'?evt.message:
    typeof evt?.error?.message==='string'?evt.error.message:'';
  if(/\b(?:usage limit|rate limit|quota exceeded|too many requests)\b/i.test(message)){
    const retry=message.match(/\btry again at\s+([0-1]?\d:\d{2}\s*[ap]m)\b/i);
    return {status:'unavailable',code:'codex_usage_limit',
      ...(retry?{retryAt:retry[1].replace(/\s+/g,' ').toUpperCase()}: {})};
  }
  return {status:'unavailable',code:EXIT_ERROR};
}
const HA_PROXY=fileURLToPath(new URL('./teslamon-ha-lights-mcp.mjs',import.meta.url));
const APPROVED_LIGHT_TOOLS=new Set(['search_lights','get_light_state','set_light']);
const CODEX_FROM_PLUGIN=path.join(os.homedir(),
  '.codex/plugins/.plugin-appserver/codex-cli/bin/codex');
const CODEX_FROM_CHATGPT='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
export const TESLAMON_CODEX_BINARY=existsSync(CODEX_FROM_PLUGIN)?
  CODEX_FROM_PLUGIN:CODEX_FROM_CHATGPT;

export function validateCodexPlan(plan){
  if(!plan||typeof plan!=='object'||Array.isArray(plan)||
     Object.keys(plan).sort().join(',')!=='query,tool'||
     !TOOLS.has(plan.tool)||typeof plan.query!=='string'||plan.query.length>120)
    return {status:'failed',code:'invalid_codex_plan'};
  if(plan.tool==='unsupported')return {status:'unsupported',code:'unsupported_voice_command'};
  if(plan.tool==='ha_done') {
    if(plan.query!=='')return {status:'failed',code:'unexpected_codex_args'};
    return {status:'ha_done',code:'ha_mcp_completed'};
  }
  if(plan.tool==='search_and_play'){
    const query=plan.query.trim();
    if(query.length<2||query.length>120||/^(https?:\/\/|www\.)/i.test(query)||
       /[\x00-\x1f\x7f]/.test(query))return {status:'failed',code:'invalid_codex_query'};
    return {status:'ok',tool:plan.tool,args:{query}};
  }
  if(plan.query!=='')return {status:'failed',code:'unexpected_codex_args'};
  return {status:'ok',tool:plan.tool,args:{}};
}

const BASE_PROMPT=[
  'You are TeslaMon, a video and Home Assistant LIGHTING assistant, NOT a coding assistant.',
  'Select exactly ONE allowed command for this user request:',
  'pause, resume, get_playback_state, search_and_play, request_fullscreen, exit_fullscreen.',
  'For search_and_play, set query to the exact video search phrase (2-120 chars).',
  'Preserve words like latest, newest, or most recent when the user requests a channels newest upload.',
  'For every other command set query to the empty string.',
  'Full screen or fullscreen means request_fullscreen; exit or leave fullscreen means exit_fullscreen.',
  'For LIGHTS requests use only teslamon_lights MCP tools. Search by name/room, read if useful,',
  'then call set_light ONLY for an explicit user request to change lights.',
  'After MCP confirms the requested read/write, output tool ha_done with empty query.',
  'Never claim a light changed unless the MCP tool reported success.',
  'For questions/actions unrelated to playback or lighting select unsupported.',
  'Never produce a URL, file path, code, terminal command, device command or instructions.',
  'Do NOT run shell commands, inspect files, browse or use other MCP tools.',
  'You may call only teslamon_lights MCP tools for LIGHTING requests.',
  'The application checks and executes the JSON itself. Never claim an action succeeded.',
  'For a play request choose search_and_play. The page will play the first valid ranked search result automatically.',
].join(' ');

export function createTeslaMonCodex({
  binary=TESLAMON_CODEX_BINARY,
  workspace=path.join(os.homedir(),'Library/Application Support/YTStreamerWebapp/private/teslamon-codex/workspace'),
  launch=spawn,timeoutMs=45000,now=Date.now,
  isSupportedPlatform=process.platform==='darwin',binaryExists=existsSync,
  maxOutputBytes=64000,maxSessions=10
}={}){
  const sessions=new Map();
  let busy=false;
  const available=isSupportedPlatform && path.isAbsolute(binary) &&
    path.isAbsolute(workspace) && binaryExists(binary) && binaryExists(workspace);
  function plan(text,session,identity,{signal}={}){
    if(!available)return Promise.resolve({status:'unavailable',code:EXIT_ERROR});
    if(typeof text!=='string'||!VALID_LINE.test(text)||!SESSION.test(session)||
       typeof identity!=='string'||!/^[a-f0-9]{64}$/.test(identity))
      return Promise.resolve({status:'failed',code:'invalid_codex_request'});
    if(busy)return Promise.resolve({status:'failed',code:'codex_busy'});
    busy=true;
    const key=createHash('sha256').update(identity+':'+session).digest('hex');
    const existing=sessions.get(key);
    // No data from model output can become subprocess arguments: thread ids are
    // taken solely from Codex events and constrained to UUID-shaped strings.
    const oldThread=existing?.thread;
    const canResume=typeof oldThread==='string'&&SESSION.test(oldThread);
    const args=['exec',...(canResume?['resume',oldThread]:[]),
      '--ignore-user-config','--ignore-rules','--skip-git-repo-check',
      '-c','sandbox_mode="read-only"','-c','approval_policy="never"',
      '-c','mcp_servers.teslamon_lights.command="/opt/homebrew/bin/node"',
      '-c','mcp_servers.teslamon_lights.args=['+JSON.stringify(HA_PROXY)+']',
      '-c','mcp_servers.teslamon_lights.default_tools_approval_mode="approve"',
      '-C',workspace,'--output-schema',SCHEMA,'--json','-'];
    // exec resume does not support -C, -s or --skip-git-repo-check.
    if(canResume){
      const at=args.indexOf('--skip-git-repo-check');args.splice(at,1);
      const cwdAt=args.indexOf('-C');args.splice(cwdAt,2);
    }else{
      const at=args.indexOf('-c');args.splice(at,0,'--sandbox','read-only');
    }
    const prompt=BASE_PROMPT+'\n\nUser request: '+JSON.stringify(text);
    return new Promise(resolve=>{
      let child=null,buffer='',output='',thread=canResume?oldThread:null,
        stdoutBytes=0,completed=false,serviceFailure=null,
        suspicious=false,settled=false,timer=null,aborted=false,
        allowedMcpCalls=0,completedMcpCalls=0,lightMutations=0;
      const finish=result=>{
        if(settled)return;settled=true;clearTimeout(timer);
        signal?.removeEventListener('abort',abort);
        busy=false;
        resolve(result);
      };
      const abort=()=>{aborted=true;try{child?.kill('SIGTERM')}catch{}};
      if(signal?.aborted){finish({status:'failed',code:'codex_cancelled'});return;}
      try{
        child=launch(binary,args,{cwd:workspace,stdio:['pipe','pipe','pipe'],
          env:{HOME:os.homedir(),CODEX_HOME:path.join(os.homedir(),'.codex'),
            PATH:'/usr/bin:/bin:/opt/homebrew/bin',LANG:'en_US.UTF-8',
            TMPDIR:process.env.TMPDIR||'/tmp'}});
      }catch{finish({status:'unavailable',code:EXIT_ERROR});return;}
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{aborted=true;abort()},timeoutMs);
      function onLine(line){
        let evt;try{evt=JSON.parse(line)}catch{return;}
        if(evt.type==='thread.started'&&SESSION.test(evt.thread_id||''))thread=evt.thread_id;
        if(evt.type==='item.completed'&&evt.item?.type==='agent_message'&&
           typeof evt.item.text==='string')output=evt.item.text;
        // Codex makes direct MCP calls, but only through three allowed light
        // tools. No unrestricted HA or device-control tool catalog.
        if(evt.item?.type==='mcp_tool_call'){
          const item=evt.item;
          if(item.server!=='teslamon_lights'||!APPROVED_LIGHT_TOOLS.has(item.tool)){
            suspicious=true;
          }else if(evt.type==='item.started'){
            allowedMcpCalls++;
            if(item.tool==='set_light')lightMutations++;
            if(allowedMcpCalls>5||lightMutations>1)suspicious=true;
          }else if(evt.type==='item.completed'){
            if(item.status==='completed'&&!item.error)completedMcpCalls++;
            else suspicious=true;
          }
          if(suspicious){try{child?.kill('SIGTERM')}catch{}}
        }
        if(['command_execution','file_change','web_search','tool_call']
          .includes(evt.item?.type)){
          suspicious=true;
          try{child?.kill('SIGTERM');}catch{}
        }
        if(evt.type==='turn.completed')completed=true;
        if(evt.type==='turn.failed'||evt.type==='error'){
          const failure=classifyCodexFailure(evt);
          // A generic turn.failed may follow a specific quota error.
          if(!serviceFailure||failure.code==='codex_usage_limit')serviceFailure=failure;
        }
      }
      child.stdout.on('data',d=>{
        stdoutBytes+=d.length;
        if(stdoutBytes>maxOutputBytes){abort();return;}
        buffer+=String(d);
        const lines=buffer.split('\n');buffer=lines.pop()||'';
        for(const line of lines)onLine(line);
      });
      child.stderr.on('data',()=>{}); // Never log credentials or prompt contents.
      child.stdin.on('error',()=>{});
      child.stdin.end(prompt);
      child.on('error',()=>finish({status:'unavailable',code:EXIT_ERROR}));
      child.on('close',code=>{
        if(settled)return;
        if(buffer.trim())onLine(buffer);
        if(aborted)return finish({status:'failed',code:'codex_timeout_or_cancelled'});
        if(suspicious)return finish({status:'failed',code:'codex_disallowed_tool'});
        if(serviceFailure)return finish(serviceFailure);
        if(code!==0||!completed)return finish({status:'unavailable',code:EXIT_ERROR});
        let json;try{json=JSON.parse(output)}catch{
          return finish({status:'failed',code:'invalid_codex_reply'});
        }
        const result=validateCodexPlan(json);
        if(result.status==='ha_done'&&completedMcpCalls===0)
          return finish({status:'failed',code:'ha_mcp_not_called'});
        if(['ok','ha_done'].includes(result.status)&&thread){
          sessions.delete(key);sessions.set(key,{thread,at:now()});
          for(const [k,v] of sessions)if(now()-v.at>30*60*1000)sessions.delete(k);
          while(sessions.size>maxSessions)sessions.delete(sessions.keys().next().value);
        }
        finish(result.status==='ha_done'?
          {...result,action:lightMutations>0?'light_changed':'light_checked'}:result);
      });
    });
  }
  return Object.freeze({available,plan,get active(){return busy}});
}

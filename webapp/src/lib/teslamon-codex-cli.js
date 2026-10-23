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
  'request_fullscreen','exit_fullscreen','unsupported']);
const SESSION=/^[a-f0-9-]{36}$/i;
const VALID_LINE=/^[^\x00-\x1f\x7f]{1,220}$/;
const EXIT_ERROR='codex_unavailable';
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
  'You are TeslaMon, a video playback command interpreter, NOT a coding assistant.',
  'Select exactly ONE allowed command for this user request:',
  'pause, resume, get_playback_state, search_and_play, request_fullscreen, exit_fullscreen.',
  'For search_and_play, set query to the exact video search phrase (2-120 chars).',
  'For every other command set query to the empty string.',
  'For questions/actions unrelated to playing videos in THIS browser tab select unsupported.',
  'Never produce a URL, file path, code, terminal command, device command or instructions.',
  'Do NOT call tools, run commands, read files, inspect environment or browse.',
  'The application checks and executes the JSON itself. Never claim an action succeeded.',
  'An ambiguous search query is okay: the page will ask the user to select a result.',
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
        stdoutBytes=0,completed=false,
        suspicious=false,settled=false,timer=null,aborted=false;
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
        // Reject turns that attempt general command/tool execution. No approval
        // requests may be granted; the Codex process is sandbox read-only.
        if(['command_execution','mcp_tool_call','file_change','web_search','tool_call']
          .includes(evt.item?.type)){
          suspicious=true;
          try{child?.kill('SIGTERM');}catch{}
        }
        if(evt.type==='turn.completed')completed=true;
        if(evt.type==='turn.failed'||evt.type==='error')suspicious=true;
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
        if(code!==0||suspicious||!completed)return finish({status:'failed',
          code:suspicious?'codex_disallowed_tool':EXIT_ERROR});
        let json;try{json=JSON.parse(output)}catch{
          return finish({status:'failed',code:'invalid_codex_reply'});
        }
        const result=validateCodexPlan(json);
        if(result.status==='ok'&&thread){
          sessions.delete(key);sessions.set(key,{thread,at:now()});
          for(const [k,v] of sessions)if(now()-v.at>30*60*1000)sessions.delete(k);
          while(sessions.size>maxSessions)sessions.delete(sessions.keys().next().value);
        }
        finish(result);
      });
    });
  }
  return Object.freeze({available,plan,get active(){return busy}});
}

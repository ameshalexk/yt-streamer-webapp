// Lightweight Mac -> existing PowerALX Life Recorder worker transport.
// NEVER loads/downloads a speech model or runs Whisper/ffmpeg transcription on
// the Mac. Existing release phase1-20260912-b runs only on the Windows GPU PC.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const MAX_BYTES=5*1024*1024;
const TYPES=new Set(['audio/webm','audio/mp4','audio/ogg','audio/wav']);
const helper=fileURLToPath(new URL('./teslamon-poweralx-bridge.py',import.meta.url));
const failed=(code,status='failed')=>({status,code});
const BINARY=/^(\/[A-Za-z0-9_.@+-]+)+$/;
const ALIAS=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const RELEASE=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,75}$/;
export function createTeslaMonTranscriber({
  workerRoot=process.env.TESLAMON_POWERALX_WORKER_ROOT,
  release=process.env.TESLAMON_POWERALX_WORKER_RELEASE,
  host=process.env.TESLAMON_POWERALX_SSH_ALIAS||'poweralx',
  python=process.env.TESLAMON_POWERALX_PYTHON||'/usr/bin/python3',
  resident=process.env.TESLAMON_POWERALX_RESIDENT==='1',
  timeoutMs=125000,runner
}={}){
  // Disabled in staging unless existing worker explicitly configured.
  // Never fall back to Mac models or to any cloud ASR.
  const available=typeof workerRoot==='string'&&workerRoot.startsWith('C:\\')&&
    /^C:\\[A-Za-z0-9_ .\\-]+$/i.test(workerRoot)&&
    RELEASE.test(release||'')&&ALIAS.test(host)&&BINARY.test(python)&&
    Number.isSafeInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=180000;
  let busy=false;
  const doRun=runner||((bytes,mime,{signal}={})=>new Promise(resolve=>{
    const controller=new AbortController();
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,timeoutMs);
    let settled=false;
    let output='',stderrBytes=0;
    const done=result=>{
      if(settled)return;settled=true;clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      resolve(result);
    };
    let child;
    try{
      child=spawn(python,[helper,'--mime',mime,'--worker-root',workerRoot,
        '--release',release,'--ssh-host',host,...(resident?['--resident']:[])],
        {stdio:['pipe','pipe','pipe'],signal:controller.signal,
          env:{PATH:process.env.PATH||'/usr/bin:/bin:/opt/homebrew/bin',
            HOME:process.env.HOME||'',PYTHONUTF8:'1'}});
    }catch{
      done(failed('poweralx_worker_unavailable'));return;
    }
    child.stdout.on('data',d=>{
      output+=String(d);
      if(output.length>3000)abort();
    });
    child.stderr.on('data',d=>{stderrBytes+=d.length;if(stderrBytes>2048)abort();});
    child.on('error',()=>done(failed('poweralx_worker_unavailable','unavailable')));
    child.on('exit',code=>{
      if(settled)return;
      if(controller.signal.aborted)
        return done(failed('poweralx_timeout_or_cancelled','unavailable'));
      if(code!==0)return done(failed('poweralx_transcription_failed'));
      try{
        const reply=JSON.parse(output);
        if(reply?.status==='ok'&&typeof reply.text==='string'&&
          reply.text.length>0&&reply.text.length<=220)
          return done({status:'ok',text:reply.text});
        const code=typeof reply?.code==='string'&&
          /^[a-z_]{1,55}$/.test(reply.code)?reply.code:'poweralx_transcription_failed';
        return done(failed(code,reply?.status==='unavailable'?'unavailable':'failed'));
      }catch{return done(failed('invalid_poweralx_response'));}
    });
    // Do not buffer media into shell arguments, log files, or environment.
    child.stdin.on('error',()=>{});
    child.stdin.end(bytes);
  }));
  return Object.freeze({
    available,
    engine:available?(resident?'resident_poweralx_worker':'existing_poweralx_worker'):'disabled',
    async transcribe(data,contentType,{signal}={}){
      if(!available)return failed('poweralx_worker_not_configured','unavailable');
      const mime=String(contentType||'').split(';')[0].trim().toLowerCase();
      if(!TYPES.has(mime)||!Buffer.isBuffer(data)||data.length<128||
        data.length>MAX_BYTES)return failed('invalid_audio_payload');
      if(signal?.aborted)return failed('request_cancelled');
      if(busy)return failed('speech_transcriber_busy');
      busy=true;
      try{
        const reply=await doRun(data,mime,{signal});
        if(reply?.status==='ok'&&typeof reply.text==='string'&&reply.text.length<=220)
          return {status:'ok',text:reply.text};
        return {status:['failed','unavailable'].includes(reply?.status)?
          reply.status:'failed',
          code:/^[a-z_]{1,55}$/.test(reply?.code||'')?
            reply.code:'poweralx_transcription_failed'};
      }catch{return failed('poweralx_transcription_failed');}
      finally{busy=false;}
    }
  });
}

// Local speech-to-text adapter: no cloud transcription provider or retained audio.
// Disabled until TESLAMON_WHISPER_MODEL points to an existing local GGML model.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const MAX_BYTES=5*1024*1024;
const MIME=new Map([
  ['audio/webm','.webm'],['audio/ogg','.ogg'],['audio/mp4','.m4a']
]);
const abortable=(bin,args,{signal,timeoutMs=25000}={})=>
  new Promise((resolve,reject)=>{
    const controller=new AbortController();
    let timed=false;
    const timer=setTimeout(()=>{timed=true;controller.abort();},timeoutMs);
    let finished=false;
    const proc=spawn(bin,args,{signal:controller.signal,
      stdio:['ignore','ignore','pipe'],env:{...process.env}});
    let stderr='';
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    proc.stderr.on('data',b=>{if(stderr.length<1000)stderr+=String(b).slice(0,200);});
    const done=err=>{
      if(finished)return;finished=true;clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      if(err)reject(err);else resolve();
    };
    proc.on('error',ex=>done(ex));
    proc.on('exit',code=>done(code===0?null:
      Error(timed?'transcription_timeout':'transcription_command_failed')));
  });
export function createTeslaMonTranscriber({
  model=process.env.TESLAMON_WHISPER_MODEL,
  ffmpeg=process.env.TESLAMON_FFMPEG||'ffmpeg',
  whisper=process.env.TESLAMON_WHISPER_BINARY||'whisper-cli',
  run=abortable
}={}){
  let busy=false;
  const available=typeof model==='string'&&path.isAbsolute(model);
  return Object.freeze({
    available,
    async transcribe(data,contentType,{signal}={}){
      if(!available)return {status:'unavailable',code:'local_stt_not_configured'};
      const mime=String(contentType||'').split(';')[0].trim().toLowerCase();
      const ext=MIME.get(mime);
      if(!ext||!Buffer.isBuffer(data)||data.length<128||data.length>MAX_BYTES)
        return {status:'failed',code:'invalid_audio'};
      if(busy)return {status:'failed',code:'speech_transcriber_busy'};
      busy=true;
      let dir=null;
      try{
        const stat=await fs.stat(model);
        if(!stat.isFile()||stat.size<100000)return {status:'unavailable',code:'whisper_model_unavailable'};
        dir=await fs.mkdtemp(path.join(os.tmpdir(),'teslamon-stt-'));
        await fs.chmod(dir,0o700);
        const input=path.join(dir,'recording'+ext);
        const wav=path.join(dir,'converted.wav');
        const output=path.join(dir,'result');
        await fs.writeFile(input,data,{mode:0o600,flag:'wx'});
        await run(ffmpeg,['-nostdin','-hide_banner','-loglevel','error',
          '-y','-i',input,'-vn','-ac','1','-ar','16000','-t','21',wav],
          {signal,timeoutMs:15000});
        await run(whisper,['-m',model,'-f',wav,'-nt','-otxt','-of',output],
          {signal,timeoutMs:40000});
        const transcript=(await fs.readFile(output+'.txt','utf8'))
          .replace(/\[[^\]]{1,80}\]/g,' ').replace(/\s+/g,' ').trim().slice(0,220);
        if(!transcript)return {status:'failed',code:'no_speech_detected'};
        return {status:'ok',text:transcript};
      }catch{
        return {status:'failed',code:signal?.aborted?
          'transcription_cancelled':'transcription_unavailable'};
      }finally{
        if(dir)await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
        busy=false;
      }
    }
  });
}

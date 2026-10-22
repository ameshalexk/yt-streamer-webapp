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
export const runTeslaMonSpeechCommand=(bin,args,{signal,timeoutMs=25000}={})=>
  new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(Error('transcription_cancelled'));return;}
    let proc;
    try{proc=spawn(bin,args,{stdio:['ignore','ignore','ignore'],env:{...process.env}});}
    catch(error){reject(error);return;}
    let finished=false,stopped=false,timed=false,killTimer=null,spawnError=null;
    const stop=()=>{
      if(stopped||finished)return;stopped=true;
      try{proc.kill('SIGTERM');}catch{}
      killTimer=setTimeout(()=>{if(!finished)try{proc.kill('SIGKILL');}catch{}},1000);
      killTimer.unref?.();
    };
    const timer=setTimeout(()=>{timed=true;stop();},timeoutMs);
    signal?.addEventListener('abort',stop,{once:true});
    if(signal?.aborted)stop();
    proc.on('error',error=>{spawnError=error;});
    // Wait until the process is actually gone before the caller removes audio.
    // An AbortError alone does not establish that a child has stopped writing.
    proc.on('close',code=>{
      if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);
      signal?.removeEventListener('abort',stop);
      if(spawnError)reject(spawnError);
      else if(stopped||code!==0)reject(Error(timed?'transcription_timeout':
        signal?.aborted?'transcription_cancelled':'transcription_command_failed'));
      else resolve();
    });
  });
export function createTeslaMonTranscriber({
  model=process.env.TESLAMON_WHISPER_MODEL,
  ffmpeg=process.env.TESLAMON_FFMPEG||'ffmpeg',
  whisper=process.env.TESLAMON_WHISPER_BINARY||'whisper-cli',
  run=runTeslaMonSpeechCommand
}={}){
  let busy=false;
  const available=typeof model==='string'&&path.isAbsolute(model);
  return Object.freeze({
    available,
    async transcribe(data,contentType,{signal}={}){
      if(signal?.aborted)return {status:'failed',code:'transcription_cancelled'};
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
        if(signal?.aborted)throw Error('cancelled');
        dir=await fs.mkdtemp(path.join(os.tmpdir(),'teslamon-stt-'));
        await fs.chmod(dir,0o700);
        const input=path.join(dir,'recording'+ext);
        const wav=path.join(dir,'converted.wav');
        const output=path.join(dir,'result');
        await fs.writeFile(input,data,{mode:0o600,flag:'wx'});
        if(signal?.aborted)throw Error('cancelled');
        await run(ffmpeg,['-nostdin','-hide_banner','-loglevel','error',
          '-y','-i',input,'-vn','-ac','1','-ar','16000','-t','21',wav],
          {signal,timeoutMs:15000});
        if(signal?.aborted)throw Error('cancelled');
        await run(whisper,['-m',model,'-f',wav,'-nt','-otxt','-of',output],
          {signal,timeoutMs:40000});
        if(signal?.aborted)throw Error('cancelled');
        const transcript=(await fs.readFile(output+'.txt','utf8'))
          .replace(/\[[^\]]{1,80}\]/g,' ').replace(/\s+/g,' ').trim().slice(0,220);
        if(signal?.aborted)throw Error('cancelled');
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

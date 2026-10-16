import {execFile} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const VOD_SEGMENT_SECONDS = 6;
export const VOD_MAX_SECONDS = 4 * 3600 + 15 * 60;
export const VOD_CACHE_SEGMENTS = 24;

// Source metadata is server-derived, never accepted from a receiver's request.
export function probeVodDuration(video, ffprobePath = "ffprobe") {
  return new Promise(resolve => {
    execFile(ffprobePath, ["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",video],
      {timeout:18000,maxBuffer:16384}, (error,stdout) => {
        const duration=Number(String(stdout || "").trim());
        resolve(!error && Number.isFinite(duration) && duration > 0 ? duration : null);
      });
  });
}

export function vodPlaylist(duration, segmentSeconds = VOD_SEGMENT_SECONDS) {
  if (!(duration > 0 && duration <= VOD_MAX_SECONDS) || !Number.isFinite(duration)) throw Error("Unsupported VOD duration");
  const count=Math.ceil(duration/segmentSeconds);
  const parts=["#EXTM3U","#EXT-X-VERSION:3","#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-TARGETDURATION:"+Math.ceil(segmentSeconds),"#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS"];
  for(let index=0;index<count;index++){
    const seconds=Math.min(segmentSeconds,duration-index*segmentSeconds);
    parts.push("#EXTINF:"+seconds.toFixed(3)+",","segment_"+String(index).padStart(5,"0")+".ts");
  }
  parts.push("#EXT-X-ENDLIST");
  return parts.join("\n")+"\n";
}

export function buildVodSegmentArgs({video,audio,offset,length,output}) {
  if (!video || !output || !Number.isFinite(offset) || offset < 0 || !(length > 0 && length <= VOD_SEGMENT_SECONDS)) {
    throw Error("Invalid VOD segment");
  }
  const args=["-hide_banner","-loglevel","error","-nostdin","-ss",offset.toFixed(3),"-i",video];
  if(audio) args.push("-ss",offset.toFixed(3),"-i",audio);
  args.push("-map","0:v:0","-map",audio?"1:a:0":"0:a:0?",
    "-t",length.toFixed(3),
    "-vf","scale=trunc(min(854\\,iw)/2)*2:-2,fps=24",
    "-c:v","libx264","-preset","veryfast","-profile:v","main","-level","3.1",
    "-pix_fmt","yuv420p","-b:v","1300k","-maxrate","1600k","-bufsize","3200k",
    "-g","144","-keyint_min","144","-sc_threshold","0",
    "-c:a","aac","-b:a","128k","-ac","2","-ar","44100",
    "-avoid_negative_ts","disabled","-output_ts_offset",offset.toFixed(3),
    "-f","mpegts","-mpegts_flags","+resend_headers","-y",output);
  return args;
}

// Each segment is independently seekable; a very small LRU bounds disk usage.
// Requests are serialized per session to cap CPU and protect a single Mac mini.
export async function makeVodSegment(session,index,{ffmpegPath,spawnImpl}) {
  if (session.stopping) throw Object.assign(Error("Session stopped"),{status:410});
  const total=Math.ceil(session.duration/VOD_SEGMENT_SECONDS);
  if(!Number.isSafeInteger(index) || index<0 || index>=total)
    throw Object.assign(Error("Segment outside VOD"),{status:404});
  if(session.cache.has(index)){
    session.cache.delete(index);session.cache.set(index,true);
    return path.join(session.dir,"segment_"+String(index).padStart(5,"0")+".ts");
  }
  if(session.pending.has(index)) return session.pending.get(index);
  if(session.pending.size>=4) throw Object.assign(Error("Too many segment requests"),{status:429});
  const job=session.queue.catch(()=>{}).then(async()=>{
    if(session.stopping) throw Object.assign(Error("Session stopped"),{status:410});
    const output=path.join(session.dir,"segment_"+String(index).padStart(5,"0")+".ts");
    const temp=output+".pending";
    const offset=index*VOD_SEGMENT_SECONDS;
    const length=Math.min(VOD_SEGMENT_SECONDS,session.duration-offset);
    try {
      await new Promise((resolve,reject)=>{
        const p=spawnImpl(ffmpegPath,buildVodSegmentArgs({...session.source,offset,length,output:temp}),
          {stdio:["ignore","ignore","pipe"]});
        session.ff=p;
        p.stderr?.resume();
        let settled=false;
        const finish=(error)=>{
          if(settled)return;settled=true;clearTimeout(deadline);
          if(session.ff===p)session.ff=null;
          error?reject(error):resolve();
        };
        const deadline=setTimeout(()=>{
          try{p.kill("SIGKILL");}catch{}
          finish(Error("VOD segment encoder timed out"));
        },30000);
        p.once("error",finish);
        p.once("exit",code=>finish(code===0?null:Error("VOD segment encoder failed")));
      });
      if(session.stopping) throw Object.assign(Error("Session stopped"),{status:410});
      const stat=await fs.stat(temp);
      if(!stat.isFile() || stat.size<100 || stat.size>12*1024*1024)throw Error("Invalid encoded VOD segment");
      await fs.rename(temp,output);
      session.cache.set(index,true);
      while(session.cache.size>VOD_CACHE_SEGMENTS){
        const victim=[...session.cache.keys()].find(n=>n!==index && !session.pins.has(n));
        if(victim===undefined)break; // At most eight pinned downloads can temporarily extend the cache.
        session.cache.delete(victim);
        await fs.rm(path.join(session.dir,"segment_"+String(victim).padStart(5,"0")+".ts"),{force:true});
      }
      return output;
    } catch(error){
      await fs.rm(temp,{force:true}).catch(()=>{});
      throw error;
    }
  });
  session.queue=job;
  session.pending.set(index,job);
  try{return await job;}finally{session.pending.delete(index);}
}

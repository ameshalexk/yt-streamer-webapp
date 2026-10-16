// Lightweight catalog scheduler within the existing Node service.
// Four wall-clock checks: midnight, 6 AM, noon and 6 PM (Mac local time).
import fs from 'node:fs/promises';
import path from 'node:path';

const HOURS = 6;
const VERSION = 1;
export function nextApneCheckTime(date) {
  const now = new Date(date);
  if (!Number.isFinite(now.getTime())) throw TypeError('Invalid scheduler time');
  const next = new Date(now);
  next.setHours((Math.floor(now.getHours()/HOURS)+1)*HOURS,0,0,0);
  if(next<=now)next.setHours(next.getHours()+HOURS,0,0,0);
  return next;
}

export function createApneBackgroundCheck({dataDir,scan,clock=()=>new Date(),setTimer=setTimeout,clearTimer=clearTimeout,log=console.log}={}) {
  if(!dataDir||typeof scan!=='function')throw TypeError('Scheduler directory and scanner required');
  const file=path.join(dataDir,'apne-background-check-state.json');
  let started=false,mainTimer=null,catchupTimer=null,running=null,nextAt=null,state=null,loading=null;
  function load(){
    if(!loading)loading=(async()=>{
      try{const parsed=JSON.parse(await fs.readFile(file,'utf8'));
        if(parsed?.version===VERSION&&parsed.shows&&typeof parsed.shows==='object'&&!Array.isArray(parsed.shows))state=parsed;
      }catch(e){if(e.code!=='ENOENT')log('[apne-background] state read failed',e.message)}
      return state;
    })();
    return loading;
  }
  async function save(value){
    await fs.mkdir(dataDir,{recursive:true});
    const temp=file+'.tmp';
    await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
    await fs.rename(temp,file);
  }
  async function run(trigger='scheduled'){
    if(running)return {skipped:'already-running'};
    running=(async()=>{
      const old=await load(),startedAt=clock().toISOString();
      log('[apne-background] started',JSON.stringify({trigger,startedAt}));
      let update;
      try{
        const result=await scan(old?.shows||{});
        update={version:VERSION,lastStartedAt:startedAt,lastFinishedAt:clock().toISOString(),trigger,
          shows:result.shows,summary:{checkedShows:result.checkedShows||0,newEpisodes:result.newEpisodes||0,
            validatedSources:result.validatedSources||0,errors:(result.errors||[]).slice(0,8)}};
      }catch(e){
        update={version:VERSION,lastStartedAt:startedAt,lastFinishedAt:clock().toISOString(),trigger,
          shows:old?.shows||{},summary:{checkedShows:0,newEpisodes:0,validatedSources:0,errors:[String(e.message).slice(0,160)]}};
      }
      try{await save(update);state=update}catch(e){log('[apne-background] save failed',e.message)}
      log('[apne-background] finished',JSON.stringify(update.summary));
      return update.summary;
    })();
    try{return await running}finally{running=null}
  }
  function schedule(){
    if(!started)return;
    if(mainTimer)clearTimer(mainTimer);
    const date=clock(),target=nextApneCheckTime(date);
    nextAt=target.toISOString();
    mainTimer=setTimer(()=>{mainTimer=null;schedule();void run('scheduled')},Math.max(1000,target-date));
    mainTimer?.unref?.();
  }
  function start(){
    if(started)return;
    started=true;schedule();
    // If the Mac was offline for more than six hours, catch up once on startup.
    // Avoid duplicate checking shortly before the next regular six-hour slot.
    if(new Date(nextAt).getTime()-clock().getTime()>45*60000){
      catchupTimer=setTimer(()=>{
        catchupTimer=null;
        void load().then(old=>{
          const last=Date.parse(old?.lastStartedAt||'');
          if(!Number.isFinite(last)||clock().getTime()-last>HOURS*3600000)return run('startup-catchup');
        }).catch(e=>log('[apne-background] catchup failed',e.message));
      },20000);
      catchupTimer?.unref?.();
    }
    log('[apne-background] enabled',JSON.stringify({nextAt,intervalHours:HOURS}));
  }
  function stop(){
    started=false;
    if(mainTimer)clearTimer(mainTimer);
    if(catchupTimer)clearTimer(catchupTimer);
    mainTimer=null;catchupTimer=null;nextAt=null;
  }
  function status(){
    return {enabled:started,intervalHours:HOURS,localHours:[0,6,12,18],nextAt,
      running:Boolean(running),lastStartedAt:state?.lastStartedAt||null,
      lastFinishedAt:state?.lastFinishedAt||null,lastSummary:state?.summary||null};
  }
  return {start,stop,run,status,load};
}

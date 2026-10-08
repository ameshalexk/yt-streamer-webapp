// Manual, isolated REAL-media probe; requires explicit local dev server on 127.0.0.1:18199.
// No production API, credentials, or personal playback data is read.
import { chromium } from "playwright-core";
const origin = process.env.AI_MEDIA_DEV_ORIGIN || "http://127.0.0.1:18199";
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ["mjpeg", "webcodecs"];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const browser = await chromium.launch({channel:"chrome",headless:true,args:["--no-first-run","--no-default-browser-check"]});
let exit = 0;
try {
  for (const method of modes) {
    const ctx = await browser.newContext({viewport:{width:1280,height:800}});
    await ctx.addInitScript((value)=>localStorage.setItem("ytStreamerYoutubePlaybackMethod",value),method);
    const page = await ctx.newPage();
    const failures = [];
    page.on("pageerror", e => failures.push("pageerror:"+e.message.slice(0,160)));
    page.on("response", r => {if (r.status() >= 400 && (/\/stream\/|\/api\/experimental\/|\/api\/youtube\/search/.test(r.url()))) failures.push("HTTP "+r.status()+" "+new URL(r.url()).pathname);});
    await page.goto(origin+"/?ai_agent_dev=1",{waitUntil:"load"});
    await page.waitForFunction(()=>Boolean(window.YTStreamerMediaAgent),{timeout:10000});
    const start=Date.now();
    const search=await page.evaluate(()=>window.YTStreamerMediaAgent.execute("search_media",{query:"Big Buck Bunny Blender short",limit:3}));
    const choice=search.result?.results?.[0];
    if (!choice) {console.log(JSON.stringify({method,error:"no_search_results",search}));exit=1;await ctx.close();continue;}
    const command=await page.evaluate(id=>window.YTStreamerMediaAgent.execute("play_media",{media_id:id}),choice.media_id).catch(e=>({error:e.message}));
    let observedReady=false, samples=[];
    for (let i=0;i<9;i++) {
      await delay(4000);
      const snapshot=await page.evaluate(()=>{
        const screen=document.querySelector("#screen");
        const audio=document.querySelector("#audio");
        const video=document.querySelector("#video");
        return {
          agent:window.YTStreamerMediaAgent?.get_player_state?.(),
          loading:screen?.classList.contains("loading"), playing:screen?.classList.contains("playing"),
          badge:document.querySelector("#streamBadge")?.textContent,
          error:document.querySelector("#streamNoticeDetail")?.textContent?.slice(0,150),
          audio:{src:!!audio?.getAttribute("src"),paused:audio?.paused,readyState:audio?.readyState,muted:audio?.muted,currentTime:audio?.currentTime},
          video:{paused:video?.paused,readyState:video?.readyState,currentTime:video?.currentTime},
          buffered:activeCompat?.bufferedPlayer?.getStats?.() && {
            state:activeCompat.bufferedPlayer.getStats().state,
            renderedFrames:activeCompat.bufferedPlayer.getStats().renderedFrames,
            lastAvDriftMs:activeCompat.bufferedPlayer.getStats().lastAvDriftMs
          }
        };
      });
      if(snapshot.playing&&!snapshot.loading)observedReady=true;
      samples.push({t:Date.now()-start,...snapshot});
      if(i>=3&&observedReady)break;
    }
    const final=samples.at(-1);
    console.log(JSON.stringify({method,elapsedMs:Date.now()-start,searchCount:search.result.results.length,mediaId:choice.media_id,command,observedReady,firstReadyMs:samples.find(s=>s.playing&&!s.loading)?.t??null,samples,failures:failures.slice(0,12)}));
    if(!observedReady)exit=1;
    await ctx.close();
  }
}finally{await browser.close();}
process.exitCode=exit;

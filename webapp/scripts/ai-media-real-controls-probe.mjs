// Manual real YouTube control regression. Run only against an approved isolated loopback dev server.
// No production connection, no credentials, and no physical Tesla assertions.
import { chromium } from "playwright-core";
const origin=process.env.AI_MEDIA_DEV_ORIGIN||"http://127.0.0.1:18199";
const mode=process.argv[2]||"mjpeg";
const browser=await chromium.launch({channel:"chrome",headless:true,args:["--no-first-run","--no-default-browser-check"]});
let failed=false;
const log=(action,result)=>console.log(JSON.stringify({mode,action,...result}));
try{
  const context=await browser.newContext();
  await context.addInitScript(m=>localStorage.setItem("ytStreamerYoutubePlaybackMethod",m),mode);
  const page=await context.newPage();
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message.slice(0,100)));
  await page.goto(origin+"/?ai_agent_dev=1",{waitUntil:"load"});
  await page.waitForFunction(()=>Boolean(window.YTStreamerMediaAgent));
  const execute=(a,args={})=>page.evaluate(([action,params])=>window.YTStreamerMediaAgent.execute(action,params),[a,args]);
  const state=()=>page.evaluate(()=>window.YTStreamerMediaAgent.get_player_state());
  const wait=async (phase,ms=16000)=>{const start=Date.now();try{
    await page.waitForFunction(v=>window.YTStreamerMediaAgent?.get_player_state?.().playback_phase===v,phase,{timeout:ms,polling:250});
    return {ready:true,elapsedMs:Date.now()-start,state:await state()};
  }catch{return {ready:false,elapsedMs:Date.now()-start,state:await state()};}};
  const s=await execute("search_media",{query:"Big Buck Bunny Blender official",limit:3});
  const candidates=s.result?.results||[];
  if(candidates.length<2)throw Error("need_two_real_search_results");
  log("search",{count:candidates.length});
  const start=Date.now();
  const play=await execute("play_media",{media_id:candidates[0].media_id});
  const first=await wait("playing",25000);
  log("play",{command:play,firstReadyMs:first.ready?Date.now()-start:null,...first});
  if(!first.ready)failed=true;
  const pause=await execute("pause");const paused=await state();
  log("pause",{command:pause,state:paused});if(paused.playback_phase!=="paused")failed=true;
  const resume=await execute("resume");const resumed=await wait("playing",15000);
  log("resume",{command:resume,...resumed});if(!resumed.ready)failed=true;
  const seek=await execute("seek",{position_seconds:90});const seeking=await state();
  const seeked=await wait("playing",25000);
  log("seek",{command:seek,intermediate:seeking,...seeked});
  if(!seeked.ready||seeked.state.position_seconds<85)failed=true;
  const next=await execute("next");const changed=await state();
  const nextReady=await wait("playing",25000);
  log("next",{command:next,changedId:changed.media_id,expectedId:candidates[1].media_id,...nextReady});
  if(!nextReady.ready||nextReady.state.media_id!==candidates[1].media_id)failed=true;
  log("fullscreen",{command:await execute("request_fullscreen")});
  log("volume",{command:await execute("set_volume",{value_percent:35})});
  log("pageerrors",{errors:errors.slice(0,10)});
  await context.close();
}catch(e){failed=true;log("fatal",{error:e.message});}
finally{await browser.close();}
process.exitCode=failed?1:0;

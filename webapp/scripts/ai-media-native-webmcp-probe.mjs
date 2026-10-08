// Chrome 149+ experimental *native* WebMCP smoke test. Requires isolated localhost dev server.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const origin=process.env.AI_MEDIA_DEV_ORIGIN||"http://127.0.0.1:18199";
const browser=await chromium.launch({channel:"chrome",headless:true,
  args:["--enable-features=WebMCPTesting","--no-first-run","--no-default-browser-check"]});
try{
  const page=await browser.newPage();
  await page.goto(origin+"/?ai_agent_dev=1",{waitUntil:"load"});
  await page.waitForFunction(()=>window.YTStreamerWebMCPStatus==="registered",{timeout:15000});
  const outcome=await page.evaluate(async()=>{
    const context=document.modelContext;
    const tools=await context.getTools();
    const execute=async(name,args)=>{
      const tool=tools.find(item=>item.name===name);
      if(!tool)throw Error("missing_webmcp_tool:"+name);
      // Chrome 154 expects JSON-string input; Chrome 155+ accepts a plain object.
      try {return JSON.parse(await context.executeTool(tool,args));}
      catch(error) {
        if(!String(error).includes("parse input"))throw error;
        return JSON.parse(await context.executeTool(tool,JSON.stringify(args)));
      }
    };
    return {api:typeof context.registerTool,toolNames:tools.map(item=>item.name),
      state:await execute("yt_player_state",{}),
      search:await execute("yt_search_media",{query:"Big Buck Bunny Blender",limit:2}),
      fullscreen:await execute("yt_request_fullscreen",{})};
  });
  assert.equal(outcome.api,"function");
  assert.equal(outcome.toolNames.length,8);
  assert.equal(outcome.state.playback_phase,"idle");
  assert.equal(outcome.search.status,"completed");
  assert.ok(outcome.search.result.results.length>0);
  // Fullscreen with inactive playback cannot become a native fullscreen grant.
  assert.equal(outcome.fullscreen.status,"failed");
  console.log(JSON.stringify({nativeWebMcp:true,registeredTools:outcome.toolNames,
    searchResults:outcome.search.result.results.length,readback:outcome.state.playback_phase,
    inactiveFullscreen:outcome.fullscreen.status}));
}finally{await browser.close();}

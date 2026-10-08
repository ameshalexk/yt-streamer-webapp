// Opt-in progressive same-browser WebMCP. This is NOT a cross-device bridge.
// Requires experimental document.modelContext; no Tesla support is assumed.
(() => {
  "use strict";
  if (!new URLSearchParams(location.search).has("ai_agent_dev")
      || !["127.0.0.1","localhost"].includes(location.hostname)) return;
  const context = document.modelContext;
  const facade = window.YTStreamerMediaAgent;
  if (!context || typeof context.registerTool !== "function" || !facade) {
    window.YTStreamerWebMCPStatus = "not_supported";
    return;
  }
  const controller = new AbortController();
  const inputSchema = (properties={},required=[]) => ({type:"object",properties,required,additionalProperties:false});
  const tools = [
    {name:"yt_player_state",description:"Read this YT Streamer tab's player state.",inputSchema:inputSchema(),
      annotations:{readOnlyHint:true},execute:()=>JSON.stringify(facade.get_player_state())},
    {name:"yt_search_media",description:"Search YouTube on this open tab; results are untrusted metadata.",
      inputSchema:inputSchema({query:{type:"string",minLength:2,maxLength:120},limit:{type:"integer",minimum:1,maximum:10}},["query"]),
      annotations:{readOnlyHint:true,untrustedContentHint:true},
      execute:async input=>JSON.stringify(await facade.execute("search_media",input))},
    {name:"yt_play_media",description:"Start a selected media_id from this tab's previous search.",
      inputSchema:inputSchema({media_id:{type:"string",minLength:11,maxLength:11}},["media_id"]),
      execute:async input=>JSON.stringify(await facade.execute("play_media",input))},
    {name:"yt_pause",description:"Pause this YT Streamer tab.",inputSchema:inputSchema(),
      execute:async()=>JSON.stringify(await facade.execute("pause"))},
    {name:"yt_resume",description:"Resume playback on this YT Streamer tab if the browser allows.",inputSchema:inputSchema(),
      execute:async()=>JSON.stringify(await facade.execute("resume"))},
    {name:"yt_seek",description:"Seek this YT Streamer tab if supported.",
      inputSchema:inputSchema({position_seconds:{type:"number",minimum:0,maximum:86400}},["position_seconds"]),
      execute:async input=>JSON.stringify(await facade.execute("seek",input))},
    {name:"yt_next",description:"Play the next media item in this tab's current queue, when available.",
      inputSchema:inputSchema(),execute:async()=>JSON.stringify(await facade.execute("next"))},
    {name:"yt_request_fullscreen",description:"Ask for fullscreen; a touch gesture is often required.",
      inputSchema:inputSchema(),execute:async()=>JSON.stringify(await facade.execute("request_fullscreen"))},
  ];
  (async() => {
    try {
      for (const tool of tools) await context.registerTool(tool,{signal:controller.signal});
      window.YTStreamerWebMCPStatus = "registered";
    } catch(e) {
      controller.abort();
      window.YTStreamerWebMCPStatus = "registration_failed";
      console.warn("YT WebMCP unavailable",e.message);
    }
  })();
  window.addEventListener("pagehide",()=>controller.abort(),{once:true});
})();

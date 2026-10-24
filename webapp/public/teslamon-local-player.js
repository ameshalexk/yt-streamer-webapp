// TeslaMon: this-tab-only player coordinator.
// Intentionally does not use the remote browser registry, selected-device
// persistence, WebSockets, global controller or another tab's identity.
// Explicit play requests use the first valid ranked search hit in this tab.
const ACTIONS=new Set([
  'search_and_play','pause','resume','get_playback_state',
  'request_fullscreen','exit_fullscreen'
]);
const VIDEO=/^[a-zA-Z0-9_-]{11}$/;
const PHASES=new Set(['idle','playing','paused','buffering','ended','failed','needs_user_gesture']);
const MODES=new Set(['native','in_page','none','unknown']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status='failed')=>({status,code});
const supported=(intent)=>{
  if(!plain(intent)||!ACTIONS.has(intent.tool)||!plain(intent.args))return false;
  const keys=Object.keys(intent.args);
  if(intent.tool!=='search_and_play')return keys.length===0;
  return keys.length===1&&keys[0]==='query'&&
    typeof intent.args.query==='string'&&
    intent.args.query.trim().length>=2&&intent.args.query.trim().length<=120&&
    !/^(?:https?:\/\/|www\.)/i.test(intent.args.query.trim());
};
export function createTeslaMonLocalPlayer({
  getPlayer=()=>globalThis.YTStreamerMediaAgent,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
}={}){
  if(typeof getPlayer!=='function'||typeof sleep!=='function')
    throw new TypeError('invalid_local_player_dependencies');
  let busy=false;
  const stateResult=(state,expectedAction)=>{
    if(!plain(state)||!PHASES.has(state.playback_phase))
      return fail('player_state_unavailable','uncertain');
    const phase=state.playback_phase;
    const fullscreenMode=MODES.has(state.fullscreen_kind)?state.fullscreen_kind:'unknown';
    if(expectedAction){
      const confirmed={
        pause:phase==='paused',
        resume:phase==='playing',
        request_fullscreen:fullscreenMode==='native'||fullscreenMode==='in_page',
        exit_fullscreen:fullscreenMode==='none'
      }[expectedAction];
      if(!confirmed)return {
        status:'accepted',code:'state_not_yet_confirmed',
        playbackPhase:phase,fullscreenMode
      };
    }
    return {status:'observed',playbackPhase:phase,fullscreenMode};
  };
  async function snapshot(player){
    const result=await player.execute('get_player_state',{});
    if(!plain(result)||result.status!=='completed')
      return fail('player_state_unavailable','uncertain');
    return stateResult(result.state);
  }
  async function run(intent){
    if(!supported(intent))return fail('invalid_local_playback_intent');
    if(busy)return fail('target_busy');
    const player=getPlayer();
    if(!player||typeof player.execute!=='function')
      return fail('local_player_not_ready','offline');
    busy=true;
    try{
      if(intent.tool==='get_playback_state')return await snapshot(player);
      if(intent.tool==='search_and_play'){
        // Playback intent is explicit. Search ranking decides the default;
        // invalid catalog entries are ignored, never used for playback.
        const query=intent.args.query.trim();
        const latestMkbhd=/\b(latest|newest|most recent)\b/i.test(query)&&
          /\b(mkbhd|marques brownlee)\b/i.test(query);
        const found=await player.execute('search_media',{query,limit:8,
          ...(latestMkbhd?{source:'latest_mkbhd'}:{})});
        if(found?.status!=='completed'||!Array.isArray(found?.result?.results))
          return fail('search_failed');
        const first=found.result.results.slice(0,8).find(item=>
          plain(item)&&VIDEO.test(item.media_id||''));
        if(!first)return fail('no_results');
        const mediaId=first.media_id;
        const result=await player.execute('play_media',{media_id:mediaId});
        if(result?.status==='needs_user_gesture')return fail('needs_user_gesture','needs_user_gesture');
        if(!['completed','accepted','playing','buffering'].includes(result?.status))
          return fail('playback_command_failed',result?.status==='unsupported'?'unsupported':'failed');
        // A new selection makes one fullscreen attempt in this same document.
        // Fullscreen is separate from playback: a browser gesture denial must
        // never turn an accepted play into a failed playback command.
        let fullscreenAttempt='unconfirmed';
        try{
          const fullscreen=await player.execute('request_fullscreen',{});
          if(fullscreen?.status==='needs_user_gesture')fullscreenAttempt='needs_user_gesture';
          else if(fullscreen?.status==='unsupported')fullscreenAttempt='unsupported';
        }catch{/* Fullscreen can fail while playback continues. */}
        const read=await snapshot(player);
        if(read.status!=='observed')return {...read,fullscreenAttempt};
        if(['native','in_page'].includes(read.fullscreenMode))fullscreenAttempt='observed';
        const direct=player.get_player_state?.();
        if(direct?.media_id===mediaId&&direct.playback_phase==='playing'&&
           (direct.mode!=='buffered_mjpeg'||Number(direct.rendered_frames)>0))
          return {...read,mediaId,fullscreenAttempt};
        // Streaming startup may be buffering. Never claim sound/video output.
        return {status:'accepted',code:'state_not_yet_confirmed',
          playbackPhase:read.playbackPhase,fullscreenMode:read.fullscreenMode,
          mediaId,fullscreenAttempt};
      }
      const result=await player.execute(intent.tool,{});
      if(result?.status==='needs_user_gesture')return fail('needs_user_gesture','needs_user_gesture');
      if(result?.status==='unsupported')return fail('unsupported','unsupported');
      if(!['completed','accepted','playing','paused','buffering'].includes(result?.status))
        return fail('playback_command_failed');
      const read=await snapshot(player);
      if(read.status!=='observed')return read;
      return stateResult({
        playback_phase:read.playbackPhase,fullscreen_kind:read.fullscreenMode
      },intent.tool);
    }catch{
      return fail('local_action_uncertain','uncertain');
    }finally{busy=false;}
  }
  // An accepted play action only selects a stream. Watch the SAME browser
  // tab for actual advancing video frames without blocking voice commands.
  async function observe(mediaId,{attempts=12,intervalMs=1000,isCurrent=()=>true}={}){
    if(!VIDEO.test(mediaId)||typeof isCurrent!=='function')
      return fail('invalid_playback_observation');
    const player=getPlayer();
    if(!player||typeof player.get_player_state!=='function')
      return fail('local_player_not_ready','offline');
    let priorFrames=null;
    for(let n=0;n<attempts;n++){
      await sleep(intervalMs);
      if(!isCurrent())return fail('playback_superseded','uncertain');
      let state;
      try{state=player.get_player_state();}catch{return fail('player_state_unavailable','uncertain');}
      if(!plain(state)||state.media_id!==mediaId)
        return fail('playback_interrupted','uncertain');
      if(state.playback_phase==='failed'||state.playback_phase==='needs_user_gesture')
        return fail('playback_stream_failed');
      if(state.playback_phase==='playing'){
        if(state.mode!=='buffered_mjpeg')
          return {status:'observed',playbackPhase:'playing'};
        const frames=Number(state.rendered_frames);
        if(Number.isFinite(frames)&&frames>0&&priorFrames!==null&&frames>priorFrames)
          return {status:'observed',playbackPhase:'playing'};
      }
      if(state.mode==='buffered_mjpeg'&&Number.isFinite(Number(state.rendered_frames)))
        priorFrames=Number(state.rendered_frames);
    }
    return fail('playback_not_confirmed','uncertain');
  }
  return Object.freeze({run,observe,get ready(){
    return typeof getPlayer()?.execute==='function';
  }});
}

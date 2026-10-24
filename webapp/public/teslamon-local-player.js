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
  getPlayer=()=>globalThis.YTStreamerMediaAgent
}={}){
  if(typeof getPlayer!=='function')
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
  // Confirm the requested video, not some previous video still playing.
  function isMediaPlaying(mediaId){
    if(!VIDEO.test(mediaId||''))return false;
    try{
      const state=getPlayer()?.get_player_state?.();
      return state?.media_id===mediaId&&state.playback_phase==='playing';
    }catch{return false;}
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
        const found=await player.execute('search_media',{query:intent.args.query.trim(),limit:8});
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
        if(direct?.media_id===mediaId&&direct.playback_phase==='playing')
          return {...read,fullscreenAttempt};
        // Streaming startup may be buffering. Never claim sound/video output.
        return {status:'accepted',code:'state_not_yet_confirmed',
          mediaId,
          playbackPhase:read.playbackPhase,fullscreenMode:read.fullscreenMode,
          fullscreenAttempt};
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
  return Object.freeze({run,isMediaPlaying,get ready(){
    return typeof getPlayer()?.execute==='function';
  }});
}

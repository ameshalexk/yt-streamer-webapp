// TeslaMon: this-tab-only player coordinator.
// Intentionally does not use the remote browser registry, selected-device
// persistence, WebSockets, global controller or another tab's identity.
// Search candidate tokens exist solely inside this page instance.
const ACTIONS=new Set([
  'search_and_play','pause','resume','get_playback_state',
  'request_fullscreen','exit_fullscreen'
]);
const VIDEO=/^[a-zA-Z0-9_-]{11}$/;
const PHASES=new Set(['idle','playing','paused','buffering','ended','failed','needs_user_gesture']);
const MODES=new Set(['native','in_page','none','unknown']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status='failed')=>({status,code});
const safeText=(value,limit)=>
  typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,limit):'';
const supported=(intent)=>{
  if(!plain(intent)||!ACTIONS.has(intent.tool)||!plain(intent.args))return false;
  const keys=Object.keys(intent.args);
  if(intent.tool!=='search_and_play')return keys.length===0;
  return keys.length===1&&(
    (keys[0]==='query'&&typeof intent.args.query==='string'&&
     intent.args.query.trim().length>=2&&intent.args.query.trim().length<=120&&
     !/^(?:https?:\/\/|www\.)/i.test(intent.args.query.trim()))||
    (keys[0]==='candidate_token'&&typeof intent.args.candidate_token==='string'&&
     /^[0-9a-f-]{36}$/i.test(intent.args.candidate_token))
  );
};
export function createTeslaMonLocalPlayer({
  getPlayer=()=>globalThis.YTStreamerMediaAgent,
  now=Date.now,
  makeToken=()=>{
    if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
    const bits=crypto.getRandomValues(new Uint8Array(16));
    bits[6]=(bits[6]&15)|64;bits[8]=(bits[8]&63)|128;
    const h=Array.from(bits,b=>b.toString(16).padStart(2,'0')).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+
      h.slice(16,20)+'-'+h.slice(20);
  },
  candidateTtlMs=45000
}={}){
  if(typeof getPlayer!=='function'||typeof now!=='function'||
    typeof makeToken!=='function'||!Number.isInteger(candidateTtlMs)||
    candidateTtlMs<1000||candidateTtlMs>120000)
    throw new TypeError('invalid_local_player_dependencies');
  let busy=false;
  const candidates=new Map();
  const invalidate=()=>candidates.clear();
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
        let mediaId;
        const args=intent.args;
        if('query' in args){
          invalidate();
          const found=await player.execute('search_media',{query:args.query.trim(),limit:8});
          if(found?.status!=='completed'||!Array.isArray(found?.result?.results))
            return fail('search_failed');
          const entries=[];
          const seen=new Set();
          for(const item of found.result.results.slice(0,8)){
            if(!plain(item)||!VIDEO.test(item.media_id||'')||seen.has(item.media_id))continue;
            seen.add(item.media_id);
            entries.push({media_id:item.media_id,title:safeText(item.title,160)||'Untitled video',
              creator:safeText(item.creator,100)});
          }
          if(!entries.length)return fail('no_results');
          if(entries.length===1)mediaId=entries[0].media_id;
          else{
            const choices=[];
            const tokens=new Set();
            for(const entry of entries){
              const token=makeToken();
              if(typeof token!=='string'||!(/^[0-9a-f-]{36}$/i).test(token)||tokens.has(token)){
                invalidate();return fail('candidate_generation_failed');
              }
              tokens.add(token);candidates.set(token,{id:entry.media_id,expires:now()+candidateTtlMs});
              choices.push({candidate_token:token,title:entry.title,creator:entry.creator});
            }
            return {status:'needs_selection',choices};
          }
        }else{
          const token=args.candidate_token;
          const candidate=candidates.get(token);
          invalidate(); // consume all choices exactly once, including stale choice
          if(!candidate||candidate.expires<=now())return fail('stale_or_unknown_candidate');
          mediaId=candidate.id;
        }
        const result=await player.execute('play_media',{media_id:mediaId});
        if(result?.status==='needs_user_gesture')return fail('needs_user_gesture','needs_user_gesture');
        if(!['completed','accepted','playing','buffering'].includes(result?.status))
          return fail('playback_command_failed',result?.status==='unsupported'?'unsupported':'failed');
        const read=await snapshot(player);
        if(read.status!=='observed')return read;
        const direct=player.get_player_state?.();
        if(direct?.media_id===mediaId&&direct.playback_phase==='playing')return read;
        // Streaming startup may be buffering. Never claim sound/video output.
        return {status:'accepted',code:'state_not_yet_confirmed',
          playbackPhase:read.playbackPhase,fullscreenMode:read.fullscreenMode};
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
  return Object.freeze({run,invalidate,get ready(){
    return typeof getPlayer()?.execute==='function';
  }});
}

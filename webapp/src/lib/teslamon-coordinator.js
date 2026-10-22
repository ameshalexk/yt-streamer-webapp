// TeslaMon S1 isolated composer. No HTTP endpoints, live browser, model or voice.
// Caller supplies already verified Access / selected-tab / ticket socket resolvers.
import {randomUUID} from 'node:crypto';
import {createTeslaMonSelectedRelay} from './teslamon-selected-relay.js';
import {createTeslaMonCandidateService} from './teslamon-candidates.js';
import {createTeslaMonMcpHandler} from './teslamon-private-mcp.js';

const MUTATIONS=new Set(['play_media','pause','resume','request_fullscreen','exit_fullscreen']);
const SNAPSHOTS=new Set(['idle','playing','paused','buffering','failed','needs_user_gesture']);
const VIDEO_ID=/^[A-Za-z0-9_-]{11}$/;
const AUDIO_OBSERVATIONS=new Set([
  'idle','unknown','element_missing','element_paused','element_muted',
  'element_buffering','element_playing_output_unverified'
]);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const out=(status,code)=>({status,...(code?{code}:{})});
const own=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function safeTitle(value){
  if(typeof value!=='string'||value.length===0)return undefined;
  return value.replace(/[\x00-\x1f\x7f<>&]/g,'').slice(0,160);
}

function sameTarget(a,b,now){
  return own(a)&&own(b)&&a.subject===b.subject&&a.controllerId===b.controllerId&&
    a.deviceKey===b.deviceKey&&a.connectionId===b.connectionId&&
    a.origin===b.origin&&Number.isSafeInteger(b.authExpiresAt)&&b.authExpiresAt>now;
}
function shapeState(frame,clock){
  if(frame?.status!=='completed'||!own(frame.state)||
    !SNAPSHOTS.has(frame.state.playback_phase))
    return out('uncertain','no_valid_player_readback');
  const when=Date.parse(frame.state.observed_at||'');
  if(!Number.isFinite(when)||when>clock()+1000||clock()-when>10000)
    return out('uncertain','stale_player_readback');
  const phase=frame.state.playback_phase;
  return {
    status:'observed',observed:true,
    playbackPhase:phase==='failed'?'error':
      phase==='needs_user_gesture'?'unknown':phase,
    fullscreenMode:frame.state.fullscreen_kind==='native'?'native':
      frame.state.fullscreen_kind==='in_page'?'in_page':
      frame.state.fullscreen_kind==='none'?'none':'unknown',
    observedAt:new Date(when).toISOString(),
    ...(VIDEO_ID.test(frame.state.media_id||'')?{mediaId:frame.state.media_id}:{}),
    ...(safeTitle(frame.state.title)?{title:safeTitle(frame.state.title)}:{}),
    ...(AUDIO_OBSERVATIONS.has(frame.state.audio_observation)?
      {audioObservation:frame.state.audio_observation}:{})
  };
}

export function createTeslaMonPrivateCoordinator({
  registry,readSelection,readController,readBrowser,
  ledger,clock=Date.now,makeId=randomUUID
}={}){
  if(!ledger||typeof ledger.run!=='function'||typeof clock!=='function'||
    typeof makeId!=='function')throw new TypeError('private_ledger_required');
  const relay=createTeslaMonSelectedRelay({
    registry,readSelection,readController,readBrowser,now:clock
  });
  async function issueRead(binding,expiry,{signal}={}){
    if(signal?.aborted)return out('cancelled','request_cancelled');
    const auth=await relay.getAuthority();
    if(!sameTarget(binding,auth,clock()))return out('offline','selected_tab_changed');
    const id=makeId();
    if(!uuid.test(id||''))return out('failed','invalid_request_id');
    const frame=await relay.dispatch({
      action:'get_player_state',args:{},commandId:id,
      binding,expiresAt:Math.min(clock()+30000,expiry,auth.authExpiresAt)
    },{signal});
    return frame;
  }
  async function route(command,{signal}={}){
    if(!own(command)||!own(command.binding)||!uuid.test(command.commandId||''))
      return out('failed','invalid_teslamon_command');
    if(signal?.aborted)return out('cancelled','request_cancelled');
    if(!MUTATIONS.has(command.action))return relay.dispatch(command,{signal});
    // Normalize the existing registry vocabulary *before* journaling; status
    // "completed" acknowledges delivery, not necessarily observed media.
    const tracked=await ledger.run(command,async (reserved,{signal})=>{
      const reply=await relay.dispatch(reserved,{signal});
      // Once the ledger has entered its dispatcher, cancellation cannot prove
      // that the selected browser did not receive the mutation. Preserve an
      // uncertain journal outcome so a later request cannot replay it.
      if(signal?.aborted)return {
        status:'uncertain',code:'cancelled_after_dispatch'
      };
      if(reply.status==='completed'||reply.status==='playing'||
        reply.status==='paused'||reply.status==='buffering')
        return {status:'accepted'};
      return {
        status:['accepted','failed','offline','unsupported',
          'needs_user_gesture','uncertain','cancelled'].includes(reply.status)?
          reply.status:'uncertain',
        code:reply.code
      };
    },{signal});
    return {
      commandId:command.commandId,subject:command.binding.subject,
      deviceKey:command.binding.deviceKey,
      connectionId:command.binding.connectionId,
      status:tracked.status,code:tracked.code
    };
  }
  const candidates=createTeslaMonCandidateService({
    getAuthority:relay.getAuthority,dispatch:route,clock,makeId
  });
  async function executeIntent(command,{signal}={}){
    if(!own(command)||command.ok!==true||!own(command.binding))
      return out('failed','invalid_bound_intent');
    if(signal?.aborted)return out('cancelled','request_cancelled');
    const current=await relay.getAuthority();
    if(!sameTarget(command.binding,current,clock()))
      return out('offline','selected_tab_changed');
    if(command.tool==='search_and_play')
      return candidates.searchAndPlay({tool:command.tool,args:command.args},{signal});

    if(command.tool==='get_playback_state'){
      const read=await issueRead(command.binding,command.expiresAt,{signal});
      return shapeState(read,clock);
    }
    if(command.tool!=='pause'&&command.tool!=='resume'&&
      command.tool!=='request_fullscreen'&&command.tool!=='exit_fullscreen')
      return out('failed','unsupported_intent');
    const action=command.tool;
    const ack=await route({
      action,args:{},binding:command.binding,
      commandId:command.commandId,expiresAt:command.expiresAt
    },{signal});
    if(ack.status!=='accepted')
      return out(ack.status,ack.code||'mutation_not_confirmed');
    const read=await issueRead(command.binding,command.expiresAt,{signal});
    const result=shapeState(read,clock);
    if(result.status!=='observed')return result;
    if((action==='pause'&&result.playbackPhase==='paused')||
      (action==='resume'&&result.playbackPhase==='playing')||
      (action==='request_fullscreen'&&['native','in_page'].includes(result.fullscreenMode))||
      (action==='exit_fullscreen'&&result.fullscreenMode==='none'))return result;
    return out('accepted','state_not_yet_confirmed');
  }
  return Object.freeze({
    relay,candidates,executeIntent,
    createMcpHandler(){
      return createTeslaMonMcpHandler({
        getAuthority:relay.getAuthority,
        // The generic MCP fixture callback remains deliberately unreachable:
        // all commands are routed through the typed integrated dispatcher.
        dispatch:()=>{throw Error('unrouted_call');},
        executeIntent,clock,makeId
      });
    }
  });
}

// TeslaMon isolated S1 fixture: scoped YouTube candidates and safe player dispatch.
// Not wired to any production endpoint or existing relay. No network listener.
import {randomBytes,randomUUID} from 'node:crypto';
import {
  TESLAMON_MAC_ORIGIN,validateTeslaMonIntent,bindTeslaMonCommand
} from './teslamon-contract.js';

const VIDEO_ID=/^[A-Za-z0-9_-]{11}$/;
const validObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const validText=(x,max)=>typeof x==='string'&&x.length>0&&x.length<=max&&
  !/[\x00-\x1f\x7f]/.test(x);
const out=(status,data={})=>Object.freeze({status,...data});
function sameTarget(a,b,now){
  return validObject(a)&&validObject(b)&&
    a.origin===TESLAMON_MAC_ORIGIN&&b.origin===TESLAMON_MAC_ORIGIN&&
    a.explicitSelection===true&&b.explicitSelection===true&&
    a.tabConsent===true&&b.tabConsent===true&&
    Number.isSafeInteger(a.authExpiresAt)&&a.authExpiresAt>now&&
    Number.isSafeInteger(b.authExpiresAt)&&b.authExpiresAt>now&&
    a.subject===b.subject&&a.controllerId===b.controllerId&&
    a.deviceKey===b.deviceKey&&a.connectionId===b.connectionId;
}
const copyResult=x=>({
  media_id:x.media_id,
  title:String(x.title||'').slice(0,160),
  creator:String(x.creator||'').slice(0,100)
});

/**
 * Builds a search/play coordinator against the pre-existing *private* player relay.
 *
 * getAuthority MUST read authenticated selected-tab state, not user/model parameters.
 * dispatch MUST route to exactly that connection and reject stale/expired targets.
 * Integration is intentionally absent until signed-identity/path proofs exist.
 */
export function createTeslaMonCandidateService({
  getAuthority,dispatch,clock=Date.now,
  makeToken=()=>randomBytes(24).toString('base64url'),
  makeId=randomUUID,ttlMs=45000,maxCandidates=10
}={}){
  if([getAuthority,dispatch,clock,makeToken,makeId].some(x=>typeof x!=='function')||
    !Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>60000||
    !Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>10)
    throw new TypeError('invalid_teslamon_candidate_config');

  const candidates=new Map();
  let batch=0;
  let active=false;

  function purge(){
    const now=clock();
    for(const [key,entry] of candidates)if(now>=entry.expiresAt)candidates.delete(key);
  }

  async function verifyFresh(original){
    const fresh=await getAuthority();
    return sameTarget(original,fresh,clock())?fresh:null;
  }

  async function send(action,args,authority){
    if(!await verifyFresh(authority))return out('offline',{code:'target_changed'});
    // The dispatch interface requires an immutable session/generation context.
    // The existing AgentSessionRegistry accepts commandId but production wiring
    // must still bind the selected *connection*, not its sole-online fallback.
    const id=makeId();
    if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return out('failed',{code:'invalid_command_id'});
    try{
      const result=await dispatch(Object.freeze({
        action,args:Object.freeze({...args}),commandId:id,
        binding:Object.freeze({
          origin:authority.origin,subject:authority.subject,
          controllerId:authority.controllerId,deviceKey:authority.deviceKey,
          connectionId:authority.connectionId
        }),
        expiresAt:Math.min(clock()+30000,authority.authExpiresAt)
      }));
      if(!await verifyFresh(authority))return out('uncertain',{code:'target_changed_after_dispatch'});
      if(!validObject(result))return out('uncertain',{code:'missing_ack'});
      if(result.commandId!==id||result.subject!==authority.subject||
        result.deviceKey!==authority.deviceKey||
        result.connectionId!==authority.connectionId)
        return out('uncertain',{code:'mismatched_command_ack'});
      return result;
    }catch{
      return out('uncertain',{code:'dispatch_failed_or_timed_out'});
    }
  }

  function loadResults(result,authority){
    if(result.status!=='completed'){
      if(result.status==='uncertain'||result.status==='offline')
        return out(result.status,{code:result.code||'search_not_completed'});
      return out('failed',{code:result.code||'search_not_completed'});
    }
    if(!validObject(result.result)||!Array.isArray(result.result.results))
      return out('failed',{code:'malformed_search_results'});
    const rows=result.result.results.slice(0,maxCandidates)
      .filter(x=>validObject(x)&&VIDEO_ID.test(x.media_id||'')&&
        validText(x.title,160));
    const unique=new Map();
    for(const row of rows)if(!unique.has(row.media_id))
      unique.set(row.media_id,copyResult(row));
    if(unique.size===0)return out('failed',{code:'no_results'});
    // Stage all tokens before publishing: a broken token generator must not
    // expose a partial candidate set.
    const expiresAt=Math.min(clock()+ttlMs,authority.authExpiresAt);
    const options=[];
    const staged=new Map();
    for(const row of unique.values()){
      const token=makeToken();
      if(typeof token!=='string'||!/^[A-Za-z0-9_-]{16,96}$/.test(token)||
        staged.has(token)||candidates.has(token))
        return out('failed',{code:'candidate_generation_failed'});
      staged.set(token,{row,authority,batch,expiresAt});
      options.push(Object.freeze({
        candidate_token:token,title:row.title,creator:row.creator
      }));
    }
    for(const [token,entry] of staged)candidates.set(token,entry);
    return out('needs_selection',{
      choices:Object.freeze(options),
      expiresAt
    });
  }

  async function play(row,authority){
    if(!await verifyFresh(authority))
      return out('offline',{code:'target_changed'});
    const ack=await send('play_media',{media_id:row.media_id},authority);
    if(['offline','uncertain','failed','unsupported'].includes(ack.status))
      return out(ack.status,{code:ack.code||ack.error||'play_not_confirmed'});
    // "accepted" or "completed" is only an ACK. Read the *same target* back.
    const state=await send('get_player_state',{},authority);
    if(!validObject(state)||state.status!=='completed'||!validObject(state.state))
      return out('uncertain',{code:'playback_readback_unavailable'});
    if(state.state.media_id!==row.media_id)
      return out('uncertain',{code:'wrong_or_stale_media_readback'});
    const stamp=state.state.observed_at;
    const observedAt=typeof stamp==='string'?Date.parse(stamp):NaN;
    if(!Number.isFinite(observedAt)||observedAt>clock()+1000||
      clock()-observedAt>10000)
      return out('uncertain',{code:'missing_or_stale_observation'});
    const phase=state.state.playback_phase;
    if(phase==='playing')return out('observed',{
      observed:true,playbackPhase:'playing',mediaId:row.media_id
    });
    if(phase==='buffering'||phase==='paused'||phase==='needs_user_gesture')
      return out('accepted',{
        observed:false,playbackPhase:phase,mediaId:row.media_id
      });
    return out('uncertain',{code:'no_verified_playback'});
  }

  async function searchAndPlay(intent){
    if(active)return out('failed',{code:'target_busy'});
    active=true;
    try{
      purge();
      // No authorization information may be taken from model-facing arguments.
      const valid=validateTeslaMonIntent({
        tool:intent?.tool,args:intent?.args
      });
      if(!valid.ok||valid.tool!=='search_and_play')
        return out('failed',{code:'invalid_intent'});
      const authority=await getAuthority();
      const bound=bindTeslaMonCommand(valid,authority,{
        commandId:makeId(),now:clock()
      });
      if(!bound.ok)return out('failed',{code:bound.error});
      if(valid.args.query!==undefined){
        // A new request revokes previous candidate set, even if the new
        // search is empty, times out, or fails during candidate generation.
        candidates.clear();
        batch++;
        if(valid.args.query.length>120)
          return out('failed',{code:'query_exceeds_player_limit'});
        const response=await send('search_media',{
          query:valid.args.query,limit:maxCandidates
        },authority);
        if(!await verifyFresh(authority))
          return out('offline',{code:'target_changed'});
        const result=loadResults(response,authority);
        if(result.status!=='needs_selection')return result;
        if(result.choices.length>1)return result;
        const single=result.choices[0];
        const entry=candidates.get(single.candidate_token);
        candidates.delete(single.candidate_token);
        return play(entry.row,authority);
      }
      const token=valid.args.candidate_token;
      const entry=candidates.get(token);
      // Consume on attempt. A repeated token MUST NOT cause a second play.
      if(!entry)return out('failed',{code:'stale_or_unknown_candidate'});
      candidates.delete(token);
      if(clock()>=entry.expiresAt||entry.batch!==batch||
        !sameTarget(entry.authority,authority,clock()))
        return out('failed',{code:'stale_or_wrong_target_candidate'});
      return play(entry.row,authority);
    }catch{
      return out('failed',{code:'candidate_service_failed'});
    }finally{active=false;}
  }

  return Object.freeze({
    searchAndPlay,
    invalidate(){batch++;candidates.clear();},
    get pendingCandidates(){purge();return candidates.size;}
  });
}

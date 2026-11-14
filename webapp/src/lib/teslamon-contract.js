// TeslaMon S0: side-effect-free interface definitions; no live integration.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL=/[\x00-\x1f\x7f]/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
  (Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
const keys=(obj,accepted)=>Object.keys(obj).every(x=>accepted.includes(x));
const name=(v,n=128)=>typeof v==='string'&&v.length>0&&v.length<=n&&!CONTROL.test(v);
const deny=code=>Object.freeze({ok:false,error:code});
export const TESLAMON_MAC_ORIGIN='https://stream.ameshalex.com';
export const TESLAMON_TOOLS=Object.freeze([
  'search_and_play','pause','resume','get_playback_state','request_fullscreen','exit_fullscreen'
]);
export const TESLAMON_OUTCOMES=Object.freeze([
  'received','accepted','observed','failed','unsupported','needs_user_gesture',
  'offline','uncertain','cancelled'
]);
export const TESLAMON_PLAYBACK_PHASES=Object.freeze([
  'idle','searching','buffering','playing','paused','ended','error','unknown'
]);
export const TESLAMON_FULLSCREEN_MODES=Object.freeze(['native','in_page','none','unknown']);

/** Only model input; caller cannot provide binding or target information. */
export function validateTeslaMonIntent(value){
  if(!plain(value)||!keys(value,['tool','args'])||!TESLAMON_TOOLS.includes(value.tool)||
    !plain(value.args))return deny('invalid_tool_call');
  const {tool,args}=value;
  if(tool!=='search_and_play'){
    if(Object.keys(args).length)return deny('unexpected_arguments');
    return Object.freeze({ok:true,tool,args:Object.freeze({})});
  }
  if(!keys(args,['query','candidate_token']))return deny('unexpected_arguments');
  const {query,candidate_token:token}=args;
  if((query===undefined)===(token===undefined))return deny('query_or_candidate_required');
  if(query!==undefined){
    if(typeof query!=='string'||query.trim().length<2||query.trim().length>160||
      CONTROL.test(query))return deny('invalid_query');
    return Object.freeze({ok:true,tool,args:Object.freeze({query:query.trim()})});
  }
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{16,96}$/.test(token))
    return deny('invalid_candidate_token');
  return Object.freeze({ok:true,tool,args:Object.freeze({candidate_token:token})});
}

/** authority must be independently read from the authenticated selected-tab relay. */
export function bindTeslaMonCommand(intent,authority,{
  commandId,now=Date.now(),deadlineMs=30000
}={}){
  const checked=validateTeslaMonIntent({tool:intent?.tool,args:intent?.args});
  if(intent?.ok!==true||checked.ok!==true)return deny('invalid_intent');
  if(!plain(authority)||authority.origin!==TESLAMON_MAC_ORIGIN)
    return deny('unsupported_origin');
  if(authority.explicitSelection!==true||authority.tabConsent!==true)
    return deny('target_not_authorized');
  if(!name(authority.subject,256)||!name(authority.controllerId)||
    !UUID.test(authority.deviceKey||'')||!UUID.test(authority.connectionId||'')||
    !Number.isSafeInteger(authority.authExpiresAt)||authority.authExpiresAt<=now)
    return deny('invalid_or_expired_binding');
  if(!UUID.test(commandId||'')||!Number.isSafeInteger(now)||
    !Number.isSafeInteger(deadlineMs)||deadlineMs<1000||deadlineMs>30000)
    return deny('invalid_command_id_or_deadline');
  return Object.freeze({
    ok:true,tool:checked.tool,args:checked.args,commandId,
    binding:Object.freeze({
      subject:authority.subject,controllerId:authority.controllerId,
      deviceKey:authority.deviceKey,connectionId:authority.connectionId,
      origin:authority.origin
    }),
    issuedAt:now,expiresAt:Math.min(now+deadlineMs,authority.authExpiresAt)
  });
}

/** An ACK or accepted action is never evidence that playback was observed. */
export function validateTeslaMonObservation(reply,command,now=Date.now()){
  if(command?.ok!==true||!plain(reply))return deny('invalid_observation');
  const b=command.binding;
  if(reply.commandId!==command.commandId||reply.subject!==b.subject||
    reply.deviceKey!==b.deviceKey||reply.connectionId!==b.connectionId)
    return deny('wrong_command_or_target');
  if(!TESLAMON_OUTCOMES.includes(reply.status))return deny('invalid_outcome');
  if(reply.status!=='observed')
    return Object.freeze({ok:true,status:reply.status,observed:false});
  if(!Number.isSafeInteger(reply.observedAt)||reply.observedAt>now+1000||
    now-reply.observedAt>10000||reply.observedAt<command.issuedAt)
    return deny('stale_or_missing_readback');
  if(!TESLAMON_PLAYBACK_PHASES.includes(reply.playbackPhase)||
    !TESLAMON_FULLSCREEN_MODES.includes(reply.fullscreenMode))
    return deny('invalid_player_state');
  return Object.freeze({
    ok:true,status:'observed',observed:true,playbackPhase:reply.playbackPhase,
    fullscreenMode:reply.fullscreenMode,observedAt:reply.observedAt
  });
}

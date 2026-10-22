// Private TeslaMon relay adapter; isolated for TM-101.
// Integration owner must inject readSelection from the signed Access-authenticated
// relay state, never from model/user request parameters. No network listener.
import {validateMediaCommand} from './ai-media-agent-session-registry.js';
import {TESLAMON_MAC_ORIGIN} from './teslamon-contract.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO_ID=/^[A-Za-z0-9_-]{11}$/;
const CONTROL=/[\x00-\x1f\x7f]/;
const ACTIONS=new Set(['search_media','play_media','pause','resume','get_player_state']);
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const validString=(x,max=256)=>typeof x==='string'&&x.length>0&&x.length<=max&&!CONTROL.test(x);
const outcome=(status,code)=>Object.freeze({status,...(code?{code}:{})});

/**
 * readSelection() is a trusted zero-argument resolver supplied by the
 * production browser relay's Access-authenticated controller. It must return:
 * {
 * verified:true, origin, subject, controllerId, authExpiresAt,
 * explicitSelection:true, tabConsent:true,
 * deviceId, deviceKey, connectionId
 * }
 * The selected deviceId MUST match the existing registry registration for
 * that exact browser tab and connection, never the sole eligible fallback.
 */
export function createTeslaMonSelectedRelay({
  registry,readSelection,readController,readBrowser,now=Date.now,principal='owner'
}={}){
  if(!registry||typeof registry.connectionFor!=='function'||
    typeof registry.dispatch!=='function'||typeof readSelection!=='function'||
    typeof readController!=='function'||typeof readBrowser!=='function'||
    typeof now!=='function'||principal!=='owner')
    throw new TypeError('trusted_relay_dependencies_required');

  async function snapshot(){
    try{
    // No input arguments: untrusted text cannot choose an owner or target.
    const selection=await readSelection();
    if(!isObject(selection)||selection.verified!==true||
      selection.origin!==TESLAMON_MAC_ORIGIN||
      selection.explicitSelection!==true||selection.tabConsent!==true||
      !validString(selection.subject)||!validString(selection.controllerId,128)||
      !UUID.test(selection.deviceId||'')||
      !UUID.test(selection.deviceKey||'')||
      !UUID.test(selection.connectionId||'')||
      !Number.isSafeInteger(selection.authExpiresAt)||
      selection.authExpiresAt<=now())return null;
    // Independent authority sources:
    // 1. Controller identity comes from verified Cloudflare Access HTTP session.
    // 2. Browser tuple comes from the signed ticket-authenticated live socket.
    // 3. Selection comes from the explicit site selection, never an eligible-tab fallback.
    const controller=await readController();
    const browser=await readBrowser(selection.deviceId);
    if(!isObject(controller)||controller.verified!==true||
      controller.origin!==selection.origin||controller.subject!==selection.subject||
      controller.controllerId!==selection.controllerId||
      !Number.isSafeInteger(controller.authExpiresAt)||
      controller.authExpiresAt<=now()||
      !isObject(browser)||browser.verified!==true||
      browser.deviceId!==selection.deviceId||
      browser.deviceKey!==selection.deviceKey||
      browser.connectionId!==selection.connectionId||
      browser.subject!==selection.subject||
      browser.tabConsent!==true)return null;
    // Connection generation is returned by the real registry, not by the model.
    const activeConnection=registry.connectionFor(principal,selection.deviceId);
    if(activeConnection!==selection.connectionId)return null;
    return Object.freeze({
      origin:selection.origin,subject:selection.subject,
      controllerId:selection.controllerId,deviceId:selection.deviceId,
      deviceKey:selection.deviceKey,connectionId:activeConnection,
      authExpiresAt:Math.min(selection.authExpiresAt,controller.authExpiresAt),
      explicitSelection:true,tabConsent:true
    });
    }catch{return null;}
  }
  const same=(a,b)=>Boolean(a&&b&&a.subject===b.subject&&
    a.controllerId===b.controllerId&&a.deviceId===b.deviceId&&
    a.deviceKey===b.deviceKey&&a.connectionId===b.connectionId&&
    a.origin===b.origin&&a.authExpiresAt>now()&&b.authExpiresAt>now());

  async function getAuthority(){
    const selected=await snapshot();
    if(!selected)return null;
    // This result is for bindTeslaMonCommand/selected candidate service.
    const {deviceId:unused,...authority}=selected;
    return Object.freeze(authority);
  }
  async function dispatch(command,{signal}={}){
    // Never infer a target from online session count or queue resume.
    if(!isObject(command)||!isObject(command.binding)||
      !ACTIONS.has(command.action)||!UUID.test(command.commandId||'')||
      !Number.isSafeInteger(command.expiresAt)||command.expiresAt<=now())
      return outcome('failed','invalid_or_expired_command');
    try{validateMediaCommand(command.action,command.args);}catch{
      return outcome('failed','invalid_player_command');
    }
    if(command.action==='play_media'&&!VIDEO_ID.test(command.args?.media_id||''))
      return outcome('failed','invalid_youtube_candidate');
    const trusted=await snapshot();
    if(!trusted||!same(trusted,{
      ...command.binding,deviceId:trusted.deviceId,
      authExpiresAt:command.expiresAt
    })||trusted.connectionId!==registry.connectionFor(principal,trusted.deviceId))
      return outcome('offline','selected_target_not_authorized');
    if(signal?.aborted)return outcome('cancelled','cancelled_before_dispatch');
    // A generation mismatch is rejected even when another tab is online.
    // The registry itself verifies the session for deviceId and uses its
    // command ID to prevent duplicate sends while pending/completed.
    let raw;
    try{
      raw=await registry.dispatch({
        principal,deviceId:trusted.deviceId,action:command.action,
        args:command.args,commandId:command.commandId
      });
    }catch{
      return Object.freeze({
        status:'uncertain',code:'registry_dispatch_failed',
        commandId:command.commandId,subject:trusted.subject,
        deviceKey:trusted.deviceKey,connectionId:trusted.connectionId
      });
    }
    // Dispatch has occurred: any subsequent revocation is uncertain, not undone.
    const after=await snapshot();
    if(!same(trusted,after)||signal?.aborted)
      return Object.freeze({
        status:'uncertain',code:signal?.aborted?'cancelled_after_dispatch':'target_changed_after_dispatch',
        commandId:command.commandId,subject:trusted.subject,
        deviceKey:trusted.deviceKey,connectionId:trusted.connectionId
      });
    const base={
      commandId:command.commandId,subject:trusted.subject,
      deviceKey:trusted.deviceKey,connectionId:trusted.connectionId
    };
    if(!isObject(raw)||raw.command_id!==command.commandId||
      raw.device_id!==trusted.deviceId)return Object.freeze({
      ...base,status:'uncertain',code:'wrong_or_missing_registry_ack'
    });
    if(raw.status==='timeout_uncertain'||raw.status==='duplicate_command_id')
      return Object.freeze({...base,status:'uncertain',code:raw.status});
    if(raw.status==='offline'||raw.status==='rate_limited'||raw.status==='busy')
      return Object.freeze({...base,status:raw.status==='offline'?'offline':'failed',code:raw.status});
    if(raw.status==='unsupported'||raw.status==='needs_user_gesture')
      return Object.freeze({...base,status:raw.status});
    if(raw.status==='failed')return Object.freeze({...base,status:'failed',code:'player_failed'});
    if(!['completed','accepted','playing','paused','buffering'].includes(raw.status))
      return Object.freeze({...base,status:'uncertain',code:'unknown_registry_outcome'});
    const normalized=raw.status==='playing'||raw.status==='paused'||raw.status==='buffering'?
      'accepted':raw.status;
    // The *registry ACK* carries bounded player state. The original browser
    // timestamp is filtered by registry; timestamp here is ACK receipt,
    // not evidence of actual speaker output.
    const state=isObject(raw.state)?Object.freeze({
      ...raw.state,observed_at:new Date(now()).toISOString()
    }):undefined;
    return Object.freeze({
      ...base,status:normalized,
      ...(state?{state}:{}),
      ...(raw.result?{result:raw.result}:{})
    });
  }

  return Object.freeze({getAuthority,dispatch});
}

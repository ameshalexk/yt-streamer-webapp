// YT Streamer private AI playback control, gated by this site's Cloudflare Access.
// The page's signed HttpOnly Access cookie is handled by the browser and origin;
// never read or store JWTs in JavaScript. There are no HTTP control commands.
(() => {
  'use strict';
  if (location.protocol !== 'https:' || location.hostname !== 'stream.ameshalex.com') return;
  const ENABLED_KEY='ytStreamerAiMediaOptInV1';
  const TAB_KEY='ytStreamerAiMediaTabV1';
  const SUPPORTED=new Set(['get_player_state','search_media','play_media','pause','resume','stop']);
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const platform=/Tesla/i.test(navigator.userAgent)?'Tesla':/iPhone/i.test(navigator.userAgent)?'iPhone':/iPad/i.test(navigator.userAgent)?'iPad':'Desktop';
  let consent=false,tabKey=null;
  try{
    consent=localStorage.getItem(ENABLED_KEY)==='1';
    tabKey=sessionStorage.getItem(TAB_KEY);
    if(!UUID.test(tabKey||'')){
      tabKey=crypto.randomUUID();sessionStorage.setItem(TAB_KEY,tabKey);
    }
  }catch { consent=false;tabKey=crypto.randomUUID(); }
  const box=document.createElement('div');
  box.id='aiMediaProductionPanel';
  box.setAttribute('aria-label','ChatGPT playback controller');
  box.style.cssText='position:fixed;z-index:999990;bottom:10px;left:10px;max-width:min(340px,calc(100vw - 20px));background:#182330;color:#fff;border:1px solid #8192ac;border-radius:10px;padding:8px 10px;font:13px system-ui;box-shadow:0 2px 10px #0005';
  const status=document.createElement('span');status.id='aiMediaProductionStatus';
  status.setAttribute('role','status');status.textContent='AI playback is off';
  const toggle=document.createElement('button');toggle.type='button';toggle.id='aiMediaProductionToggle';
  toggle.textContent=consent?'Disable AI':'Enable AI';
  toggle.style.cssText='min-height:34px;margin-right:8px;font:inherit;padding:4px 10px;border-radius:7px;background:#f1f4fa;color:#182330;border:0';
  box.append(toggle,status);
  document.body.append(box);
  let socket=null,ticker=null,retryTimer=null,retryMs=1500,generation=0,deviceId=null;
  const completed=new Map();
  const report=value=>{status.textContent=value;};
  const snapshot=()=>{
    try{return globalThis.YTStreamerMediaAgent?.get_player_state?.()||{playback_phase:'idle'};}
    catch{return {playback_phase:'failed'};}
  };
  const send=value=>{
    if(socket?.readyState!==WebSocket.OPEN)return false;
    socket.send(JSON.stringify(value));return true;
  };
  const stopSocket=()=>{
    clearInterval(ticker);ticker=null;
    clearTimeout(retryTimer);retryTimer=null;
    const old=socket;socket=null;deviceId=null;
    if(old)old.close();
  };
  function scheduleRetry(epoch){
    if(!consent || epoch!==generation || retryTimer)return;
    retryTimer=setTimeout(()=>{
      retryTimer=null;if(document.visibilityState!=='hidden')connect();
      else scheduleRetry(epoch);
    },retryMs);
    retryMs=Math.min(25000,Math.round(retryMs*1.65));
  }
  async function execute(frame){
    if(!UUID.test(frame.command_id||'')||frame.device_id!==deviceId||
       !SUPPORTED.has(frame.action)||!frame.args||typeof frame.args!=='object'||
       Array.isArray(frame.args))return;
    if(completed.has(frame.command_id)){
      send(completed.get(frame.command_id));return;
    }
    let response;
    try{
      if(!globalThis.YTStreamerMediaAgent?.execute)throw Error('player_not_ready');
      response=await globalThis.YTStreamerMediaAgent.execute(frame.action,frame.args);
      if(typeof response?.status!=='string')throw Error('bad_player_response');
    }catch(ex){response={status:'failed',error:String(ex?.message||'playback_error').slice(0,100)};}
    const ack={kind:'ack',command_id:frame.command_id,status:response.status,
      state:snapshot(),result:response.result,error:response.error};
    completed.set(frame.command_id,ack);
    while(completed.size>256)completed.delete(completed.keys().next().value);
    send(ack);
  }
  function connect(){
    if(!consent||socket?.readyState===WebSocket.OPEN||socket?.readyState===WebSocket.CONNECTING)return;
    if(!navigator.onLine){report('AI: offline');scheduleRetry(generation);return;}
    const epoch=++generation;
    clearTimeout(retryTimer);retryTimer=null;
    report('AI: connecting…');
    const ws=new WebSocket('wss://stream.ameshalex.com/ai-agent/player');
    socket=ws;
    ws.addEventListener('open',()=>{
      if(socket!==ws||epoch!==generation)return;
      send({kind:'hello',tab_key:tabKey,label:platform+' YT Streamer',consent:true});
    });
    ws.addEventListener('message',event=>{
      if(socket!==ws||epoch!==generation)return;
      let msg;try{msg=JSON.parse(event.data);}catch{ws.close();return;}
      if(msg.kind==='registered'){
        if(!UUID.test(msg.device_id||'')||msg.tab_key!==tabKey){ws.close();return;}
        deviceId=msg.device_id;retryMs=1500;
        report('AI ready · '+platform+' · '+tabKey.slice(0,8));
        const beat=()=>send({kind:'heartbeat',state:snapshot()});
        beat();clearInterval(ticker);ticker=setInterval(beat,5000);
      }else if(msg.kind==='command'&&deviceId){void execute(msg);}
      else if(msg.kind==='remote_approval_request'){
        // General approval operations still require an explicit, separate
        // consent flow. Do not silently grant broad or external MCP scopes.
        report('AI: general approval needs a separate confirmation');
      }
    });
    ws.addEventListener('close',()=>{
      if(socket!==ws||epoch!==generation)return;
      clearInterval(ticker);ticker=null;socket=null;deviceId=null;
      completed.clear();
      if(consent){report('AI: reconnecting when browser is active');scheduleRetry(epoch);}
    });
    ws.addEventListener('error',()=>{if(socket===ws)report('AI: connection unavailable');});
  }
  toggle.addEventListener('click',event=>{
    if(!event.isTrusted||!navigator.userActivation?.isActive)return;
    if(consent){
      consent=false;try{localStorage.removeItem(ENABLED_KEY);}catch{}
      generation++;stopSocket();toggle.textContent='Enable AI';report('AI playback is off');
    }else{
      consent=true;try{localStorage.setItem(ENABLED_KEY,'1');}catch{}
      toggle.textContent='Disable AI';connect();
    }
  });
  window.addEventListener('online',()=>{if(consent){stopSocket();connect();}});
  window.addEventListener('pageshow',()=>{if(consent)connect();});
  document.addEventListener('visibilitychange',()=>{
    if(consent&&document.visibilityState==='visible'&&(!socket||socket.readyState!==WebSocket.OPEN)){
      stopSocket();connect();
    }
  });
  window.addEventListener('pagehide',()=>{generation++;stopSocket();});
  if(consent)connect();
})();

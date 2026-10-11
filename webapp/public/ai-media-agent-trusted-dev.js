// Explicit loopback-only browser test client. Never loaded by production HTML.
// Authentication is via server-verifiable, HttpOnly Cloudflare Access cookie;
// this script never reads/writes the token or asserts a principal.
(() => {
  "use strict";
  const config=new URLSearchParams(location.search);
  const port=Number(config.get("trusted_relay_port"));
  if(config.get("ai_agent_trusted_dev")!=="1" ||
      !["127.0.0.1","localhost"].includes(location.hostname) ||
      !Number.isInteger(port)||port<1024||port>65535)return;
  const panel=document.createElement("aside");
  panel.id="aiAccessDevPanel";
  Object.assign(panel.style,{position:"fixed",right:"12px",bottom:"12px",
    zIndex:"2147483600",padding:"10px",background:"#182330",color:"#fff",
    border:"2px solid #d4dce7",borderRadius:"10px",font:"14px system-ui"});
  const status=document.createElement("p");
  status.id="aiAccessDevStatus";status.textContent="Not connected";
  const start=document.createElement("button");
  start.id="aiAccessDevConnect";start.textContent="Connect verified test tab";
  panel.append("LOCAL ACCESS BRIDGE — test only",status,start);
  document.body.append(panel);
  let ws=null,online=false,device=null,heartbeat=null;
  const completed=new Map();
  const state=()=>window.YTStreamerMediaAgent?.get_player_state?.()||{};
  function reset(){clearInterval(heartbeat);heartbeat=null;online=false;device=null;}
  function send(frame){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(frame));}
  start.onclick=()=>{
    if(!window.YTStreamerMediaAgent){status.textContent="Player adapter unavailable";return;}
    const old=ws;ws=null;old?.close();reset();
    const socket=new WebSocket("ws://127.0.0.1:"+port+"/trusted/player");
    ws=socket;status.textContent="Verifying signed Access session";
    socket.onmessage=async(event)=>{
      let message;try{message=JSON.parse(event.data);}catch{return;}
      if(socket!==ws)return;
      if(message.kind==="registered"){
        device=message.device_id;online=true;
        status.textContent="Signed browser paired: "+String(device).slice(0,8);
        heartbeat=setInterval(()=>send({kind:"heartbeat",state:state()}),1800);
        send({kind:"heartbeat",state:state()});return;
      }
      if(message.kind==="remote_approval_request" && online && message.device_id===device){
        const prompt=document.createElement("section");
        prompt.id="aiAccessDevApproval";
        const msg=document.createElement("p");
        msg.textContent="Allow "+String(message.subject).slice(0,100)+" to use "+
          (Array.isArray(message.actions)?message.actions.join(", ").slice(0,200):"")+"?";
        const approve=document.createElement("button");
        approve.id="aiAccessDevApprove";approve.textContent="Approve selected actions";
        const decline=document.createElement("button");
        decline.textContent="Decline";
        prompt.append(msg,approve,decline);panel.append(prompt);
        const cleanup=()=>{clearTimeout(expiry);prompt.remove();};
        const expiry=setTimeout(cleanup,60000);
        decline.onclick=cleanup;
        approve.onclick=event=>{
          if(!event.isTrusted||!online||socket!==ws)return;
          send({kind:"approve_remote_request",request_id:message.request_id});
          cleanup();
        };
        return;
      }
      if(message.kind!=="command"||message.device_id!==device||!online)return;
      const id=message.command_id;
      if(typeof id!=="string"||id.length>100)return;
      if(completed.has(id)){const prior=completed.get(id);if(prior)send(prior);return;}
      completed.set(id,null);
      if(completed.size>128)completed.delete(completed.keys().next().value);
      const ack={kind:"ack",command_id:id,status:"failed",state:state()};
      try{
        const outcome=await window.YTStreamerMediaAgent.execute(message.action,message.args||{});
        ack.status=outcome?.status||"failed";
        ack.state=state();ack.error=outcome?.error;
        if(outcome?.result)ack.result=outcome.result;
      }catch(e){ack.error=String(e?.message||"command_failed").slice(0,120);}
      completed.set(id,ack);send(ack);
    };
    socket.onclose=event=>{
      if(socket!==ws)return;
      reset();
      status.textContent=event.code===1008?"Access denied/expired; sign in before retry":
        "Disconnected; reconnect manually";
    };
    socket.onerror=()=>{status.textContent="Access WebSocket unavailable";};
  };
  window.addEventListener("visibilitychange",()=>{
    if(!document.hidden && online)send({kind:"heartbeat",state:state()});
  });
  window.addEventListener("pagehide",()=>{
    reset();const old=ws;ws=null;old?.close();
    status.textContent="Disconnected";
  });
})();

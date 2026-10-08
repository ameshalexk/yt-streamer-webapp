// Explicitly opted-in LOCAL DEVELOPMENT browser bridge. Never stores credentials.
// Opens only on a loopback page with ?ai_agent_dev=1; no production side effects.
(() => {
  "use strict";
  if (!new URLSearchParams(location.search).has("ai_agent_dev")
      || !["127.0.0.1", "localhost"].includes(location.hostname)) return;
  const ui = document.createElement("aside");
  ui.id = "aiAgentDevPanel";
  Object.assign(ui.style, { position:"fixed", right:"12px", bottom:"12px", zIndex:"2147483600",
    width:"min(340px,90vw)", padding:"12px", background:"#182330", color:"#fff",
    border:"2px solid #d4dce7", borderRadius:"12px", font:"14px system-ui", boxShadow:"0 4px 20px #0009" });
  const title = document.createElement("strong");
  title.textContent = "LOCAL AI MEDIA — development only";
  const status = document.createElement("p"); status.textContent = "Disconnected";
  status.setAttribute("role", "status"); status.id = "aiAgentStatus";
  const relayInput = document.createElement("input"); relayInput.id = "aiAgentRelay";
  relayInput.placeholder = "Relay port (e.g. 8123)"; relayInput.type = "number";
  const proofInput = document.createElement("input"); proofInput.id = "aiAgentPairing";
  proofInput.type = "password"; proofInput.placeholder = "Pairing proof (local only)";
  proofInput.autocomplete = "off";
  const labelInput = document.createElement("input"); labelInput.id = "aiAgentLabel";
  labelInput.placeholder = "Tab label"; labelInput.value = "Dev browser tab";
  const connect = document.createElement("button"); connect.textContent = "Pair this tab"; connect.id = "aiAgentConnect";
  const idField = document.createElement("code"); idField.id = "aiAgentDevice";
  const ownerInput = document.createElement("input"); ownerInput.id = "aiAgentOwner";
  ownerInput.type = "password"; ownerInput.placeholder = "Controller token (other tab)"; ownerInput.autocomplete = "off";
  const refresh = document.createElement("button"); refresh.textContent = "List devices"; refresh.id = "aiAgentRefresh";
  const picker = document.createElement("select"); picker.id = "aiAgentTarget";
  const actionPicker = document.createElement("select"); actionPicker.id = "aiAgentAction";
  for (const action of ["get_player_state","pause","resume","next","seek","search_media","play_media","set_volume","request_fullscreen"]) {
    const o = document.createElement("option"); o.value = action; o.textContent = action; actionPicker.append(o);
  }
  const argInput = document.createElement("input"); argInput.id = "aiAgentArg";
  argInput.placeholder = "Query, media ID, seconds or volume %";
  const send = document.createElement("button"); send.id = "aiAgentSend"; send.textContent = "Send to selected tab";
  const result = document.createElement("pre"); result.id = "aiAgentResult";
  Object.assign(result.style, {whiteSpace:"pre-wrap",maxHeight:"110px",overflow:"auto",fontSize:"11px"});
  const hide = document.createElement("button"); hide.textContent = "Hide"; hide.onclick = () => ui.hidden = true;
  for (const input of [relayInput,proofInput,labelInput,ownerInput,argInput,picker,actionPicker]) {
    Object.assign(input.style,{display:"block",width:"100%",margin:"5px 0",boxSizing:"border-box",padding:"5px"});
  }
  for (const el of [title,status,relayInput,proofInput,labelInput,connect,idField,ownerInput,refresh,picker,actionPicker,argInput,send,result,hide]) ui.append(el);
  document.body.append(ui);
  let ws, heartbeat, retry, online = false, active = false, device = null;
  let relayPort = null, pairing = "", label = "";
  const received = new Map();
  let failures = 0;
  const validPort = () => {
    const port = Number(relayInput.value);
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
  };
  function resetConnection() {
    clearInterval(heartbeat); clearTimeout(retry);
    online = false; device = null; idField.textContent = "";
  }
  const state = () => window.YTStreamerMediaAgent?.get_player_state?.() || {};
  function dial() {
    if (!active) return;
    const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/dev/player`);
    ws = socket;
    socket.onopen = () => {
      failures = 0;
      socket.send(JSON.stringify({kind:"pair",proof:pairing,label}));
    };
    socket.onmessage = async (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.kind === "registered") {
        device = message.device_id; online = true;
        idField.textContent = device;
        status.textContent = "Paired: " + label;
        proofInput.value = ""; // Credentials stay in volatile memory only.
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({kind:"heartbeat",state:state()}));
        }, 1800);
        socket.send(JSON.stringify({kind:"heartbeat",state:state()}));
      }
      if (message.kind === "remote_approval_request" && message.device_id === device && online) {
        // A local, visible user click is mandatory; no silent or programmatic autoapproval.
        const prompt = document.createElement("div");
        prompt.id = "aiAgentRemoteApproval";
        const question = document.createElement("p");
        question.textContent = "Remote Access identity " + String(message.subject).slice(0,120)
          + " requests " + (Array.isArray(message.actions) ? message.actions.join(", ") : "")
          + " on this tab. Approve for up to 2 minutes?";
        const approve = document.createElement("button");
        approve.id = "aiAgentApproveRemote";
        approve.textContent = "Approve remote agent";
        const decline = document.createElement("button");
        decline.textContent = "Decline";
        prompt.append(question,approve,decline);
        ui.append(prompt);
        const remove = () => {clearTimeout(expiry);prompt.remove();};
        const expiry = setTimeout(remove,60000);
        decline.onclick = remove;
        approve.onclick = (event) => {
          if (!event.isTrusted || !online || socket !== ws || socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({kind:"approve_remote_request",request_id:message.request_id}));
          remove();
        };
        return;
      }
      if (message.kind !== "command" || message.device_id !== device || !online) return;
      const id = message.command_id;
      if (typeof id !== "string" || id.length > 100) return;
      if (received.has(id)) { const previous = received.get(id); if (previous) socket.send(JSON.stringify(previous)); return; }
      const ack = {kind:"ack",command_id:id,status:"failed",error:"adapter_unavailable",state:state()};
      received.set(id, null); // Reserve immediately so duplicates cannot rerun concurrent mutations.
      if (received.size > 128) received.delete(received.keys().next().value);
      try {
        const outcome = await window.YTStreamerMediaAgent?.execute?.(message.action,message.args || {});
        ack.status = outcome?.status || "failed";
        ack.error = outcome?.error;
        ack.state = state();
        // The ACK confirms handling; the observed media phase is a separate assertion.
        if (ack.status === "accepted" && ["play_media","next","seek","resume"].includes(message.action)) {
          if (ack.state.playback_phase === "playing") ack.status = "playing";
          else if (ack.state.playback_phase === "buffering") ack.status = "buffering";
          else if (ack.state.playback_phase === "failed") ack.status = "failed";
        }
        if (outcome?.result) ack.result = outcome.result;
      } catch(e) { ack.error = String(e?.message || "command_failed").slice(0,120); }
      received.set(id, ack);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(ack));
    };
    socket.onclose = () => {
      if (socket !== ws) return;
      resetConnection(); status.textContent = active ? "Disconnected; reconnecting" : "Disconnected";
      if (active) retry = setTimeout(dial, Math.min(6000, 350 * Math.pow(2, Math.min(4, failures++))));
    };
    socket.onerror = () => { status.textContent = "WebSocket unavailable"; socket.close(); };
  }
  connect.onclick = () => {
    if (!window.YTStreamerMediaAgent) { status.textContent = "Player adapter missing"; return; }
    const port = validPort();
    if (!port || proofInput.value.length < 32) { status.textContent = "Enter local port and pairing proof"; return; }
    active = false; ws?.close(); resetConnection();
    relayPort = port; pairing = proofInput.value; label = labelInput.value.trim().slice(0,64) || "Dev tab";
    active = true; dial();
  };
  async function controller(route, payload) {
    const port = validPort();
    if (!port || ownerInput.value.length < 32) throw new Error("Missing relay port/controller token");
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: payload ? "POST" : "GET",
      headers: {authorization: `Bearer ${ownerInput.value}`, "content-type":"application/json"},
      ...(payload ? {body:JSON.stringify(payload)} : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || String(response.status));
    return data;
  }
  refresh.onclick = async () => {
    try {
      const {devices} = await controller("/dev/devices");
      picker.replaceChildren();
      for (const item of devices) {
        const option = document.createElement("option");
        option.value = item.device_id; option.textContent = item.label+" — "+item.device_id.slice(0,8);
        picker.append(option);
      }
      result.textContent = JSON.stringify(devices,null,2);
    } catch(e) { result.textContent = String(e.message); }
  };
  send.onclick = async () => {
    const action = actionPicker.value;
    const value = argInput.value.trim();
    const args = action === "seek" ? {position_seconds:Number(value)}
      : action === "set_volume" ? {value_percent:Number(value)}
      : action === "play_media" ? {media_id:value}
      : action === "search_media" ? {query:value,limit:5} : {};
    if (!picker.value) { result.textContent = "Select an online device first"; return; }
    try { result.textContent = JSON.stringify(await controller("/dev/command", {device_id:picker.value,action,args}),null,2); }
    catch(e) { result.textContent = String(e.message); }
  };
  window.addEventListener("pagehide", () => { active = false; resetConnection(); ws?.close(); pairing = ""; });
})();

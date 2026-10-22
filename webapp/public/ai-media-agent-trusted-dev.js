// Opt-in localhost-only trusted browser client for development verification.
// Real public Cloudflare ingress and CSP review remain release gates.
// This script never reads, logs, or transmits an Access JWT in JavaScript.
(() => {
  "use strict";
  if (!["127.0.0.1", "localhost"].includes(location.hostname)
      || !new URLSearchParams(location.search).has("ai_agent_trusted_dev")) return;
  const supported = new Set(["get_player_state", "search_media", "play_media", "pause", "resume", "stop"]);
  const uuid = value => typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const panel = document.createElement("aside");
  panel.id = "aiAgentTrustedPanel";
  panel.setAttribute("aria-label", "Authenticated AI media device controls");
  panel.style.cssText = "position:fixed;z-index:2147483000;right:12px;bottom:12px;max-height:calc(100dvh - 24px);overflow:auto;width:min(340px,calc(100vw - 24px));padding:12px;background:#182330;color:#fff;border:2px solid #d4dce7;border-radius:12px;box-sizing:border-box;font:14px system-ui";
  const title = document.createElement("strong");
  title.textContent = "TRUSTED AI MEDIA · local test";
  const status = document.createElement("p");
  status.id = "aiAgentTrustedStatus";
  status.role = "status";
  status.textContent = "Not connected";
  const port = document.createElement("input");
  port.id = "aiAgentTrustedPort";
  port.setAttribute("aria-label", "Trusted relay localhost port");
  port.inputMode = "numeric";
  port.placeholder = "Trusted relay port";
  port.style.cssText = "width:100%;min-height:42px;margin:6px 0;box-sizing:border-box";
  const connect = document.createElement("button");
  connect.id = "aiAgentTrustedConnect";
  connect.textContent = "Connect this tab";
  const disconnect = document.createElement("button");
  disconnect.id = "aiAgentTrustedDisconnect";
  disconnect.textContent = "Disconnect";
  disconnect.disabled = true;
  for (const b of [connect, disconnect]) {
    b.type = "button";
    b.style.cssText = "min-height:44px;margin:6px 6px 6px 0";
  }
  const pendingHeading = document.createElement("p");
  pendingHeading.textContent = "Remote approval requests (manual permission required)";
  const requests = document.createElement("div");
  requests.id = "aiAgentTrustedRequests";
  requests.setAttribute("aria-live", "polite");
  requests.style.cssText = "display:grid;gap:8px";
  panel.append(title, status, port, connect, disconnect, pendingHeading, requests);
  document.body.append(panel);

  let socket = null;
  let deviceId = null;
  let generation = 0;
  let ticker = null;
  const approvals = new Map();
  const allowedActions = new Set();
  const setStatus = message => { status.textContent = message; };
  const clearRequests = () => { approvals.clear(); allowedActions.clear(); requests.replaceChildren(); };
  const send = frame => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  };
  const snapshot = () => {
    try { return globalThis.YTStreamerMediaAgent?.get_player_state?.() || {playback_phase:"idle"}; }
    catch { return {playback_phase:"failed"}; }
  };
  function reset() {
    clearInterval(ticker); ticker = null;
    socket = null; deviceId = null;
    clearRequests();
    connect.disabled = false; disconnect.disabled = true;
  }
  function promptApproval(frame) {
    if (!uuid(frame.request_id) || frame.device_id !== deviceId ||
      typeof frame.subject !== "string" || frame.subject.length > 300 ||
      !Array.isArray(frame.actions) || !frame.actions.length ||
      frame.actions.length > supported.size ||
      frame.actions.some(a => !supported.has(a)) ||
      new Set(frame.actions).size !== frame.actions.length ||
      approvals.has(frame.request_id)) {
      setStatus("Rejected invalid or unsupported permission request");
      return;
    }
    const card = document.createElement("section");
    card.style.cssText = "padding:8px;border:1px solid #8c9db0;border-radius:8px";
    const details = document.createElement("p");
    // Remote principal and action names are plain text, NEVER innerHTML.
    details.textContent = "Requester: " + frame.subject + " — Actions: " + frame.actions.join(", ");
    const approve = document.createElement("button");
    approve.type = "button"; approve.textContent = "Allow these actions"; approve.style.minHeight = "44px";
    approve.dataset.aiAction = "approve";
    const deny = document.createElement("button");
    deny.type = "button"; deny.textContent = "Dismiss"; deny.style.minHeight = "44px";
    deny.dataset.aiAction = "deny";
    const remove = () => { approvals.delete(frame.request_id); card.remove(); };
    approve.addEventListener("click", event => {
      // Programmatic dispatchEvent() is rejected; a real click is required.
      // This is NOT a substitute for the separate CSP/XSS audit.
      if (!event.isTrusted || !navigator.userActivation?.isActive) return;
      if (socket?.readyState !== WebSocket.OPEN || !approvals.has(frame.request_id)) return;
      for (const action of frame.actions) allowedActions.add(action);
      send({kind:"approve_remote_request",request_id:frame.request_id});
      remove();
      setStatus("Browser approved requested actions; remote client must claim its grant");
    });
    deny.addEventListener("click", event => {
      if (!event.isTrusted) return;
      remove();
      setStatus("Remote request dismissed without authorization");
    });
    card.append(details, approve, deny);
    approvals.set(frame.request_id, card);
    requests.append(card);
  }
  async function execute(frame) {
    if (!uuid(frame.command_id) || frame.device_id !== deviceId ||
        !supported.has(frame.action) || !allowedActions.has(frame.action)) return;
    let response;
    try {
      if (!globalThis.YTStreamerMediaAgent?.execute) throw Error("player_not_ready");
      response = await globalThis.YTStreamerMediaAgent.execute(frame.action, frame.args || {});
      if (!response || typeof response.status !== "string") throw Error("invalid_player_result");
    } catch (error) {
      response = {status:"failed",error:String(error?.message || "player_error").slice(0,100)};
    }
    send({kind:"ack",command_id:frame.command_id,status:response.status,
      state:snapshot(),result:response.result,error:response.error});
  }
  connect.addEventListener("click", event => {
    if (!event.isTrusted) return;
    const raw = port.value.trim();
    const selected = Number(raw);
    if (!/^\d{2,5}$/.test(raw) || !Number.isInteger(selected) || selected < 1024 || selected > 65535) {
      setStatus("Enter a local trusted relay port (1024–65535)"); return;
    }
    if (socket) socket.close();
    reset(); generation++;
    const own = generation;
    setStatus("Connecting using browser's signed Access cookie");
    // NEVER accept a URL or host from remote tool parameters.
    const ws = new WebSocket("ws://127.0.0.1:" + selected + "/trusted/player");
    socket = ws; connect.disabled = true;
    ws.addEventListener("message", event => {
      if (socket !== ws || own !== generation) return;
      let frame;try{frame=JSON.parse(event.data);}catch{setStatus("Invalid relay message");ws.close();return;}
      if (frame?.kind === "registered") {
        if (!uuid(frame.device_id)) {ws.close();return;}
        deviceId = frame.device_id;
        disconnect.disabled = false;
        setStatus("Authenticated browser paired: " + deviceId.slice(0,8));
        clearInterval(ticker);
        const beat = () => send({kind:"heartbeat",state:snapshot()});
        beat(); ticker = setInterval(beat,1800);
      } else if (frame?.kind === "remote_approval_request") {
        if (!deviceId) return;
        promptApproval(frame);
      } else if (frame?.kind === "command") {
        void execute(frame);
      } else if (frame?.kind === "remote_approval_rejected") {
        setStatus("Server rejected permission request");
      } else if (frame?.kind === "remote_approval_recorded") {
        setStatus("Remote permission confirmed by server");
      }
    });
    ws.addEventListener("error", () => { if (socket===ws) setStatus("Trusted relay connection failed");});
    ws.addEventListener("close", () => {
      if(socket!==ws || own!==generation)return;
      reset();setStatus("Disconnected; no remote action is authorized");
    });
  });
  disconnect.addEventListener("click", event => {
    if (!event.isTrusted) return;
    generation++;
    socket?.close();
    reset();setStatus("Disconnected by this tab");
  });
  addEventListener("pagehide", () => { generation++;socket?.close();reset();});
})();
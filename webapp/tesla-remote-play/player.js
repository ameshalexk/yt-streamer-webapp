const $ = (id) => document.getElementById(id);
const state = $("state");
const connectButton = $("connect");
const pairButton = $("pair");
const liveDisconnect = $("liveDisconnect");
const wakeButton = $("wake");
const retryButton = $("retry");
const audioToggle = $("audioToggle");
const qualityBefore = $("qualityBefore");
const qualityDuring = $("quality");
const player = $("player");
const canvas = $("screen");
const context = canvas.getContext("2d", { alpha: false });
var Module = {
  locateFile(path) {
    return new URL(path, document.baseURI).href;
  },
  onRuntimeInitialized() {
    window.__chiakiWasmReady = 1;
  },
};
const buttonBits = {
  cross: 1,
  circle: 2,
  square: 4,
  triangle: 8,
  left: 16,
  right: 32,
  up: 64,
  down: 128,
  l1: 256,
  r1: 512,
  l3: 1024,
  r3: 2048,
  options: 4096,
  share: 8192,
  touchpad: 16384,
  ps: 32768,
};
let api,
  consoleInfo,
  configured = false,
  active = false,
  connecting = false,
  stopping = false;
let decoderSetup,
  sessionFps = 60;
let videoDecoder,
  audioContext,
  audioNode,
  audioGain,
  frameTime = 0,
  haveKeyframe = false,
  parameterSets = [],
  audioChannels = 2,
  audioRate = 48000,
  selectedPad = null,
  lastInput = "";
let decodedFrames = 0,
  measuredFps = 0,
  firstPictureAt = 0,
  sessionStartedAt = 0,
  sessionStopListener = null,
  muted = false;
const report = (message) => {
  state.textContent = message;
};
const failure = () =>
  report("Connection failed. Check console, network and sign-in, then retry.");
const returnTargets = new Set([
  "/?mode=browse&ui=classic",
  "/?mode=browse&ui=new",
]);
const requestedReturn = new URLSearchParams(location.search).get("returnTo");
document.querySelector(".back").href = returnTargets.has(requestedReturn)
  ? requestedReturn
  : "/";
const savedQuality = sessionStorage.getItem("tesla-remote-play-quality");
if (savedQuality === "540" || savedQuality === "720") {
  qualityBefore.value = savedQuality;
  qualityDuring.value = savedQuality;
}
function saveQuality(value) {
  const profile = value === "540" ? "540" : "720";
  qualityBefore.value = profile;
  qualityDuring.value = profile;
  sessionStorage.setItem("tesla-remote-play-quality", profile);
}
qualityBefore.addEventListener("change", () =>
  saveQuality(qualityBefore.value),
);
qualityDuring.addEventListener("change", () =>
  saveQuality(qualityDuring.value),
);
function annexB(bytes) {
  const result = [];
  let start = -1;
  for (let i = 0; i + 3 < bytes.length; ) {
    const prefix =
      bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1
        ? 3
        : bytes[i] === 0 &&
            bytes[i + 1] === 0 &&
            bytes[i + 2] === 0 &&
            bytes[i + 3] === 1
          ? 4
          : 0;
    if (!prefix) {
      i++;
      continue;
    }
    if (start >= 0 && i > start) result.push(bytes.slice(start, i));
    start = i + prefix;
    i = start;
  }
  if (start >= 0 && start < bytes.length) result.push(bytes.slice(start));
  return result;
}
const nalType = (nal) => nal[0] & 31;
function lengthPrefix(nals) {
  const output = new Uint8Array(
    nals.reduce((total, nal) => total + 4 + nal.length, 0),
  );
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const nal of nals) {
    view.setUint32(offset, nal.length);
    output.set(nal, offset + 4);
    offset += 4 + nal.length;
  }
  return output;
}
function avcConfig(sps, pps) {
  const result = new Uint8Array(11 + sps.length + pps.length);
  let i = 0;
  result.set([1, sps[1], sps[2], sps[3], 255, 225], i);
  i += 6;
  result[i++] = sps.length >> 8;
  result[i++] = sps.length & 255;
  result.set(sps, i);
  i += sps.length;
  result[i++] = 1;
  result[i++] = pps.length >> 8;
  result[i++] = pps.length & 255;
  result.set(pps, i);
  return result;
}
async function configureDecoder(sps, pps) {
  const codec =
    "avc1." +
    [sps[1], sps[2], sps[3]]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  const description = avcConfig(sps, pps);
  const support = await VideoDecoder.isConfigSupported({
    codec,
    description,
    optimizeForLatency: true,
  });
  if (!support.supported) throw new Error("H264 unsupported");
  videoDecoder = new VideoDecoder({
    output(frame) {
      if (
        canvas.width !== frame.displayWidth ||
        canvas.height !== frame.displayHeight
      ) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      decodedFrames++;
      $("overlay").hidden = true;
      $("observed").textContent =
        "Observed: H.264 · " +
        canvas.width +
        "×" +
        canvas.height +
        " · about " +
        measuredFps +
        " fps";
      if (!firstPictureAt) {
        firstPictureAt = performance.now();
        connecting = false;
        report(
          "Connected · first picture in " +
            ((firstPictureAt - sessionStartedAt) / 1000).toFixed(1) +
            " s",
        );
      }
    },
    error() {
      haveKeyframe = false;
      report("Video decoding interrupted. Disconnect and retry.");
    },
  });
  videoDecoder.configure({ codec, description, optimizeForLatency: true });
}
async function onVideo(ptr, size, lost) {
  if (!active || !size) return;
  if (lost) haveKeyframe = false;
  const units = annexB(Module.HEAPU8.slice(ptr, ptr + size));
  for (const nal of units)
    if (nalType(nal) === 7 || nalType(nal) === 8)
      parameterSets.push(nal.slice());
  parameterSets = parameterSets.slice(-4);
  const sps = parameterSets.find((nal) => nalType(nal) === 7),
    pps = parameterSets.find((nal) => nalType(nal) === 8);
  if (!videoDecoder && sps && pps) {
    decoderSetup ??= configureDecoder(sps, pps);
    await decoderSetup;
  }
  if (!videoDecoder) return;
  const vcl = units.filter((nal) => ![7, 8, 9].includes(nalType(nal)));
  if (!vcl.length) return;
  const key = vcl.some((nal) => nalType(nal) === 5);
  if (!key && !haveKeyframe) return;
  frameTime += Math.round(1e6 / sessionFps);
  videoDecoder.decode(
    new EncodedVideoChunk({
      type: key ? "key" : "delta",
      timestamp: frameTime,
      data: lengthPrefix(vcl),
    }),
  );
  haveKeyframe ||= key;
}
async function ensureAudio() {
  if (audioContext) return audioContext.resume();
  audioContext = new AudioContext({ latencyHint: "interactive" });
  audioGain = audioContext.createGain();
  audioGain.gain.value = muted ? 0 : 1;
  audioGain.connect(audioContext.destination);
  await audioContext.resume();
  await audioContext.audioWorklet.addModule("audio-worklet.js");
  audioNode = new AudioWorkletNode(audioContext, "chiaki-audio-output", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  audioNode.connect(audioGain);
  audioNode.port.postMessage({ sourceRate: audioRate });
}
function onAudio(ptr, count) {
  if (!active || !audioNode) return;
  const pcm = Module.HEAP16.slice(ptr / 2, ptr / 2 + count * audioChannels);
  audioNode.port.postMessage({ pcm, channels: audioChannels }, [pcm.buffer]);
}
function bindWasm() {
  api = {
    init: Module.cwrap("chiaki_wasm_init", "number", ["string"]),
    netReady: Module.cwrap("chiaki_wasm_net_ready", "number", []),
    regist: Module.cwrap("chiaki_wasm_regist", "number", [
      "string",
      "number",
      "string",
      "number",
      "number",
    ]),
    sessionStart: Module.cwrap("chiaki_wasm_session_start", "number", [
      "string",
      "string",
      "string",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]),
    sessionStop: Module.cwrap("chiaki_wasm_session_stop", null, []),
    sessionSetController: Module.cwrap(
      "chiaki_wasm_session_set_controller",
      "number",
      [
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
      ],
    ),
    wakeup: Module.cwrap("chiaki_wasm_wakeup", "number", [
      "string",
      "string",
      "number",
    ]),
  };
  Module.onLog = () => {};
  Module.onVideo = (ptr, size, lost) =>
    void onVideo(ptr, size, lost).catch(failure);
  Module.onAudioSettings = (channels, rate) => {
    audioChannels = channels || 2;
    audioRate = rate || 48000;
    audioNode?.port.postMessage({ sourceRate: audioRate });
  };
  Module.onAudio = onAudio;
  Module.onEvent = (type) => {
    if (type === "connected") {
      active = true;
      connecting = false;
      report("Connected · waiting for first picture");
      $("overlay").textContent = "Waiting for first picture…";
    }
    if (type === "quit") {
      neutralInput();
      if (sessionStopListener) sessionStopListener();
      else if (active && !stopping)
        startFreshDocument("PS5 session ended. Use Connect to try again.");
    }
    if (type === "pin")
      report(
        "PS5 requested a sign-in PIN. Complete account sign-in on the console, then retry.",
      );
  };
  Module.onRegist = (info) => {
    if (!info.ok) {
      connecting = false;
      $("pin").value = "";
      $("accountId").value = "";
      startFreshDocument("Pairing failed. Check the code and try again.");
      return;
    }
    const registration = { registKey: info.registKey, morning: info.morning };
    fetch("/api/tesla-remote-play/console", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    })
      .then((response) => {
        if (!response.ok) throw Error("save");
        consoleInfo.registration = registration;
        startFreshDocument(
          "PS5 paired. Registration is stored for your signed-in account.",
        );
      })
      .catch(() =>
        startFreshDocument(
          "Pairing completed, but saving failed. Check sign-in and retry.",
        ),
      );
    $("pin").value = "";
    $("accountId").value = "";
  };
}
function startFreshDocument(message) {
  if (message) sessionStorage.setItem("tesla-remote-play-message", message);
  location.replace(location.pathname + location.search);
}
function browserLimitation() {
  if (
    !window.isSecureContext ||
    !crossOriginIsolated ||
    typeof SharedArrayBuffer !== "function"
  )
    return "Browser isolation and shared memory are required.";
  if (typeof VideoDecoder !== "function")
    return "This browser lacks the WebCodecs video decoder.";
  if (typeof AudioWorkletNode !== "function")
    return "This browser lacks AudioWorklet output.";
  return null;
}
async function loadRuntime() {
  if (window.__chiakiWasmReady && Module.cwrap) return;
  await new Promise((resolve, reject) => {
    Module.onRuntimeInitialized = () => {
      window.__chiakiWasmReady = 1;
      resolve();
    };
    Module.onAbort = () => reject(Error("WASM startup failed"));
    const script = document.createElement("script");
    script.src = "chiaki.js";
    script.onerror = () => reject(Error("WASM load failed"));
    document.head.append(script);
    setTimeout(() => reject(Error("WASM startup timed out")), 45000);
  });
}
async function prepareConnection() {
  const limitation = browserLimitation();
  if (limitation) throw new Error(limitation);
  try {
    await loadRuntime();
    bindWasm();
  } catch {
    throw new Error(
      "The Chiaki player could not start. Use Retry to reload it.",
    );
  }
  try {
    const url =
      (location.protocol === "https:" ? "wss" : "ws") +
      "://" +
      location.host +
      "/tesla-remote-play/posix-net";
    if (api.init(url) !== 0) throw Error("relay");
    const until = Date.now() + 8000;
    while (api.netReady() !== 1 && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (api.netReady() !== 1) throw Error("relay");
  } catch {
    throw new Error(
      "The relay did not connect. Check sign-in, another player, and the network.",
    );
  }
}
async function loadConsole() {
  const response = await fetch("/api/tesla-remote-play/console", {
    cache: "no-store",
  });
  if (!response.ok) throw Error("console");
  consoleInfo = await response.json();
  if (
    typeof consoleInfo.host !== "string" ||
    !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(consoleInfo.host)
  )
    throw Error("console missing");
  configured = true;
  connectButton.disabled = false;
  pairButton.disabled = false;
  wakeButton.disabled = !consoleInfo.registration;
  $("help").textContent = consoleInfo.registration
    ? "Registered PS5 ready. Pair again only to replace registration."
    : "PS5 address configured. Pair it once, then connect.";
}
async function refreshStatus() {
  try {
    const response = await fetch("/api/tesla-remote-play/status", {
      cache: "no-store",
      redirect: "manual",
    }).catch(() => null);
    if (!response) {
      if (!active && !connecting && !stopping)
        report("Cannot check Remote Play access. Check your network.");
      return;
    }
    if (!response.ok) throw Error("status");
    const data = await response.json();
    if (!data.available) throw Error("closed");
    if (!data.configured && (active || connecting)) throw Error("relay closed");
    if (!data.configured) {
      configured = false;
      consoleInfo = null;
      connectButton.disabled = true;
      pairButton.disabled = true;
      wakeButton.disabled = true;
    }
    if (!active && !connecting && !stopping)
      report(
        data.configured
          ? "Ready · signed in"
          : "Relay closed until the PS5 is configured",
      );
    if (data.configured && !active && !connecting) await loadConsole();
  } catch {
    if (active || connecting) {
      neutralInput();
      try {
        api?.sessionStop();
      } catch {}
      active = false;
      connecting = false;
      location.replace("/");
      return;
    }
    configured = false;
    consoleInfo = null;
    connectButton.disabled = true;
    pairButton.disabled = true;
    wakeButton.disabled = true;
    report("Tesla Remote Play is unavailable or sign-in expired.");
    $("help").textContent =
      "Configure the home PS5 before connecting. Return to the site and sign in again if needed.";
  }
}
async function pair() {
  const pin = $("pin").value.trim(),
    accountId = $("accountId").value.trim();
  if (!/^\d{8}$/.test(pin) || !/^[A-Za-z0-9+/]{11}=$/.test(accountId)) {
    report("Enter the 8-digit pairing code and base64 8-byte PSN account ID.");
    return;
  }
  if (connecting || active) return;
  pairButton.disabled = true;
  connecting = true;
  $("pin").value = "";
  $("accountId").value = "";
  try {
    await prepareConnection();
    if (api.regist(consoleInfo.host, Number(pin), accountId, 1, 0) !== 0) {
      throw Error(
        "Pairing could not start. Check the connection and try again.",
      );
    }
    report("Pairing request sent to the configured PS5.");
    setTimeout(
      () =>
        startFreshDocument(
          "Pairing did not finish. Open Pair Device for a fresh code.",
        ),
      30_000,
    );
  } catch (error) {
    startFreshDocument(error.message);
  }
}
async function connect() {
  if (!consoleInfo?.registration) {
    $("pairing").open = true;
    report("Pair this console before connecting.");
    return;
  }
  if (active || connecting) return;
  connecting = true;
  connectButton.disabled = true;
  liveDisconnect.disabled = false;
  player.hidden = false;
  $("overlay").hidden = false;
  $("overlay").textContent = "Starting PS5 session…";
  player.scrollIntoView({ behavior: "smooth", block: "center" });
  haveKeyframe = false;
  parameterSets = [];
  frameTime = 0;
  firstPictureAt = 0;
  sessionStartedAt = performance.now();
  retryButton.hidden = true;
  try {
    const limitation = browserLimitation();
    if (limitation) throw Error(limitation);
    try {
      await ensureAudio();
    } catch {
      throw Error("Audio output could not start. Use Retry to try again.");
    }
    await prepareConnection();
    const high = qualityDuring.value === "720";
    sessionFps = high ? 60 : 30;
    if (
      api.sessionStart(
        consoleInfo.host,
        consoleInfo.registration.registKey,
        consoleInfo.registration.morning,
        1,
        high ? 3 : 2,
        sessionFps,
        0,
        high ? 8000 : 4500,
      ) !== 0
    )
      throw Error("The PS5 session did not start. Use Retry to try again.");
    active = true;
    report("Connecting to PS5…");
    setTimeout(() => {
      if (active && !firstPictureAt)
        void disconnect(
          "No picture received. Check the PS5 and use Connect to try again.",
        );
    }, 45_000);
  } catch (error) {
    connecting = false;
    stopping = true;
    liveDisconnect.disabled = true;
    retryButton.hidden = false;
    $("overlay").textContent = "Remote Play could not start";
    report(error.message);
  }
}
function neutralInput() {
  const neutral = "0,0,0,0,0,0,0";
  if (active && api?.sessionSetController && lastInput !== neutral) {
    try {
      api.sessionSetController(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    } catch {}
  }
  lastInput = neutral;
}
async function disconnect(
  message = "Disconnected. The PS5 remains in its current power state.",
) {
  if (stopping) return;
  neutralInput();
  stopping = true;
  liveDisconnect.disabled = true;
  if (active || connecting) {
    const stopped = new Promise((resolve) => {
      sessionStopListener = resolve;
    });
    try {
      api?.sessionStop();
    } catch {}
    await Promise.race([
      stopped,
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  }
  active = false;
  connecting = false;
  startFreshDocument(message);
}
async function wakeConsole() {
  if (!consoleInfo?.registration || connecting || active) return;
  connecting = true;
  wakeButton.disabled = true;
  try {
    await prepareConnection();
    if (
      api.wakeup(consoleInfo.host, consoleInfo.registration.registKey, 1) !== 0
    )
      throw Error("wake");
    report("Wake request sent to the configured PS5.");
    setTimeout(
      () => startFreshDocument("Wake request sent to the configured PS5."),
      2500,
    );
  } catch {
    failure();
    wakeButton.disabled = false;
    startFreshDocument(
      "Wake request could not be sent. Check the connection and try again.",
    );
  }
}
function selectedGamepad() {
  const pads = navigator.getGamepads?.() || [];
  if (selectedPad !== null && pads[selectedPad]) return pads[selectedPad];
  const next = Array.from(pads).find((pad) => pad?.connected);
  if (next) selectedPad = next.index;
  return next || null;
}
function pollInput() {
  const pad = selectedGamepad();
  $("controller").textContent = pad
    ? "Controller: " + pad.id.slice(0, 56)
    : "Controller: waiting";
  if (!active || stopping || !api?.sessionSetController) return;
  if (!document.hasFocus() || document.hidden || !pad) {
    neutralInput();
    return;
  }
  let mask = 0;
  const mapping = [
    [0, "cross"],
    [1, "circle"],
    [2, "square"],
    [3, "triangle"],
    [4, "l1"],
    [5, "r1"],
    [8, "share"],
    [9, "options"],
    [10, "l3"],
    [11, "r3"],
    [12, "up"],
    [13, "down"],
    [14, "left"],
    [15, "right"],
    [16, "ps"],
    [17, "touchpad"],
  ];
  for (const [index, name] of mapping)
    if (pad.buttons[index]?.pressed) mask |= buttonBits[name];
  const axis = (value) =>
    Math.round(
      Math.abs(value) < 0.12 ? 0 : Math.max(-1, Math.min(1, value)) * 32767,
    );
  const values = [
    mask,
    Math.round((pad.buttons[6]?.value || 0) * 255),
    Math.round((pad.buttons[7]?.value || 0) * 255),
    axis(pad.axes[0] || 0),
    axis(pad.axes[1] || 0),
    axis(pad.axes[2] || 0),
    axis(pad.axes[3] || 0),
  ];
  const key = values.join(",");
  if (key !== lastInput && api.sessionSetController(...values, 0, 0, 0) === 0)
    lastInput = key;
}
window.addEventListener("gamepadconnected", (event) => {
  selectedPad = event.gamepad.index;
});
window.addEventListener("gamepaddisconnected", (event) => {
  if (event.gamepad.index === selectedPad) {
    selectedPad = null;
    neutralInput();
  }
});
window.addEventListener("blur", neutralInput);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) neutralInput();
});
window.addEventListener("pagehide", () => {
  neutralInput();
  if (active)
    try {
      api?.sessionStop();
    } catch {}
});
connectButton.addEventListener("click", connect);
liveDisconnect.addEventListener("click", () => void disconnect());
pairButton.addEventListener("click", pair);
wakeButton.addEventListener("click", wakeConsole);
retryButton.addEventListener("click", () =>
  location.replace(location.pathname + location.search),
);
audioToggle.addEventListener("click", () => {
  muted = !muted;
  if (audioGain) audioGain.gain.value = muted ? 0 : 1;
  audioToggle.textContent = muted ? "Enable audio" : "Mute audio";
  audioToggle.setAttribute("aria-pressed", String(muted));
});
setInterval(pollInput, 16);
setInterval(() => {
  measuredFps = decodedFrames;
  decodedFrames = 0;
  if (active && !stopping && api && api.netReady() !== 1) {
    neutralInput();
    stopping = true;
    active = false;
    connecting = false;
    try {
      api.sessionStop();
    } catch {}
    liveDisconnect.disabled = true;
    retryButton.hidden = false;
    $("overlay").hidden = false;
    $("overlay").textContent = "Network interrupted. Retry in a fresh session.";
    failure();
  }
}, 1000);
setInterval(() => {
  if (document.visibilityState === "visible") void refreshStatus();
}, 30000);
window.addEventListener("focus", () => void refreshStatus());
void refreshStatus().finally(() => {
  const message = sessionStorage.getItem("tesla-remote-play-message");
  if (message) {
    sessionStorage.removeItem("tesla-remote-play-message");
    report(message);
  }
});

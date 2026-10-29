import { createCyberdashPlayer } from "/cyberdash-embedded.mjs";

const $ = (id) => document.getElementById(id);
let guide = { channels: [], fetchedAt: 0 };
let chosenId = null;
let playerMode = "webcodecs";
let active = null;
let sessionId = 0;
let paused = false;
let guideLoading = false;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").style.color = error ? "#eb9c90" : "";
}
function currentChannel() {
  return guide.channels.find((channel) => channel.id === chosenId);
}
function setMode(mode) {
  playerMode = mode;
  for (const [id, value] of [["modeWeb", "webcodecs"], ["modeMjpeg", "mjpeg"]]) {
    $(id).classList.toggle("selected", value === mode);
    $(id).setAttribute("aria-pressed", String(value === mode));
  }
}
function updateGuide() {
  const root = $("channelList");
  root.replaceChildren();
  if (!guide.channels.length) {
    const p = document.createElement("p"); p.className = "loading";
    p.textContent = "No channels available. Refresh the guide to try again.";
    root.append(p); return;
  }
  for (const channel of guide.channels) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "channel";
    if (channel.id === chosenId) button.classList.add("active");
    const number = document.createElement("span"); number.className = "number";
    number.textContent = String(channel.number).padStart(2, "0");
    const text = document.createElement("span"); text.className = "channelText";
    const name = document.createElement("strong"); name.textContent = channel.name;
    const program = document.createElement("small"); program.textContent = channel.now.title;
    const next = document.createElement("em");
    const nextItem = channel.programmes.find((p) => p.title && p.title !== channel.now.title);
    next.textContent = nextItem ? "Next: " + nextItem.title : "On air now";
    text.append(name, program, next);
    button.append(number, text);
    button.addEventListener("click", () => tune(channel.id));
    root.append(button);
  }
}
function stopCurrent() {
  sessionId++;
  const previous = active; active = null;
  if (previous?.kind === "webcodecs") void previous.player.stop().catch(() => {});
  if (previous?.kind === "mjpeg") previous.player.destroy();
  const audio = $("retroAudio");
  audio.pause(); audio.removeAttribute("src"); audio.load();
  paused = false;
  $("togglePause").textContent = "Pause";
  $("togglePause").disabled = true;
  $("bufferIndicator").hidden = true;
}
function playbackOffset(channel) {
  const secondsSinceGuide = Math.max(0, (Date.now() - guide.fetchedAt) / 1000);
  return Math.min(channel.now.duration - 0.1, Math.max(0, channel.now.offset + secondsSinceGuide));
}
function showChannel(channel) {
  $("channelLabel").textContent = "CH " + channel.number + " · " + channel.name;
  $("programTitle").textContent = channel.now.title;
  $("screenPlaceholder").hidden = true;
  $("bufferIndicator").hidden = false;
  $("togglePause").disabled = false;
  updateGuide();
}
function errorFor(token, message) {
  if (token !== sessionId) return;
  $("bufferIndicator").hidden = true;
  status(message, true);
}
function launchWebCodecs(channel, offset, token) {
  if (!globalThis.VideoDecoder) {
    setMode("mjpeg");
    return launchMjpeg(channel, offset, token);
  }
  const player = createCyberdashPlayer({
    canvas: $("retroCanvas"),
    onPlaying: () => {
      if (token !== sessionId) return;
      $("bufferIndicator").hidden = true;
      status("Playing · WebCodecs");
    },
    onStatus: (state) => {
      if (token === sessionId && state !== "playing") status("WebCodecs · " + state);
    },
    onError: (error) => {
      if (token !== sessionId || playerMode !== "webcodecs") return;
      status("WebCodecs unavailable · switching to buffered MJPEG");
      // The WebCodecs session releases its decoder and AudioContext before fallback.
      setTimeout(() => {
        if (token !== sessionId) return;
        setMode("mjpeg");
        void tune(chosenId);
      }, 0);
    },
    onEnded: () => {
      if (token === sessionId) void refreshGuide({ autoAdvance: true });
    },
  });
  active = { kind: "webcodecs", player };
  // Do not await: begin AudioContext resume while the user gesture is active.
  void player.play({
    url: channel.now.url, height: 480, fps: 24, startAt: offset,
    muted: false, playbackRate: 1,
  }).catch((error) => {
    if (token === sessionId && playerMode === "webcodecs") {
      status("WebCodecs failed · switching to MJPEG");
      setMode("mjpeg"); void tune(chosenId);
    }
  });
}
function launchMjpeg(channel, offset, token) {
  const media = new URLSearchParams({
    url: channel.now.url,
    timestamp: String(Math.round(offset * 1000) / 1000),
    height: "480", fps: "12", buffered: "1",
  });
  const audioQuery = new URLSearchParams({
    url: channel.now.url,
    timestamp: String(Math.round(offset * 1000) / 1000),
  });
  const audio = $("retroAudio");
  audio.preload = "auto";
  audio.src = "/stream/audio/url?" + audioQuery;
  const player = new window.BufferedMjpeg.BufferedMjpegPlayer({
    url: "/stream/url?" + media,
    canvas: $("retroCanvas"), audio, fps: 12,
    sessionId: token, isCurrent: () => token === sessionId,
    audioEnabled: () => !audio.muted,
    audioClockOffset: 0,
    startupSeconds: 2, rebufferSeconds: 1,
    onState: (phase) => {
      if (token !== sessionId) return;
      status("Buffered MJPEG · " + phase);
      if (phase === "playing") $("bufferIndicator").hidden = true;
    },
    onError: (error) => errorFor(token, "MJPEG playback failed: " + error.message),
    onEnded: () => {
      if (token === sessionId) void refreshGuide({ autoAdvance: true });
    },
  });
  active = { kind: "mjpeg", player };
  // BufferedMjpegPlayer waits for the separate MP3 audio stream before it
  // starts showing frames. Mirror the existing main-player ready-event gate.
  const markAudioReady = () => {
    if (token !== sessionId || active?.player !== player) return;
    if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) player.setAudioReady(true);
  };
  audio.onloadedmetadata = markAudioReady;
  audio.onloadeddata = markAudioReady;
  audio.oncanplay = markAudioReady;
  audio.oncanplaythrough = markAudioReady;
  audio.onerror = () => {
    if (token !== sessionId || active?.player !== player) return;
    // Archive films with missing/unsupported audio can still show video.
    audio.muted = true;
    player.setAudioReady(true, { playable: false });
    status("Audio unavailable · continuing video-only");
  };
  audio.load();
  markAudioReady();
  void player.start().catch((error) => errorFor(token, error.message));
}
function tune(id) {
  const channel = guide.channels.find((item) => item.id === id);
  if (!channel) { status("Channel is no longer available.", true); return; }
  stopCurrent();
  chosenId = id;
  const token = sessionId;
  const offset = playbackOffset(channel);
  if (!Number.isFinite(offset) || offset < 0 || Date.now() >= channel.now.endsAt) {
    void refreshGuide({ autoAdvance: true }); return;
  }
  showChannel(channel);
  status("Tuning " + channel.name + "…");
  if (playerMode === "webcodecs") launchWebCodecs(channel, offset, token);
  else launchMjpeg(channel, offset, token);
}
async function refreshGuide({ autoAdvance = false } = {}) {
  if (guideLoading) return;
  guideLoading = true;
  try {
    const response = await fetch("/api/retro-tv/channels" + (autoAdvance ? "?refresh=1" : ""), { cache: "no-store" });
    if (!response.ok) throw new Error("Guide HTTP " + response.status);
    const data = await response.json();
    if (!Array.isArray(data.channels)) throw new Error("Invalid channel list");
    const old = currentChannel();
    guide = data;
    $("feedStatus").textContent = guide.channels.length + " channels · " + data.source;
    updateGuide();
    const selected = currentChannel();
    if (selected && old?.now?.id !== selected.now.id) {
      tune(chosenId);
    } else if (selected && autoAdvance) {
      stopCurrent();
      status("Programme finished. Waiting for the next programme…");
    } else if (chosenId && !selected) {
      stopCurrent(); chosenId = null;
      $("screenPlaceholder").hidden = false;
      status("Programme unavailable. Select another channel.");
    }
  } catch (error) {
    $("feedStatus").textContent = "Guide unavailable";
    if (!guide.channels.length) status(error.message, true);
  } finally { guideLoading = false; }
}
function changeChannel(direction) {
  if (!guide.channels.length) return;
  const index = guide.channels.findIndex((channel) => channel.id === chosenId);
  const next = ((index < 0 ? (direction > 0 ? -1 : 0) : index) + direction + guide.channels.length) % guide.channels.length;
  tune(guide.channels[next].id);
}
$("prev").addEventListener("click", () => changeChannel(-1));
$("next").addEventListener("click", () => changeChannel(1));
$("refresh").addEventListener("click", () => void refreshGuide());
$("modeWeb").addEventListener("click", () => {
  if (playerMode !== "webcodecs") { setMode("webcodecs"); if (chosenId) tune(chosenId); }
});
$("modeMjpeg").addEventListener("click", () => {
  if (playerMode !== "mjpeg") { setMode("mjpeg"); if (chosenId) tune(chosenId); }
});
$("fullscreen").addEventListener("click", () => {
  const surface = $("videoSurface");
  if (document.fullscreenElement) void document.exitFullscreen();
  else if (surface.requestFullscreen) void surface.requestFullscreen().catch(() => status("Fullscreen is unavailable."));
});
$("togglePause").addEventListener("click", async () => {
  if (!active) return;
  try {
    if (active.kind === "webcodecs") {
      if (paused) await active.player.resume(); else await active.player.pause();
    } else {
      if (paused) active.player.resumeUser(); else active.player.pauseUser();
    }
    paused = !paused;
    $("togglePause").textContent = paused ? "Resume" : "Pause";
  } catch (error) { status(error.message, true); }
});
document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === "ArrowRight") { event.preventDefault(); changeChannel(1); }
  if (event.key === "ArrowLeft") { event.preventDefault(); changeChannel(-1); }
});
document.addEventListener("visibilitychange", () => {
  if (active?.kind === "mjpeg") active.player.setVisible(!document.hidden);
});
setInterval(() => void refreshGuide(), 45_000);
void refreshGuide();

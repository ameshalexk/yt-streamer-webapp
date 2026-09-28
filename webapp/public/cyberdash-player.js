const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const ui = {
  url: $("url"),
  quality: $("quality"),
  play: $("play"),
  stop: $("stop"),
  canvas: $("canvas"),
  status: $("status"),
  detail: $("detail"),
  error: $("error"),
  clock: $("clock"),
  firstPicture: $("firstPicture"),
  rendered: $("rendered"),
  dropped: $("dropped"),
  drift: $("drift"),
  mbps: $("mbps"),
};

const ctx = ui.canvas.getContext("2d", { alpha: false });
let active = null;

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", ...options, signal: controller.signal });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) throw new Error(body.error || text || `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBytes(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

function setStatus(title, detail = "", error = "") {
  ui.status.textContent = title;
  ui.detail.textContent = detail;
  ui.error.textContent = error;
}

function resetMetrics() {
  ui.firstPicture.textContent = "—";
  ui.rendered.textContent = "0";
  ui.dropped.textContent = "0";
  ui.drift.textContent = "—";
  ui.mbps.textContent = "—";
  ui.clock.textContent = "0.0 s";
}

function updateMetrics(state) {
  ui.rendered.textContent = String(state.renderedFrames);
  ui.dropped.textContent = String(state.droppedFrames);
  ui.firstPicture.textContent = state.firstPictureMs == null ? "—" : `${Math.round(state.firstPictureMs)} ms`;
  const p95 = percentile(state.drifts.map(Math.abs), 0.95);
  ui.drift.textContent = p95 == null ? "—" : `${round(p95, 1)} ms`;
  const elapsed = Math.max(0.25, (performance.now() - state.startedAt) / 1000);
  const mbps = state.receivedBytes * 8 / elapsed / 1_000_000;
  ui.mbps.textContent = state.receivedBytes ? `${round(mbps, 2)}` : "—";
  if (state.audioStart != null && state.audioCtx) {
    ui.clock.textContent = `${Math.max(0, state.audioCtx.currentTime - state.audioStart).toFixed(1)} s`;
  }
}

async function sendSummary(state, result, message = "") {
  const p95 = percentile(state.drifts.map(Math.abs), 0.95);
  const lastDrift = state.drifts.length ? state.drifts[state.drifts.length - 1] : null;
  try {
    await fetch("/api/playback-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "cyberdash_player_summary",
        label: "experimental-cyberdash-v1",
        streamUrl: state.sourceUrl,
        message,
        reason: result,
        userAgent: navigator.userAgent,
        stats: {
          state: result,
          renderedFrames: state.renderedFrames,
          droppedFrames: state.droppedFrames,
          receivedBytes: state.receivedBytes,
          lastAvDriftMs: round(lastDrift, 1),
        },
        timing: {
          firstPictureMs: round(state.firstPictureMs, 1),
          avDriftP95Ms: round(p95, 1),
          resolveMs: round(state.resolveMs, 1),
          videoQueueMax: state.maxVideoQueue,
          audioQueueMax: state.maxAudioQueue,
          receivedMbps: round(state.receivedBytes * 8 / Math.max(0.25, (performance.now() - state.startedAt) / 1000) / 1_000_000, 2),
        },
      }),
    });
  } catch {}
}

async function stopServerSession(state) {
  if (!state?.sessionId) return;
  try {
    await fetch(`/api/experimental/cyberdash/${encodeURIComponent(state.sessionId)}/stop`, { method: "POST" });
  } catch {}
}

async function cleanupActive({ stopServer = true } = {}) {
  const state = active;
  if (!state) return;
  active = null;
  state.stopRequested = true;
  for (const frame of state.decodedVideo || []) {
    try { frame.close(); } catch {}
  }
  for (const node of state.audioNodes || []) {
    try { node.stop(); } catch {}
  }
  try { state.videoDecoder && state.videoDecoder.state !== "closed" && state.videoDecoder.close(); } catch {}
  try { state.audioDecoder && state.audioDecoder.state !== "closed" && state.audioDecoder.close(); } catch {}
  try { state.audioCtx && state.audioCtx.state !== "closed" && await state.audioCtx.close(); } catch {}
  if (stopServer) await stopServerSession(state);
  ui.play.disabled = false;
  ui.stop.disabled = true;
}

async function waitForInitialStatus(state) {
  const deadline = performance.now() + 25000;
  while (!state.stopRequested) {
    const status = await fetchJson(`/api/experimental/cyberdash/${state.sessionId}/status`, {}, 5000);
    if (status.error) throw new Error(status.error);
    if (
      status.manifestReady &&
      status.init?.video &&
      status.init?.audio &&
      status.available?.video?.length &&
      status.available?.audio?.length
    ) return status;
    if (status.done) throw new Error("DASH encoder ended before startup segments were ready");
    if (performance.now() > deadline) throw new Error("Timed out waiting for DASH startup segments");
    setStatus("Preparing H.264/AAC segments…", `video segments: ${status.available?.video?.length || 0}, audio segments: ${status.available?.audio?.length || 0}`);
    await sleep(150);
  }
  throw new Error("Stopped");
}

function avcDescription(MP4Box, sample) {
  const avcC = sample?.description?.avcC;
  if (!avcC) throw new Error("fMP4 video sample is missing AVC decoder configuration");
  const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
  avcC.write(stream);
  return new Uint8Array(stream.buffer.slice(8));
}

async function waitForVideoQueue(state, maxSize = 40) {
  const deadline = performance.now() + 2200;
  while (!state.stopRequested && state.videoDecoder?.state !== "closed" && state.videoDecoder.decodeQueueSize > maxSize) {
    state.maxVideoQueue = Math.max(state.maxVideoQueue, state.videoDecoder.decodeQueueSize || 0);
    if (performance.now() > deadline) throw new Error(`Video decode queue stayed above ${maxSize}`);
    await sleep(8);
  }
}

function playbackElapsed(state) {
  return state.audioStart == null ? 0 : Math.max(0, state.audioCtx.currentTime - state.audioStart);
}

async function holdIfTooFarAhead(state, lastPtsSec) {
  while (!state.stopRequested && state.audioStart != null && lastPtsSec - playbackElapsed(state) > 6.5) {
    await sleep(80);
  }
}

function scheduleAudioBuffer(state, item) {
  if (state.stopRequested) return;
  const node = state.audioCtx.createBufferSource();
  node.buffer = item.buffer;
  node.connect(state.audioCtx.destination);
  const target = state.audioStart + Math.max(0, item.timestamp / 1e6);
  node.start(Math.max(target, state.audioCtx.currentTime + 0.006));
  state.audioNodes.push(node);
  state.scheduledAudioBlocks++;
}

async function feedTrack(state, MP4Box, kind, initName) {
  const file = MP4Box.createFile();
  let offset = 0;
  let readyResolve;
  let readyReject;
  let configured = kind === "audio";
  let timestampOriginUs = null;
  let lastPtsSec = 0;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const pendingSamples = [];
  const fed = new Set();

  file.onError = (error) => readyReject(new Error(`MP4Box ${kind}: ${error}`));
  file.onReady = (info) => {
    try {
      const track = kind === "video" ? info.videoTracks[0] : info.audioTracks[0];
      if (!track) throw new Error(`No ${kind} track in fMP4 init`);
      file.setExtractionOptions(track.id, kind, { nbSamples: 1, rapAlignement: false });
      file.start();
      readyResolve(track);
    } catch (error) {
      readyReject(error);
    }
  };
  file.onSamples = (_id, _user, samples) => pendingSamples.push(...samples);

  const processPending = async () => {
    while (pendingSamples.length && !state.stopRequested) {
      const sample = pendingSamples.shift();
      const rawUs = Math.round(sample.cts * 1e6 / sample.timescale);
      if (timestampOriginUs == null) timestampOriginUs = rawUs;
      const timestamp = Math.max(0, rawUs - timestampOriginUs);
      const duration = Math.max(1, Math.round(sample.duration * 1e6 / sample.timescale));
      lastPtsSec = Math.max(lastPtsSec, (timestamp + duration) / 1e6);

      if (kind === "video") {
        if (!configured) {
          state.videoDecoder.configure({
            codec: state.manifest.video.codec || "avc1.42c01e",
            codedWidth: state.manifest.video.width || 1280,
            codedHeight: state.manifest.video.height || state.height || 720,
            hardwareAcceleration: "prefer-hardware",
            optimizeForLatency: true,
            description: avcDescription(MP4Box, sample),
          });
          configured = true;
        }
        await waitForVideoQueue(state, 40);
        state.videoDecoder.decode(new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp,
          duration,
          data: sample.data,
        }));
        state.maxVideoQueue = Math.max(state.maxVideoQueue, state.videoDecoder.decodeQueueSize || 0);
      } else {
        state.audioDecoder.decode(new EncodedAudioChunk({
          type: "key",
          timestamp,
          duration,
          data: sample.data,
        }));
        state.maxAudioQueue = Math.max(state.maxAudioQueue, state.audioDecoder.decodeQueueSize || 0);
      }
    }
  };

  const appendFile = async (name) => {
    const ab = await fetchBytes(`/stream/experimental/cyberdash/${state.sessionId}/${encodeURIComponent(name)}?t=${Date.now()}`);
    state.receivedBytes += ab.byteLength;
    ab.fileStart = offset;
    offset += ab.byteLength;
    file.appendBuffer(ab);
  };

  await appendFile(initName);
  await withTimeout(ready, 4000, `${kind} fMP4 init parse`);

  while (!state.stopRequested) {
    const status = await fetchJson(`/api/experimental/cyberdash/${state.sessionId}/status`, {}, 5000);
    if (status.error) throw new Error(status.error);
    const available = status.available?.[kind] || [];
    let progressed = false;

    for (const name of available) {
      if (fed.has(name)) continue;
      await holdIfTooFarAhead(state, lastPtsSec);
      await appendFile(name);
      fed.add(name);
      await processPending();
      progressed = true;
      updateMetrics(state);
    }

    if (status.done && available.every((name) => fed.has(name))) {
      file.flush();
      await processPending();
      return { lastPtsSec, segments: fed.size };
    }
    if (!progressed) await sleep(120);
  }

  throw new Error("Stopped");
}

function startRenderLoop(state) {
  return new Promise((resolve, reject) => {
    let rafId = 0;
    let timerId = 0;

    const schedule = () => {
      let fired = false;
      const run = () => {
        if (fired) return;
        fired = true;
        if (rafId) cancelAnimationFrame(rafId);
        if (timerId) clearTimeout(timerId);
        tick();
      };
      rafId = requestAnimationFrame(run);
      timerId = setTimeout(run, 50);
    };

    const tick = () => {
      try {
        if (state.stopRequested) return resolve();
        const elapsed = playbackElapsed(state);
        if (state.decodedVideo.length > 1) {
          state.decodedVideo.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        }

        while (
          state.decodedVideo.length > 1 &&
          (state.decodedVideo[1].timestamp || 0) / 1e6 < elapsed - 0.045
        ) {
          const stale = state.decodedVideo.shift();
          try { stale.close(); } catch {}
          state.droppedFrames++;
        }

        while (
          state.decodedVideo.length &&
          (state.decodedVideo[0].timestamp || 0) / 1e6 <= elapsed + 0.012
        ) {
          const frame = state.decodedVideo.shift();
          if (ui.canvas.width !== frame.displayWidth || ui.canvas.height !== frame.displayHeight) {
            ui.canvas.width = frame.displayWidth;
            ui.canvas.height = frame.displayHeight;
          }
          ctx.drawImage(frame, 0, 0, ui.canvas.width, ui.canvas.height);
          const videoPts = (frame.timestamp || 0) / 1e6;
          state.drifts.push((videoPts - elapsed) * 1000);
          state.renderedFrames++;
          if (state.firstPictureMs == null) state.firstPictureMs = performance.now() - state.startedAt;
          try { frame.close(); } catch {}
        }

        updateMetrics(state);
        if (
          state.videoFeedDone &&
          state.audioFeedDone &&
          elapsed > state.mediaEndSec + 0.35 &&
          state.decodedVideo.length === 0
        ) return resolve();

        schedule();
      } catch (error) {
        reject(error);
      }
    };

    schedule();
  });
}

async function runSession(state) {
  if (!window.VideoDecoder || !window.AudioDecoder || !window.EncodedVideoChunk || !window.EncodedAudioChunk) {
    throw new Error("This browser does not expose the required WebCodecs APIs.");
  }

  setStatus("Loading WebCodecs player…", "Using the same hardware-first queue pattern that passed the Tesla v6 probe.");
  const MP4Box = await import("/mp4box.all.mjs?cyberdash-player=v1");
  const initial = await waitForInitialStatus(state);
  state.manifest = initial.manifest;
  state.height = initial.height;

  state.videoDecoder = new VideoDecoder({
    output(frame) {
      state.decodedVideo.push(frame);
      state.maxVideoQueue = Math.max(state.maxVideoQueue, state.videoDecoder.decodeQueueSize || 0);
    },
    error(error) {
      state.decoderError = `VideoDecoder: ${error?.message || error}`;
    },
  });

  state.audioDecoder = new AudioDecoder({
    output(data) {
      try {
        state.decodedAudioBlocks++;
        const channels = data.numberOfChannels;
        const buffer = state.audioCtx.createBuffer(channels, data.numberOfFrames, data.sampleRate);
        for (let channel = 0; channel < channels; channel++) {
          data.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: "f32-planar" });
        }
        const item = { timestamp: data.timestamp, buffer };
        if (state.audioStart == null) state.pendingAudio.push(item);
        else scheduleAudioBuffer(state, item);
        state.maxAudioQueue = Math.max(state.maxAudioQueue, state.audioDecoder.decodeQueueSize || 0);
      } finally {
        data.close();
      }
    },
    error(error) {
      state.decoderError = `AudioDecoder: ${error?.message || error}`;
    },
  });

  state.audioDecoder.configure({
    codec: state.manifest.audio.codec || "mp4a.40.2",
    sampleRate: 48000,
    numberOfChannels: 2,
    description: new Uint8Array([0x11, 0x90]),
  });

  setStatus("Buffering first segments…", `H.264 ${state.manifest.video.codec || ""} · AAC ${state.manifest.audio.codec || ""}`);

  const videoFeed = feedTrack(state, MP4Box, "video", initial.init.video)
    .then((result) => {
      state.videoFeedDone = true;
      state.videoEndSec = result.lastPtsSec;
      state.mediaEndSec = Math.max(state.mediaEndSec, result.lastPtsSec);
      return result;
    });
  const audioFeed = feedTrack(state, MP4Box, "audio", initial.init.audio)
    .then((result) => {
      state.audioFeedDone = true;
      state.audioEndSec = result.lastPtsSec;
      state.mediaEndSec = Math.max(state.mediaEndSec, result.lastPtsSec);
      return result;
    });

  const prebufferDeadline = performance.now() + 7000;
  while (!state.stopRequested && (state.decodedVideo.length < 3 || state.pendingAudio.length < 1)) {
    if (state.decoderError) throw new Error(state.decoderError);
    if (performance.now() > prebufferDeadline) {
      throw new Error(`Startup prebuffer timed out: video=${state.decodedVideo.length} audio=${state.pendingAudio.length}`);
    }
    await sleep(15);
  }
  if (state.stopRequested) return;

  state.audioStart = state.audioCtx.currentTime + 0.60;
  state.pendingAudio.sort((a, b) => a.timestamp - b.timestamp);
  while (state.pendingAudio.length) scheduleAudioBuffer(state, state.pendingAudio.shift());

  setStatus("Playing experimental DASH/WebCodecs stream", "MJPEG production path is still available separately.");
  const renderPromise = startRenderLoop(state);
  const [videoResult, audioResult] = await Promise.all([videoFeed, audioFeed]);
  state.mediaEndSec = Math.max(videoResult.lastPtsSec, audioResult.lastPtsSec);
  await renderPromise;

  if (state.decoderError) throw new Error(state.decoderError);
  setStatus("Playback complete", `${videoResult.segments} video segments · ${audioResult.segments} audio segments`);
  await sendSummary(state, "completed", "Experimental DASH/WebCodecs playback completed.");
}

async function startPlayback() {
  const sourceUrl = ui.url.value.trim();
  if (!sourceUrl) {
    setStatus("A YouTube URL is required.", "", "Paste a YouTube video URL first.");
    return;
  }

  await cleanupActive();
  resetMetrics();
  ui.error.textContent = "";
  ui.play.disabled = true;
  ui.stop.disabled = false;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    setStatus("AudioContext unavailable", "", "This browser cannot run the experimental A/V path.");
    ui.play.disabled = false;
    ui.stop.disabled = true;
    return;
  }

  const state = {
    sourceUrl,
    sessionId: null,
    startedAt: performance.now(),
    resolveMs: null,
    stopRequested: false,
    audioCtx: new AudioContextClass({ sampleRate: 48000 }),
    audioStart: null,
    audioNodes: [],
    pendingAudio: [],
    decodedVideo: [],
    videoDecoder: null,
    audioDecoder: null,
    videoFeedDone: false,
    audioFeedDone: false,
    mediaEndSec: 0,
    renderedFrames: 0,
    droppedFrames: 0,
    decodedAudioBlocks: 0,
    scheduledAudioBlocks: 0,
    receivedBytes: 0,
    drifts: [],
    firstPictureMs: null,
    maxVideoQueue: 0,
    maxAudioQueue: 0,
    decoderError: "",
  };
  active = state;

  try {
    setStatus("Starting audio context…", "Waiting for the browser's media gesture permission.");
    await withTimeout(state.audioCtx.resume(), 2500, "AudioContext resume");
    if (state.audioCtx.state !== "running") throw new Error("AudioContext did not enter running state");

    setStatus("Resolving YouTube source…", "Starting an isolated H.264/AAC DASH session.");
    const response = await fetchJson("/api/experimental/cyberdash/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: sourceUrl,
        height: Number(ui.quality.value),
        fps: 30,
      }),
    }, 45000);
    if (active !== state) return;
    state.sessionId = response.id;
    state.resolveMs = response.resolveMs;

    await runSession(state);
  } catch (error) {
    if (!state.stopRequested) {
      const message = String(error?.message || error);
      setStatus("Experimental playback failed", "Production MJPEG was not changed.", message);
      await sendSummary(state, "error", message);
    }
  } finally {
    if (active === state) await cleanupActive();
  }
}

ui.play.addEventListener("click", startPlayback);
ui.stop.addEventListener("click", async () => {
  const state = active;
  if (state) {
    await sendSummary(state, "stopped", "Stopped by user.");
    setStatus("Stopped.", "Experimental session closed.");
  }
  await cleanupActive();
});

window.addEventListener("beforeunload", () => {
  if (active?.sessionId) {
    navigator.sendBeacon?.(`/api/experimental/cyberdash/${encodeURIComponent(active.sessionId)}/stop`, new Blob([], { type: "application/octet-stream" }));
  }
});

const params = new URLSearchParams(location.search);
if (params.get("url")) ui.url.value = params.get("url");
resetMetrics();

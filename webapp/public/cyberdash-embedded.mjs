const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", ...options, signal: controller.signal });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) {
      const error = new Error(body.error || text || `HTTP ${res.status}`);
      error.status = res.status;
      error.body = body;
      throw error;
    }
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

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function avcDescription(MP4Box, sample) {
  const avcC = sample?.description?.avcC;
  if (!avcC) throw new Error("fMP4 video sample is missing AVC decoder configuration");
  const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
  avcC.write(stream);
  return new Uint8Array(stream.buffer.slice(8));
}

async function stopServerSession(state) {
  if (!state?.sessionId) return;
  try {
    await fetch(`/api/experimental/cyberdash/${encodeURIComponent(state.sessionId)}/stop`, { method: "POST" });
  } catch {}
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
    state.onStatus?.("preparing", status);
    await sleep(150);
  }
  throw new Error("Stopped");
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
  if (state.audioStart == null || !state.audioCtx) return 0;
  return Math.max(0, state.audioCtx.currentTime - state.audioStart - (state.audioScheduleOffsetSec || 0));
}

export function planAudioSchedule({
  expectedStart,
  cursor = null,
  now = 0,
  duration = 0,
  minLead = 0.025,
  continuityTolerance = 0.012,
} = {}) {
  const safeNow = Number.isFinite(Number(now)) ? Number(now) : 0;
  const safeDuration = Math.max(0, Number(duration) || 0);
  const safeExpected = Number.isFinite(Number(expectedStart))
    ? Number(expectedStart)
    : safeNow + minLead;

  let start = safeExpected;
  let continuityAdjusted = false;
  let overlapPrevented = false;

  if (Number.isFinite(Number(cursor))) {
    const safeCursor = Number(cursor);
    const delta = safeExpected - safeCursor;
    if (delta < 0) {
      start = safeCursor;
      overlapPrevented = true;
    } else if (delta <= continuityTolerance) {
      start = safeCursor;
      continuityAdjusted = delta > 0.00025;
    }
  }

  const minimumStart = safeNow + minLead;
  const lateBy = Math.max(0, minimumStart - start);
  if (lateBy > 0) start += lateBy;

  return {
    start,
    end: start + safeDuration,
    lateBy,
    continuityAdjusted,
    overlapPrevented,
  };
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
  node.connect(state.gainNode);
  node.onended = () => {
    state.audioNodes.delete(node);
    try { node.disconnect(); } catch {}
  };

  const expectedStart = state.audioStart
    + (state.audioScheduleOffsetSec || 0)
    + Math.max(0, item.timestamp / 1e6);
  const plan = planAudioSchedule({
    expectedStart,
    cursor: state.audioScheduleCursor,
    now: state.audioCtx.currentTime,
    duration: item.buffer.duration,
  });

  if (plan.lateBy > 0) {
    state.audioScheduleOffsetSec += plan.lateBy;
    state.audioLateBlocks++;
    state.maxAudioScheduleSlipMs = Math.max(state.maxAudioScheduleSlipMs, plan.lateBy * 1000);
  }
  if (plan.overlapPrevented) state.audioOverlapPrevented++;
  if (plan.continuityAdjusted) state.audioContinuityCorrections++;

  state.audioScheduleCursor = plan.end;
  state.audioNodes.add(node);
  node.start(plan.start);
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
    const ctx = state.canvas.getContext("2d", { alpha: false });

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
        if (state.paused) {
          schedule();
          return;
        }

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
          if (state.canvas.width !== frame.displayWidth || state.canvas.height !== frame.displayHeight) {
            state.canvas.width = frame.displayWidth;
            state.canvas.height = frame.displayHeight;
          }
          ctx.drawImage(frame, 0, 0, state.canvas.width, state.canvas.height);
          const videoPts = (frame.timestamp || 0) / 1e6;
          state.drifts.push((videoPts - elapsed) * 1000);
          state.renderedFrames++;
          if (state.firstPictureMs == null) {
            state.firstPictureMs = performance.now() - state.startedAt;
            state.onPlaying?.();
          }
          try { frame.close(); } catch {}
        }

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

  const MP4Box = await import("/mp4box.all.mjs?cyberdash-embedded=v1");
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

  const videoFeed = feedTrack(state, MP4Box, "video", initial.init.video)
    .then((result) => {
      state.videoFeedDone = true;
      state.mediaEndSec = Math.max(state.mediaEndSec, result.lastPtsSec);
      return result;
    });
  const audioFeed = feedTrack(state, MP4Box, "audio", initial.init.audio)
    .then((result) => {
      state.audioFeedDone = true;
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

  const renderPromise = startRenderLoop(state);
  const [videoResult, audioResult] = await Promise.all([videoFeed, audioFeed]);
  state.mediaEndSec = Math.max(videoResult.lastPtsSec, audioResult.lastPtsSec);
  await renderPromise;

  if (state.decoderError) throw new Error(state.decoderError);
  state.onEnded?.();
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
        label: "embedded-webcodecs",
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
          audioLateBlocks: state.audioLateBlocks,
          audioOverlapPrevented: state.audioOverlapPrevented,
          audioContinuityCorrections: state.audioContinuityCorrections,
          maxAudioScheduleSlipMs: round(state.maxAudioScheduleSlipMs, 1),
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

export function createCyberdashPlayer({
  canvas,
  onPlaying,
  onEnded,
  onError,
  onStatus,
} = {}) {
  if (!canvas) throw new Error("CyberDash canvas is required");
  let state = null;

  async function stop({ report = false } = {}) {
    const current = state;
    state = null;
    if (!current) return;
    current.stopRequested = true;
    for (const frame of current.decodedVideo || []) {
      try { frame.close(); } catch {}
    }
    for (const node of current.audioNodes || []) {
      try { node.stop(); } catch {}
    }
    try { current.videoDecoder && current.videoDecoder.state !== "closed" && current.videoDecoder.close(); } catch {}
    try { current.audioDecoder && current.audioDecoder.state !== "closed" && current.audioDecoder.close(); } catch {}
    try { current.audioCtx && current.audioCtx.state !== "closed" && await current.audioCtx.close(); } catch {}
    await stopServerSession(current);
    if (report) await sendSummary(current, "stopped", "Stopped by user.");
  }

  async function play({
    url,
    height = 720,
    fps = 30,
    startAt = 0,
    muted = false,
  } = {}) {
    if (!url) throw new Error("YouTube URL is required");

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("AudioContext unavailable");

    // Prefer the browser's playback-sized output buffer. Tesla's browser can
    // crackle when hundreds of small decoded AAC blocks are driven through an
    // interactive/low-latency output path under rendering load.
    let audioCtx;
    try {
      audioCtx = new AudioContextClass({ sampleRate: 48000, latencyHint: "playback" });
    } catch {
      audioCtx = new AudioContextClass({ sampleRate: 48000 });
    }

    // Resume immediately while the click/tap user-activation is still live.
    // Tesla's browser can reject AudioContext.resume() if we await cleanup first.
    const resumePromise = audioCtx.resume();
    await stop();

    const next = {
      sourceUrl: url,
      startAt: Math.max(0, Number(startAt) || 0),
      sessionId: null,
      startedAt: performance.now(),
      resolveMs: null,
      stopRequested: false,
      paused: false,
      audioCtx,
      gainNode: null,
      audioStart: null,
      audioScheduleCursor: null,
      audioScheduleOffsetSec: 0,
      audioLateBlocks: 0,
      audioOverlapPrevented: 0,
      audioContinuityCorrections: 0,
      maxAudioScheduleSlipMs: 0,
      audioNodes: new Set(),
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
      canvas,
      onPlaying,
      onEnded,
      onError,
      onStatus,
    };
    next.gainNode = next.audioCtx.createGain();
    next.gainNode.gain.value = muted ? 0 : 1;
    next.gainNode.connect(next.audioCtx.destination);
    state = next;

    try {
      await withTimeout(resumePromise, 2500, "AudioContext resume");
      if (next.audioCtx.state !== "running") throw new Error("AudioContext did not enter running state");

      onStatus?.("resolving");
      const response = await fetchJson("/api/experimental/cyberdash/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          height: Number.isFinite(Number(height)) ? Number(height) : 0,
          fps: Number(fps) || 30,
          startAt: next.startAt,
        }),
      }, 45000);
      if (state !== next) return;
      next.sessionId = response.id;
      next.resolveMs = response.resolveMs;
      await runSession(next);
      if (state === next) await sendSummary(next, "completed", "Embedded DASH/WebCodecs playback completed.");
    } catch (error) {
      if (!next.stopRequested) {
        await sendSummary(next, "error", String(error?.message || error));
        onError?.(error);
      }
      throw error;
    } finally {
      // Release AudioContext/decoders/buffer-source references and the server
      // session after completion or failure. This matters for long videos.
      if (state === next) await stop();
    }
  }

  function currentTime() {
    if (!state) return 0;
    return state.startAt + playbackElapsed(state);
  }

  async function pause() {
    if (!state || state.paused) return;
    state.paused = true;
    await state.audioCtx.suspend();
  }

  async function resume() {
    if (!state || !state.paused) return;
    await state.audioCtx.resume();
    state.paused = false;
  }

  function setMuted(muted) {
    if (!state?.gainNode) return;
    const now = state.audioCtx.currentTime;
    const gain = state.gainNode.gain;
    const current = gain.value;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(current, now);
    gain.linearRampToValueAtTime(muted ? 0 : 1, now + 0.008);
  }

  function isActive() {
    return Boolean(state && !state.stopRequested);
  }

  return { play, stop, pause, resume, currentTime, setMuted, isActive };
}

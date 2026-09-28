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
  let lastSize = Number(state.videoDecoder?.decodeQueueSize || 0);
  let lastProgressAt = performance.now();
  while (!state.stopRequested && state.videoDecoder?.state !== "closed" && state.videoDecoder.decodeQueueSize > maxSize) {
    if (state.decoderError) throw new Error(state.decoderError);
    const size = Number(state.videoDecoder.decodeQueueSize || 0);
    state.maxVideoQueue = Math.max(state.maxVideoQueue, size);
    if (size < lastSize) lastProgressAt = performance.now();
    lastSize = size;
    // Hardware decode can stay just above the target for a few seconds. Only fail on a true long stall.
    if (performance.now() - lastProgressAt > 10000) {
      throw new Error(`Video decoder stopped draining above queue ${maxSize}`);
    }
    await sleep(12);
  }
}

export function normalizePlaybackRate(value = 1) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 1;
  return Math.max(1, Math.min(4, rate));
}

function playbackElapsed(state) {
  if (state.externalAudioElement) {
    const current = Number(state.externalAudioElement.currentTime);
    const origin = Number(state.externalAudioClockOrigin);
    if (!Number.isFinite(current)) return 0;
    return Math.max(0, current - (Number.isFinite(origin) ? origin : current));
  }
  if (state.audioStart == null || !state.audioCtx) return 0;
  const wallSeconds = Math.max(0, state.audioCtx.currentTime - state.audioStart - (state.audioScheduleOffsetSec || 0));
  return wallSeconds * normalizePlaybackRate(state.playbackRate);
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

async function holdIfTooFarAhead(state, lastPtsSec, kind) {
  const playbackRate = normalizePlaybackRate(state.playbackRate);
  const sourceLeadLimit = 6.5 * playbackRate;
  // Server-side atempo compresses the audio timeline. Convert its output-time
  // PTS back to source-time before comparing it with the video master clock.
  const sourcePtsSec = kind === "audio" ? lastPtsSec * playbackRate : lastPtsSec;
  while (
    !state.stopRequested &&
    state.audioStart != null &&
    sourcePtsSec - playbackElapsed(state) > sourceLeadLimit
  ) {
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

  // Audio was already tempo-compressed by FFmpeg with pitch preservation.
  // Play decoded AAC at 1x and schedule directly on its output-time timeline.
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
      await holdIfTooFarAhead(state, lastPtsSec, kind);
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
        if (state.externalAudioElement) {
          const clock = Number(state.externalAudioElement.currentTime);
          if (Number.isFinite(clock) && (
            state.externalAudioLastClock == null ||
            clock > Number(state.externalAudioLastClock) + 0.004
          )) {
            state.externalAudioLastClock = clock;
            state.externalAudioLastProgressAt = performance.now();
          } else if (
            !state.externalAudioElement.paused &&
            state.externalAudioLastProgressAt != null &&
            performance.now() - state.externalAudioLastProgressAt > 5000
          ) {
            throw new Error(
              "Audio media clock stalled" +
              " rate=" + normalizePlaybackRate(state.playbackRate) +
              " readyState=" + state.externalAudioElement.readyState +
              " networkState=" + state.externalAudioElement.networkState
            );
          }
        }
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
  if (!window.VideoDecoder || !window.EncodedVideoChunk) {
    throw new Error("This browser does not expose the required WebCodecs video APIs.");
  }
  if (!state.externalAudioElement && (!window.AudioDecoder || !window.EncodedAudioChunk)) {
    throw new Error("This browser does not expose the required WebCodecs audio APIs.");
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

  let audioFeed = Promise.resolve({ lastPtsSec: 0, segments: 0 });
  if (!state.externalAudioElement) {
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

    audioFeed = feedTrack(state, MP4Box, "audio", initial.init.audio)
      .then((result) => {
        state.audioFeedDone = true;
        state.mediaEndSec = Math.max(state.mediaEndSec, result.lastPtsSec);
        return result;
      });
  } else {
    state.audioFeedDone = true;
  }

  const videoFeed = feedTrack(state, MP4Box, "video", initial.init.video)
    .then((result) => {
      state.videoFeedDone = true;
      state.mediaEndSec = Math.max(state.mediaEndSec, result.lastPtsSec);
      return result;
    });

  const prebufferDeadline = performance.now() + 10000;
  while (
    !state.stopRequested &&
    (state.decodedVideo.length < 3 || (!state.externalAudioElement && state.pendingAudio.length < 1))
  ) {
    if (state.decoderError) throw new Error(state.decoderError);
    if (performance.now() > prebufferDeadline) {
      throw new Error(`Startup prebuffer timed out: video=${state.decodedVideo.length} audio=${state.pendingAudio.length}`);
    }
    await sleep(15);
  }
  if (state.stopRequested) return;

  if (state.externalAudioElement) {
    // The app primed this element from the original user gesture. Start the real
    // audio only after video prebuffer is ready so source-time begins at 0 for both.
    await withTimeout(state.externalAudioPlayPromise || Promise.resolve(), 15000, "Audio element priming");
    const primedAt = Number(state.externalAudioElement.currentTime);
    state.externalAudioClockOrigin = Number.isFinite(primedAt) ? Math.max(0, primedAt) : 0;
    state.externalAudioLastClock = state.externalAudioClockOrigin;
    state.externalAudioLastProgressAt = performance.now();
    state.externalAudioElement.defaultPlaybackRate = normalizePlaybackRate(state.playbackRate);
    state.externalAudioElement.playbackRate = normalizePlaybackRate(state.playbackRate);
    state.externalAudioElement.muted = Boolean(state.requestedMuted);
    await withTimeout(state.externalAudioElement.play(), 10000, "Audio element start");
    if (state.externalAudioElement.paused && !state.externalAudioElement.ended) {
      throw new Error("Audio element did not enter playing state");
    }
  } else {
    state.audioStart = state.audioCtx.currentTime + 0.60;
    state.pendingAudio.sort((a, b) => a.timestamp - b.timestamp);
    while (state.pendingAudio.length) scheduleAudioBuffer(state, state.pendingAudio.shift());
  }

  const renderPromise = startRenderLoop(state);
  const [videoResult, audioResult] = await Promise.all([videoFeed, audioFeed]);
  state.mediaEndSec = Math.max(videoResult.lastPtsSec, audioResult.lastPtsSec || 0);
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
          fps: state.requestedFps,
          renderedFrames: state.renderedFrames,
          droppedFrames: state.droppedFrames,
          receivedBytes: state.receivedBytes,
          lastAvDriftMs: round(lastDrift, 1),
          audioLateBlocks: state.audioLateBlocks,
          audioOverlapPrevented: state.audioOverlapPrevented,
          audioContinuityCorrections: state.audioContinuityCorrections,
          maxAudioScheduleSlipMs: round(state.maxAudioScheduleSlipMs, 1),
          playbackRate: normalizePlaybackRate(state.playbackRate),
          audioMode: state.externalAudioElement ? "media-element" : "web-audio",
          pitchMode: state.externalAudioElement ? "browser-preserves-pitch" : "server-atempo",
          playbackRate: normalizePlaybackRate(state.playbackRate),
          audioClockOriginSec: round(state.externalAudioClockOrigin, 3),
          audioCurrentTimeSec: round(state.externalAudioElement?.currentTime, 3),
          audioPaused: state.externalAudioElement?.paused ?? null,
          audioReadyState: state.externalAudioElement?.readyState ?? null,
          audioNetworkState: state.externalAudioElement?.networkState ?? null,
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
    if (current.externalAudioElement) {
      try { current.externalAudioElement.pause(); } catch {}
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
    playbackRate = 1,
    audioElement = null,
    audioPlayPromise = null,
  } = {}) {
    if (!url) throw new Error("YouTube URL is required");

    const externalAudioElement = audioElement || null;
    let audioCtx = null;
    let resumePromise = Promise.resolve();
    if (!externalAudioElement) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("AudioContext unavailable");

      // Internal fallback for sources without a sidecar media element.
      try {
        audioCtx = new AudioContextClass({ sampleRate: 48000, latencyHint: "playback" });
      } catch {
        audioCtx = new AudioContextClass({ sampleRate: 48000 });
      }

      // Resume immediately while click/tap activation is still live.
      resumePromise = audioCtx.resume();
    }
    await stop();

    const next = {
      sourceUrl: url,
      startAt: Math.max(0, Number(startAt) || 0),
      requestedFps: Math.max(5, Math.min(60, Number(fps) || 30)),
      playbackRate: normalizePlaybackRate(playbackRate),
      requestedMuted: Boolean(muted),
      externalAudioElement,
      externalAudioPlayPromise: audioPlayPromise || null,
      externalAudioClockOrigin: null,
      externalAudioLastClock: null,
      externalAudioLastProgressAt: null,
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
    if (next.audioCtx) {
      next.gainNode = next.audioCtx.createGain();
      next.gainNode.gain.value = muted ? 0 : 1;
      next.gainNode.connect(next.audioCtx.destination);
    }
    state = next;

    try {
      if (next.audioCtx) {
        await withTimeout(resumePromise, 2500, "AudioContext resume");
        if (next.audioCtx.state !== "running") throw new Error("AudioContext did not enter running state");
      }

      onStatus?.("resolving");
      const response = await fetchJson("/api/experimental/cyberdash/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          height: Number.isFinite(Number(height)) ? Number(height) : 0,
          fps: Number(fps) || 30,
          startAt: next.startAt,
          playbackRate: next.playbackRate,
        }),
      }, 45000);
      if (state !== next) return;
      next.sessionId = response.id;
      next.resolveMs = response.resolveMs;
      await runSession(next);
      if (state === next) await sendSummary(next, "completed", "Embedded DASH/WebCodecs playback completed.");
    } catch (error) {
      // Stop/seek/method/rate changes intentionally abort the old session. Treat
      // that as normal cancellation so a stale promise cannot show a fatal toast
      // while the replacement stream is already playing.
      if (next.stopRequested) return;
      await sendSummary(next, "error", String(error?.message || error));
      onError?.(error);
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
    if (state.externalAudioElement) {
      state.externalAudioElement.pause();
      return;
    }
    await state.audioCtx.suspend();
  }

  async function resume() {
    if (!state || !state.paused) return;
    if (state.externalAudioElement) {
      await state.externalAudioElement.play();
      state.paused = false;
      return;
    }
    await state.audioCtx.resume();
    state.paused = false;
  }

  function setMuted(muted) {
    if (!state) return;
    if (state.externalAudioElement) {
      state.externalAudioElement.muted = Boolean(muted);
      return;
    }
    if (!state.gainNode) return;
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

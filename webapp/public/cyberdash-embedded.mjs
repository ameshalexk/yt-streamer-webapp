import { orderedPrefetch } from "./ordered-prefetch.mjs";
import { BoundedSegmentBuffer } from "./segment-prefetch.mjs";

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

// A short completion provides a conservative lower bound rather than
// disqualifying fast links. Ignore tiny bodies dominated by framing overhead.
export function videoCapacitySample(bytes, elapsedMs) {
  if (!Number.isFinite(bytes) || bytes < 16 * 1024 || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  return Math.round(bytes * 8000 / Math.max(35, elapsedMs));
}

async function fetchBytes(url, timeoutMs = 12000, cacheMode = "no-store", onTiming = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const res = await fetch(url, { cache: cacheMode, signal: controller.signal });
    const headersAt = performance.now();
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    const value = await res.arrayBuffer();
    if (typeof onTiming === "function") {
      onTiming({ bytes: value.byteLength, ttfbMs: headersAt - startedAt, elapsedMs: performance.now() - startedAt });
    }
    return value;
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

export function measureServerThroughput(previous, current) {
  const elapsedMs = current?.elapsedMs - previous?.elapsedMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 3000) return null;
  const perSecond = (key) => {
    const start = previous?.[key];
    const end = current?.[key];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return (end - start) * 1000 / elapsedMs;
  };
  const mbps = (key) => {
    const bytesPerSecond = perSecond(key);
    return bytesPerSecond == null ? null : round(bytesPerSecond * 8 / 1e6, 2);
  };
  return {
    serverVideoSpeed: round(perSecond("outputVideoSeconds"), 2),
    sourceVideoMbps: mbps("sourceVideoBytes"),
    sourceAudioMbps: mbps("sourceAudioBytes"),
  };
}

function avcDescription(MP4Box, sample) {
  const avcC = sample?.description?.avcC;
  if (!avcC) throw new Error("fMP4 video sample is missing AVC decoder configuration");
  const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
  avcC.write(stream);
  return new Uint8Array(stream.buffer.slice(8));
}

async function stopServerSession(state) {
  if (!state?.sessionId || state.preparedStatic) return;
  try {
    await fetch(`/api/experimental/cyberdash/${encodeURIComponent(state.sessionId)}/stop`, { method: "POST" });
  } catch {}
}

async function waitForInitialStatus(state) {
  if (state.initialStatus?.preparedStatic && state.initialStatus.manifestReady) {
    return state.initialStatus;
  }
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
  while (!state.stopRequested && state.videoDecoder?.state !== "closed") {
    // Pause is user intent, not decoder failure. Stop feeding compressed frames
    // while paused and never count paused wall time toward the decoder-stall watchdog.
    if (state.paused) {
      lastSize = Number(state.videoDecoder?.decodeQueueSize || 0);
      lastProgressAt = performance.now();
      await sleep(40);
      continue;
    }
    if (state.videoDecoder.decodeQueueSize <= maxSize) return;
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

export function fastPlaybackBufferTargets({ playbackRate = 1, fps = 30, bufferLab = false } = {}) {
  const rate = normalizePlaybackRate(playbackRate);
  const sourceFps = Math.max(5, Math.min(60, Number(fps) || 30));
  if (bufferLab) {
    // Longer *compressed* look-ahead is separate from this small decoded-frame
    // reserve. Do not keep tens of seconds of VideoFrame objects in Tesla RAM.
    return {
      startupWallSec: 1.25,
      startupVideoSourceSec: 1.25 * rate,
      startupVideoFrames: Math.max(6, Math.ceil(sourceFps * 1.25 * rate)),
      startupAudioWallSec: 1.25,
      rebufferLowWallSec: rate > 1 ? 0.65 : 0.15,
      rebufferHighWallSec: 2,
      rebufferHighVideoSourceSec: 2 * rate,
    };
  }
  if (rate <= 1) {
    return {
      startupWallSec: 0,
      startupVideoSourceSec: 0,
      startupVideoFrames: 3,
      startupAudioWallSec: 0,
      // Normal-speed playback stays fast to start, but can now suspend its
      // audio master clock when video or audio genuinely stops arriving.
      rebufferLowWallSec: 0.05,
      rebufferHighWallSec: 0.45,
      rebufferHighVideoSourceSec: 0.45,
    };
  }
  // Rate changes restart the pitch-preserving server audio pipeline. Start with
  // a modest wall-time reserve instead of making 2x wait for four seconds of
  // audio before showing a frame. Keep the larger recovery targets below.
  const startupWallSec = 1.5;
  const startupVideoSourceSec = Math.min(6.5, startupWallSec * rate);
  const rebufferHighWallSec = Math.min(3, 1.5 + (rate - 1));
  return {
    startupWallSec,
    startupVideoSourceSec,
    startupVideoFrames: Math.max(12, Math.ceil(sourceFps * startupVideoSourceSec)),
    startupAudioWallSec: startupWallSec,
    rebufferLowWallSec: 0.65,
    rebufferHighWallSec,
    rebufferHighVideoSourceSec: Math.min(6.5, rebufferHighWallSec * rate),
  };
}

export function playbackStartupReady({
  playbackRate = 1, videoFrames = 0, audioBlocks = 0,
  videoSourceSec = 0, audioWallSec = 0,
  videoFeedDone = false, audioFeedDone = false, externalAudio = false,
  targets = fastPlaybackBufferTargets({ playbackRate }),
} = {}) {
  const minimumReady = videoFrames >= (videoFeedDone ? 1 : 3)
    && (externalAudio || audioBlocks >= 1);
  if (!minimumReady) return false;
  if (normalizePlaybackRate(playbackRate) <= 1) return true;
  // Time coverage is the reserve that matters. A fixed requested-FPS frame
  // count can be unreachable for a lower-cadence source. At EOF no more data
  // can arrive, so play the available tail instead of waiting 15 seconds.
  return (videoFeedDone || videoSourceSec >= targets.startupVideoSourceSec)
    && (externalAudio || audioFeedDone || audioWallSec >= targets.startupAudioWallSec);
}

// Normal-speed playback usually has only a few decoded frames in flight.
// Require a sustained stall before suspending audio, otherwise ordinary gaps
// between 12/15-FPS frames would cause needless buffering.
export function normalSpeedNeedsRebuffer({
  hasFirstPicture = false,
  videoFeedDone = false,
  audioFeedDone = false,
  videoAheadSec = 0,
  audioAheadSec = 0,
  timeSinceVideoFrameMs = 0,
  timeSinceAudioReadyMs = 0,
} = {}) {
  if (!hasFirstPicture || videoFeedDone || audioFeedDone) return false;
  return (videoAheadSec < 0.08 && timeSinceVideoFrameMs >= 500)
    || (audioAheadSec < 0.05 && timeSinceAudioReadyMs >= 350);
}

function decodedVideoAheadSec(state, elapsed = playbackElapsed(state)) {
  if (!state.decodedVideo?.length) return 0;
  let last = 0;
  for (const frame of state.decodedVideo) {
    last = Math.max(last, Number(frame?.timestamp || 0) / 1e6);
  }
  return Math.max(0, last - Math.max(0, Number(elapsed) || 0));
}

function pendingAudioBufferedSec(state) {
  if (!state.pendingAudio?.length) return 0;
  let first = Infinity;
  let last = 0;
  for (const item of state.pendingAudio) {
    const start = Math.max(0, Number(item?.timestamp || 0) / 1e6);
    const end = start + Math.max(0, Number(item?.buffer?.duration || 0));
    first = Math.min(first, start);
    last = Math.max(last, end);
  }
  return Number.isFinite(first) ? Math.max(0, last - first) : 0;
}

function scheduledAudioAheadSec(state) {
  if (!state.audioCtx || !Number.isFinite(Number(state.audioScheduleCursor))) return 0;
  return Math.max(0, Number(state.audioScheduleCursor) - state.audioCtx.currentTime);
}

// Diagnostic-only audio probes. They never change playback or capture audio content.
// A running audio clock does not prove the speaker is producing sound; the
// scheduled-buffer horizon helps distinguish video-only continuation.
export function classifyAudioSchedule({
  playing = false, muted = false, audioStarted = false, videoMoving = false,
  audioContextState = "running", audioAheadSec = 0,
} = {}) {
  if (!playing || muted || !audioStarted || !videoMoving) return null;
  if (audioContextState !== "running") return "audio_context_not_running";
  if (Number(audioAheadSec) < 0.05) return "audio_schedule_empty";
  return null;
}

function audioHealthSnapshot(state) {
  const external = state.externalAudioElement;
  return {
    audioMode: external ? "media-element" : "web-audio",
    audioContextState: external ? "external" : (state.audioCtx?.state || "missing"),
    audioAheadMs: external ? null : round(scheduledAudioAheadSec(state) * 1000),
    audioDecodedBlocks: state.decodedAudioBlocks,
    audioScheduledBlocks: state.scheduledAudioBlocks,
    audioLateBlocks: state.audioLateBlocks,
    audioOverlapPrevented: state.audioOverlapPrevented,
    audioContinuityCorrections: state.audioContinuityCorrections,
    audioMaxScheduleSlipMs: round(state.maxAudioScheduleSlipMs),
    audioFeedDone: Boolean(state.audioFeedDone),
    videoFeedDone: Boolean(state.videoFeedDone),
    audioEndPtsSec: round(state.audioEndPtsSec, 3),
    audioEndSourceSec: round(state.audioEndSourceSec, 3),
    videoEndPtsSec: round(state.videoEndPtsSec, 3),
    knownVideoEndSourceSec: round(state.knownVideoEndSourceSec, 3),
    sourceDurationSec: round(state.sourceDurationSec, 3),
    playbackRate: normalizePlaybackRate(state.playbackRate),
    audioMuted: Boolean(state.requestedMuted),
    audioMediaReadyState: external?.readyState ?? null,
    audioMediaNetworkState: external?.networkState ?? null,
    audioMediaPaused: external?.paused ?? null,
    audioMediaTimeSec: external ? round(Number(external.currentTime), 2) : null,
    playbackPositionSec: round(state.startAt + playbackElapsed(state), 2),
  };
}

// Fail only after internal audio has actually run out while reliable timeline
// evidence says video should continue. The two-second margin absorbs AAC
// priming/padding and ordinary end-of-stream timestamp rounding.
export function detectPrematureAudioEnd({
  playing = false, hasFirstPicture = false, paused = false, stopped = false,
  muted = false, externalAudio = false, audioFeedDone = false,
  audioEndPtsSec, videoEndPtsSec, knownVideoEndSec, currentSourceSec = 0,
  audioAheadSec = 0, playbackRate = 1, startAt = 0, segmentOffsetSourceSec = 0,
  toleranceSec = 2,
} = {}) {
  if (!playing || !hasFirstPicture || paused || stopped || muted || externalAudio || !audioFeedDone) return null;
  const audioEnd = Number(audioEndPtsSec);
  if (!Number.isFinite(audioEnd) || audioEnd <= 0 || Number(audioAheadSec) > 0.05) return null;
  const rate = normalizePlaybackRate(playbackRate);
  const origin = Math.max(0, Number(startAt) || 0) + Math.max(0, Number(segmentOffsetSourceSec) || 0);
  const audioEndSource = origin + audioEnd * rate;
  const current = Number(currentSourceSec);
  if (!Number.isFinite(current) || current < audioEndSource + toleranceSec) return null;
  const evidenceEnd = Math.max(
    Number.isFinite(Number(knownVideoEndSec)) ? Number(knownVideoEndSec) : 0,
    // Prepared video PTS remains relative to segmentStartAt; unlike audio it
    // is not trimmed by segmentOffsetSourceSec.
    Number.isFinite(Number(videoEndPtsSec)) ? (Math.max(0, Number(startAt) || 0) + Number(videoEndPtsSec)) : 0,
  );
  if (evidenceEnd <= audioEndSource + toleranceSec) return null;
  // A sub-two-second tail can be ordinary encoder padding/timestamp slop at
  // natural completion, especially when both feeds have already ended.
  if (evidenceEnd - current <= toleranceSec) return null;
  return {
    audioEndSourceSec: audioEndSource,
    evidenceEndSourceSec: evidenceEnd,
    remainingSourceSec: evidenceEnd - current,
  };
}

function sendAudioDiagnostic(state, event, reason) {
  // Best effort: no extra media requests, no raw waveform, and no retry loop.
  const stats = audioHealthSnapshot(state);
  void fetch("/api/playback-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event, reason, label: "embedded-webcodecs-audio",
      streamUrl: state.sourceUrl,
      stats,
    }),
  }).catch(() => {});
}

export function advanceAudioHealthIncident(state, now, anomaly) {
  if (anomaly) {
    if (state.audioDiagnosticGapReason !== anomaly) {
      state.audioDiagnosticGapReason = anomaly;
      state.audioDiagnosticGapAt = now;
      state.audioDiagnosticReported = false;
    } else if (!state.audioDiagnosticReported && now - state.audioDiagnosticGapAt >= 2500) {
      state.audioDiagnosticReported = true;
      return { event: "cyberdash_audio_anomaly", reason: anomaly };
    }
  } else {
    const recovered = state.audioDiagnosticReported ? state.audioDiagnosticGapReason : null;
    state.audioDiagnosticGapReason = null;
    state.audioDiagnosticReported = false;
    if (recovered) return { event: "cyberdash_audio_recovered", reason: recovered };
  }
  return null;
}

function auditAudioHealth(state, now, videoMoving) {
  if (state.stopRequested || state.paused || state.rebuffering || state.audioStart == null) return;
  // Only flag known schedule gaps, not unmeasurable hardware/output-volume issues.
  const anomaly = state.externalAudioElement ? null : classifyAudioSchedule({
    playing: true,
    muted: state.requestedMuted,
    audioStarted: state.decodedAudioBlocks > 0,
    videoMoving,
    audioContextState: state.audioCtx?.state,
    audioAheadSec: scheduledAudioAheadSec(state),
  });
  const transition = advanceAudioHealthIncident(state, now, anomaly);
  if (transition) sendAudioDiagnostic(state, transition.event, transition.reason);
  // A bounded heartbeat captures a 15-minute video's final minute even when
  // neither decoder throws and no rebuffer state is entered.
  if (now - state.audioDiagnosticLastReportAt >= 20000) {
    state.audioDiagnosticLastReportAt = now;
    sendAudioDiagnostic(state, "cyberdash_audio_health", "periodic");
  }
}

function playbackElapsed(state) {
  const segmentOffset = Math.max(0, Number(state.segmentOffsetSourceSec) || 0);
  if (state.externalAudioElement) {
    const current = Number(state.externalAudioElement.currentTime);
    const origin = Number(state.externalAudioClockOrigin);
    if (!Number.isFinite(current)) return segmentOffset;
    return segmentOffset + Math.max(0, current - (Number.isFinite(origin) ? origin : current));
  }
  if (state.audioStart == null || !state.audioCtx) return segmentOffset;
  const wallSeconds = Math.max(0, state.audioCtx.currentTime - state.audioStart - (state.audioScheduleOffsetSec || 0));
  return segmentOffset + wallSeconds * normalizePlaybackRate(state.playbackRate);
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
  const sourceLeadLimit = state.preparedStatic
    ? Math.max(3, Number(state.bufferTargets?.rebufferHighVideoSourceSec || 0) + 0.75)
    : 6.5 * playbackRate;
  const effectiveLeadLimit = state.bufferLab && !state.preparedStatic ? 4 * playbackRate : sourceLeadLimit;
  // Server-side atempo compresses the audio timeline. Convert its output-time
  // PTS back to source-time before comparing it with the video master clock.
  const segmentOffset = state.preparedStatic ? Math.max(0, Number(state.segmentOffsetSourceSec) || 0) : 0;
  const sourcePtsSec = kind === "audio"
    ? (lastPtsSec * playbackRate) + segmentOffset
    : lastPtsSec;
  while (
    !state.stopRequested &&
    state.audioStart != null &&
    sourcePtsSec - playbackElapsed(state) > effectiveLeadLimit
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
      const relativeUs = Math.max(0, rawUs - timestampOriginUs);
      const duration = Math.max(1, Math.round(sample.duration * 1e6 / sample.timescale));
      let timestamp = relativeUs;

      if (state.preparedStatic && kind === "audio" && state.segmentOffsetSourceSec > 0) {
        const skipAudioUs = Math.round((state.segmentOffsetSourceSec / normalizePlaybackRate(state.playbackRate)) * 1e6);
        if (relativeUs + duration <= skipAudioUs) continue;
        timestamp = Math.max(0, relativeUs - skipAudioUs);
      }

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
        await waitForVideoQueue(state, state.bufferLab ? 8 : 40);
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

  let trackReceivedBytes = 0;
  const appendBuffer = (ab) => {
    state.receivedBytes += ab.byteLength;
    trackReceivedBytes += ab.byteLength;
    ab.fileStart = offset;
    offset += ab.byteLength;
    file.appendBuffer(ab);
  };

  const appendFile = async (name) => {
    if (state.preparedStatic) {
      const base = state.staticTracks?.baseUrl || "";
      const version = encodeURIComponent(String(state.staticTracks?.cacheVersion || ""));
      const url = `${base}/${name}?v=${version}`;
      const ab = await fetchBytes(url, 15000, "force-cache");
      appendBuffer(ab);
      return;
    }
    const isInit = name === initName;
    let timing = null;
    const ab = await fetchBytes(
      `/stream/experimental/cyberdash/${state.sessionId}/${encodeURIComponent(name)}?t=${Date.now()}`,
      12000,
      "no-store",
      isInit ? null : (sample) => { timing = sample; },
    );
    if (!isInit && timing && kind === "video") {
      state.deliveryBytes = (state.deliveryBytes || 0) + ab.byteLength;
      state.latencyMs = round(timing.ttfbMs, 1);
      state.latencyAt = performance.now();
      const capacityBps = videoCapacitySample(ab.byteLength, timing.elapsedMs);
      if (capacityBps != null) {
        state.capacityBps = capacityBps;
        state.capacityAt = performance.now();
      }
    }
    appendBuffer(ab);
  };

  const finishTrack = async () => {
    const decoder = kind === "video" ? state.videoDecoder : state.audioDecoder;
    if (decoder?.state === "configured") await decoder.flush();
    if (kind === "audio") {
      state.audioEndPtsSec = lastPtsSec;
      state.audioEndSourceSec = Math.max(0, Number(state.startAt) || 0)
        + Math.max(0, Number(state.segmentOffsetSourceSec) || 0)
        + lastPtsSec * normalizePlaybackRate(state.playbackRate);
    } else {
      state.videoEndPtsSec = lastPtsSec;
    }
    return { lastPtsSec, segments: fed.size };
  };

  await appendFile(initName);
  await withTimeout(ready, 4000, `${kind} fMP4 init parse`);

  if (state.preparedStatic) {
    const track = state.staticTracks?.[kind];
    if (!track) throw new Error(`Prepared ${kind} track metadata missing`);
    const segmentSourceSeconds = Math.max(0.25, Number(state.staticTracks?.segmentSourceSeconds) || 2);
    const prefetchSourceSeconds = 18;
    const prefetchCount = Math.max(3, Math.ceil(prefetchSourceSeconds / segmentSourceSeconds));
    let nextIndex = Math.max(1, Number(track.startIndex) || 1);
    const totalSegments = Math.max(0, Number(track.totalSegments) || 0);

    const segmentName = (index) => `${track.dir}/chunk-${String(index).padStart(5, "0")}.m4s`;

    while (!state.stopRequested && nextIndex <= totalSegments) {
      const batchEnd = Math.min(totalSegments, nextIndex + prefetchCount - 1);
      const indexes = [];
      for (let index = nextIndex; index <= batchEnd; index++) indexes.push(index);

      let batchBytes = 0;
      let fetchedCount = 0;
      const base = state.staticTracks?.baseUrl || "";
      const version = encodeURIComponent(String(state.staticTracks?.cacheVersion || ""));
      // Let the first segment reach the decoder while later segments fetch.
      // Keep a bounded four-request window instead of waiting for all 18s.
      for await (const { index, value: ab } of orderedPrefetch(indexes, (index) => {
        return fetchBytes(`${base}/${segmentName(index)}?v=${version}`, 15000, "force-cache");
      }, { concurrency: 4, shouldStop: () => state.stopRequested })) {
        if (state.stopRequested) break;
        const name = segmentName(index);
        batchBytes += ab.byteLength;
        fetchedCount += 1;
        state.compressedPrefetchBytesMax = Math.max(state.compressedPrefetchBytesMax || 0, batchBytes);
        state.compressedPrefetchSourceSec = Math.max(state.compressedPrefetchSourceSec || 0, fetchedCount * segmentSourceSeconds);

        // Keep the long reserve compressed. Before playback begins decode only
        // enough for the startup target; after that, normal lead limiting keeps
        // just a few seconds of decoded frames/PCM in memory.
        while (!state.stopRequested && state.audioStart == null) {
          const targets = state.bufferTargets || fastPlaybackBufferTargets({
            playbackRate: state.playbackRate,
            fps: state.requestedFps,
          });
          const ready = kind === "video"
            ? decodedVideoAheadSec(state, state.segmentOffsetSourceSec || 0) >= targets.startupVideoSourceSec + 0.5
            : pendingAudioBufferedSec(state) >= targets.startupAudioWallSec + 0.5;
          if (!ready) break;
          await sleep(20);
        }

        await holdIfTooFarAhead(state, lastPtsSec, kind);
        appendBuffer(ab);
        fed.add(name);
        await processPending();
      }
      nextIndex = batchEnd + 1;
    }

    if (state.stopRequested) throw new Error("Stopped");
    file.flush();
    await processPending();
    return finishTrack();
  }

  if (state.bufferLab) {
    // Network production stays ahead of decoding. The producer fetches ordered
    // compressed 0.5s fragments concurrently; the consumer keeps only 4s of
    // decoded frames/PCM. Both bytes and segment count bound Tesla memory.
    const reserve = new BoundedSegmentBuffer();
    const claimed = new Set();
    const stopped = () => state.stopRequested;
    const producer = (async () => {
      while (!stopped()) {
        if (!reserve.hasCapacity) {
          await sleep(80);
          continue;
        }
        const status = await fetchJson(`/api/experimental/cyberdash/${state.sessionId}/status`, {}, 5000);
        if (status.error) throw new Error(status.error);
        if (kind === "video" && status.throughput && !status.done) {
          state.serverThroughputBaseline ??= status.throughput;
          const measured = measureServerThroughput(state.serverThroughputBaseline, status.throughput);
          if (measured) {
            state.serverThroughput = measured;
            state.serverThroughputBaseline = status.throughput;
          }
        }
        const available = status.available?.[kind] || [];
        const fresh = available.filter((name) => !claimed.has(name) && !fed.has(name))
          .slice(0, Math.min(6, reserve.maxSegments - reserve.size));
        fresh.forEach((name) => claimed.add(name));
        if (kind === "video") state.videoProducerWaiting = fresh.length === 0 && !status.done;
        for await (const { value: segment } of orderedPrefetch(fresh, async (name) => {
          let timing = null;
          const data = await fetchBytes(
            `/stream/experimental/cyberdash/${state.sessionId}/${encodeURIComponent(name)}?t=${Date.now()}`,
            12000, "no-store", (sample) => { timing = sample; }
          );
          return { name, data, timing };
        }, { concurrency: 4, shouldStop: stopped })) {
          if (stopped()) break;
          if (kind === "video" && segment.timing) {
            state.deliveryBytes = (state.deliveryBytes || 0) + segment.data.byteLength;
            state.latencyMs = round(segment.timing.ttfbMs, 1);
            state.latencyAt = performance.now();
            const capacityBps = videoCapacitySample(segment.data.byteLength, segment.timing.elapsedMs);
            if (capacityBps != null) {
              state.capacityBps = capacityBps;
              state.capacityAt = performance.now();
            }
          }
          if (!await reserve.push(segment, { shouldStop: stopped })) break;
          state.compressedPrefetchBytesMax = Math.max(state.compressedPrefetchBytesMax, reserve.peakBytes);
          state.compressedPrefetchSourceSec = Math.max(state.compressedPrefetchSourceSec, reserve.peakSegments * 0.5);
          if (kind === "video") {
            state.compressedAheadSec = reserve.size * 0.5;
            state.compressedAheadBytes = reserve.bytes;
          }
        }
        if (status.done && available.every((name) => claimed.has(name) || fed.has(name))) break;
        if (fresh.length === 0) await sleep(120);
      }
      reserve.close();
    })().catch((error) => reserve.fail(error));

    try {
      while (!stopped()) {
        const segment = await reserve.shift({ shouldStop: stopped });
        if (!segment) break;
        if (kind === "video") {
          state.compressedAheadSec = reserve.size * 0.5;
          state.compressedAheadBytes = reserve.bytes;
        }
        // Do not decode the entire compressed reserve before the audio clock
        // starts: the pre-start limiter below matches the safe prepared path.
        while (!stopped() && state.audioStart == null && !state.externalAudioElement) {
          const targets = state.bufferTargets;
          const ready = kind === "video"
            ? decodedVideoAheadSec(state, state.segmentOffsetSourceSec || 0) >= targets.startupVideoSourceSec + 0.5
            : pendingAudioBufferedSec(state) >= targets.startupAudioWallSec + 0.5;
          if (!ready) break;
          await sleep(20);
        }
        await holdIfTooFarAhead(state, lastPtsSec, kind);
        const segmentStartPts = lastPtsSec;
        const segmentStartBytes = trackReceivedBytes;
        appendBuffer(segment.data);
        fed.add(segment.name);
        await processPending();
        if (kind === "video") {
          const mediaSeconds = lastPtsSec - segmentStartPts;
          const segmentBytes = trackReceivedBytes - segmentStartBytes;
          if (mediaSeconds >= 0.25 && segmentBytes >= 16 * 1024) {
            state.mediaBps = Math.round(segmentBytes * 8 / mediaSeconds);
            state.mediaAt = performance.now();
          }
        }
      }
      await producer;
    } finally {
      reserve.close();
    }
    if (stopped()) throw new Error("Stopped");
    file.flush();
    await processPending();
    return finishTrack();
  }

  while (!state.stopRequested) {
    const status = await fetchJson(`/api/experimental/cyberdash/${state.sessionId}/status`, {}, 5000);
    if (status.error) throw new Error(status.error);
    if (kind === "video" && status.throughput && !status.done) {
      state.serverThroughputBaseline ??= status.throughput;
      const measured = measureServerThroughput(state.serverThroughputBaseline, status.throughput);
      if (measured) {
        state.serverThroughput = measured;
        state.serverThroughputBaseline = status.throughput;
      }
    }
    const available = status.available?.[kind] || [];
    let progressed = false;

    for (const name of available) {
      if (fed.has(name)) continue;
      if (kind === "video") state.videoProducerWaiting = false;
      await holdIfTooFarAhead(state, lastPtsSec, kind);
      const segmentStartPts = lastPtsSec;
      const segmentStartBytes = trackReceivedBytes;
      await appendFile(name);
      fed.add(name);
      await processPending();
      if (kind === "video" && !state.preparedStatic) {
        const mediaSeconds = lastPtsSec - segmentStartPts;
        const segmentBytes = trackReceivedBytes - segmentStartBytes;
        if (mediaSeconds >= 0.25 && segmentBytes >= 16 * 1024) {
          state.mediaBps = Math.round(segmentBytes * 8 / mediaSeconds);
          state.mediaAt = performance.now();
        }
      }
      progressed = true;
    }

    if (status.done && available.every((name) => fed.has(name))) {
      file.flush();
      await processPending();
      return finishTrack();
    }
    if (!progressed) {
      if (kind === "video") state.videoProducerWaiting = true;
      await sleep(120);
    }
  }

  throw new Error("Stopped");
}

function startRenderLoop(state) {
  return new Promise((resolve, reject) => {
    let rafId = 0;
    let timerId = 0;
    const ctx = state.canvas.getContext("2d", { alpha: false });
    const targets = state.bufferTargets || fastPlaybackBufferTargets({
      playbackRate: state.playbackRate,
      fps: state.requestedFps,
    });

    let lastStatsAt = performance.now();
    let lastStatsRenderedFrames = state.renderedFrames;
    let lastStatsReceivedFrames = state.renderedFrames + state.droppedFrames + state.decodedVideo.length;
    let lastStatsDroppedFrames = state.droppedFrames;
    let lastStatsDeliveryBytes = state.deliveryBytes || 0;
    let lastStatsQueueSeconds = 0;

    const emitStats = (now = performance.now()) => {
      if (!state.onStats || now - lastStatsAt < 1000) return;
      const elapsed = playbackElapsed(state);
      const queueSeconds = decodedVideoAheadSec(state, elapsed);
      const receivedFrames = state.renderedFrames
        + state.droppedFrames
        + state.decodedVideo.length
        + Number(state.videoDecoder?.decodeQueueSize || 0);
      const deltaSec = Math.max(0.001, (now - lastStatsAt) / 1000);
      const renderedFps = Math.max(0, (state.renderedFrames - lastStatsRenderedFrames) / deltaSec);
      const receiveFps = Math.max(0, (receivedFrames - lastStatsReceivedFrames) / deltaSec);
      const deliveryBytes = state.deliveryBytes || 0;
      const deliveryBps = state.preparedStatic ? null : Math.round(Math.max(0, deliveryBytes - lastStatsDeliveryBytes) * 8 / deltaSec);
      const recentCapacity = !state.preparedStatic && state.capacityAt != null && now - state.capacityAt <= 3500;
      const recentLatency = !state.preparedStatic && state.latencyAt != null && now - state.latencyAt <= 3500;
      const recentMedia = state.mediaAt != null && now - state.mediaAt <= 3500;
      const queueDelta = queueSeconds - lastStatsQueueSeconds;
      const queueTrend = queueDelta > 0.12 ? "growing" : (queueDelta < -0.12 ? "shrinking" : "stable");
      const lastDriftMs = state.drifts.length ? state.drifts[state.drifts.length - 1] : 0;
      auditAudioHealth(state, now, state.renderedFrames > state.audioDiagnosticLastFrames);
      state.audioDiagnosticLastFrames = state.renderedFrames;
      state.onStats({
        transport: "webcodecs",
        adaptiveEligible: !state.preparedStatic,
        bufferLab: Boolean(state.bufferLab),
        compressedAheadSec: state.bufferLab ? state.compressedAheadSec : null,
        compressedAheadBytes: state.bufferLab ? state.compressedAheadBytes : null,
        fps: state.requestedFps,
        ...state.serverThroughput,
        effectiveFps: renderedFps,
        effectiveWidth: state.effectiveWidth || null,
        effectiveHeight: state.effectiveHeight || null,
        renderedFps,
        receiveFps,
        deliveryBps,
        capacityBps: recentCapacity ? state.capacityBps : null,
        capacitySampleAt: recentCapacity ? state.capacityAt : null,
        sourceWaiting: Boolean(state.videoProducerWaiting),
        latencyMs: recentLatency ? state.latencyMs : null,
        mediaBps: recentMedia ? state.mediaBps : null,
        producerSpeed: receiveFps / Math.max(1, state.requestedFps),
        renderedFrames: state.renderedFrames,
        receivedFrames,
        droppedFrames: state.droppedFrames,
        droppedFramesDelta: Math.max(0, state.droppedFrames - lastStatsDroppedFrames),
        decoderQueueSize: state.videoDecoder?.decodeQueueSize ?? null,
        queueSeconds,
        queueTargetSeconds: state.firstPictureMs == null
          ? Math.max(
            Number(state.bufferTargets?.startupVideoSourceSec || 0),
            Number(state.bufferTargets?.startupVideoFrames || 0) / Math.max(1, Number(state.requestedFps) || 30),
          )
          : Number(state.bufferTargets?.rebufferHighVideoSourceSec || 0),
        queueTrend,
        rebufferCount: state.rebufferCount,
        rebufferDurationMs: Math.max(0, state.rebufferMs + (state.rebuffering
          ? now - (state.rebufferStartedAt || now)
          : 0)),
        playbackRate: normalizePlaybackRate(state.playbackRate),
        audioMuted: Boolean(state.requestedMuted),
        audioOnlyPressure: state.rebuffering && !state.audioFeedDone
          && (state.videoFeedDone || queueSeconds >= targets.rebufferHighVideoSourceSec)
          && scheduledAudioAheadSec(state) < targets.rebufferHighWallSec,
        audioStatus: state.requestedMuted
          ? "muted"
          : (state.externalAudioElement
            ? (state.externalAudioElement.readyState >= 3 ? "ready" : "waiting")
            : (state.audioFeedDone ? "ended" : (state.audioCtx?.state === "running" ? "ready" : `context-${state.audioCtx?.state || "missing"}`))),
        sourceEnded: Boolean(state.videoFeedDone),
        lastAvDriftMs: lastDriftMs,
        state: state.paused ? "paused" : (state.rebuffering ? "buffering" : "playing"),
      });
      lastStatsAt = now;
      lastStatsRenderedFrames = state.renderedFrames;
      lastStatsReceivedFrames = receivedFrames;
      lastStatsDroppedFrames = state.droppedFrames;
      lastStatsDeliveryBytes = deliveryBytes;
      lastStatsQueueSeconds = queueSeconds;
    };

    const beginRebuffer = () => {
      if (
        state.rebuffering ||
        state.paused ||
        state.externalAudioElement ||
        !state.audioCtx ||
        state.audioCtx.state === "closed"
      ) return;
      state.rebuffering = true;
      state.rebufferCount++;
      state.rebufferStartedAt = performance.now();
      state.onStatus?.("buffering", {
        phase: "rebuffer",
        rebufferCount: state.rebufferCount,
      });
      Promise.resolve(state.audioCtx.suspend()).catch((error) => {
        state.decoderError = `AudioContext rebuffer suspend: ${error?.message || error}`;
      });
    };

    const maybeResumeFromRebuffer = () => {
      if (!state.rebuffering || state.rebufferResumePending || state.paused) return;
      const elapsed = playbackElapsed(state);
      const videoAhead = decodedVideoAheadSec(state, elapsed);
      const audioAhead = scheduledAudioAheadSec(state);
      const videoReady = state.videoFeedDone || videoAhead >= targets.rebufferHighVideoSourceSec;
      const audioReady = state.audioFeedDone || audioAhead >= targets.rebufferHighWallSec;
      if (!videoReady || !audioReady) return;
      state.rebufferResumePending = true;
      Promise.resolve(state.audioCtx.resume()).then(() => {
        if (state.stopRequested) return;
        const duration = Math.max(0, performance.now() - (state.rebufferStartedAt || performance.now()));
        state.rebufferMs += duration;
        state.maxRebufferMs = Math.max(state.maxRebufferMs, duration);
        state.rebuffering = false;
        state.rebufferResumePending = false;
        state.rebufferStartedAt = null;
        state.onStatus?.("playing", {
          phase: "rebuffer",
          rebufferCount: state.rebufferCount,
        });
      }).catch((error) => {
        state.rebufferResumePending = false;
        state.decoderError = `AudioContext rebuffer resume: ${error?.message || error}`;
      });
    };

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
          emitStats();
          schedule();
          return;
        }
        if (state.decoderError) throw new Error(state.decoderError);
        if (state.rebuffering) {
          emitStats();
          maybeResumeFromRebuffer();
          schedule();
          return;
        }

        const elapsed = playbackElapsed(state);
        if (state.firstPictureMs != null && !state.videoFeedDone && !state.audioFeedDone) {
          const rate = normalizePlaybackRate(state.playbackRate);
          const videoAhead = decodedVideoAheadSec(state, elapsed);
          const audioAhead = scheduledAudioAheadSec(state);
          const now = performance.now();
          if (audioAhead >= 0.05) state.lastAudioAheadAt = now;
          const needsBuffer = rate > 1
            ? videoAhead < targets.rebufferLowWallSec * rate || audioAhead < targets.rebufferLowWallSec
            : normalSpeedNeedsRebuffer({
              hasFirstPicture: true,
              videoFeedDone: state.videoFeedDone,
              audioFeedDone: state.audioFeedDone,
              videoAheadSec: videoAhead,
              audioAheadSec: audioAhead,
              timeSinceVideoFrameMs: now - (state.lastVideoFrameAt ?? now),
              timeSinceAudioReadyMs: now - (state.lastAudioAheadAt ?? now),
            });
          if (needsBuffer) {
            beginRebuffer();
            schedule();
            return;
          }
        }
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
        const exhaustion = detectPrematureAudioEnd({
          playing: true,
          hasFirstPicture: state.firstPictureMs != null,
          paused: state.paused,
          stopped: state.stopRequested,
          muted: state.requestedMuted,
          externalAudio: Boolean(state.externalAudioElement),
          audioFeedDone: state.audioFeedDone,
          audioEndPtsSec: state.audioEndPtsSec,
          videoEndPtsSec: Math.max(
            Number(state.videoEndPtsSec) || 0,
            Number(state.lastVideoPtsSec) || 0,
          ),
          knownVideoEndSec: state.knownVideoEndSourceSec,
          currentSourceSec: state.startAt + elapsed,
          audioAheadSec: scheduledAudioAheadSec(state),
          playbackRate: state.playbackRate,
          startAt: state.startAt,
          segmentOffsetSourceSec: state.segmentOffsetSourceSec,
        });
        if (exhaustion) {
          throw new Error(
            "Audio ended before video continued" +
            ` audioEnd=${round(exhaustion.audioEndSourceSec, 2)}s` +
            ` videoEnd=${round(exhaustion.evidenceEndSourceSec, 2)}s` +
            ` position=${round(state.startAt + elapsed, 2)}s` +
            ` rate=${normalizePlaybackRate(state.playbackRate)}`
          );
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
          state.effectiveWidth = Number(frame.displayWidth) > 0 ? Number(frame.displayWidth) : null;
          state.effectiveHeight = Number(frame.displayHeight) > 0 ? Number(frame.displayHeight) : null;
          ctx.drawImage(frame, 0, 0, state.canvas.width, state.canvas.height);
          state.lastVideoFrameAt = performance.now();
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

        emitStats();
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
  const sourceDuration = Number(state.sourceDurationSec ?? initial.duration);
  const manifestDuration = Number(initial.manifest?.durationSec);
  state.sourceDurationSec = Number.isFinite(sourceDuration) && sourceDuration > 0
    ? sourceDuration
    : (Number.isFinite(manifestDuration) && manifestDuration > 0
      ? Math.max(0, Number(state.startAt) || 0) + manifestDuration
      : null);
  state.knownVideoEndSourceSec = state.sourceDurationSec;

  state.videoDecoder = new VideoDecoder({
    output(frame) {
      state.decodedVideo.push(frame);
      state.lastVideoPtsSec = Math.max(Number(state.lastVideoPtsSec) || 0, Number(frame.timestamp || 0) / 1e6);
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

  const targets = state.bufferTargets || fastPlaybackBufferTargets({
    playbackRate: state.playbackRate,
    fps: state.requestedFps,
  });
  state.bufferTargets = targets;
  const fastPlayback = normalizePlaybackRate(state.playbackRate) > 1;
  const prebufferDeadline = performance.now() + (fastPlayback ? 15000 : 10000);
  let lastBufferStatusAt = 0;
  while (!state.stopRequested) {
    if (state.decoderError) throw new Error(state.decoderError);
    const videoSourceSec = decodedVideoAheadSec(state, state.segmentOffsetSourceSec || 0);
    const audioWallSec = state.externalAudioElement ? targets.startupAudioWallSec : pendingAudioBufferedSec(state);
    const minimumReady = state.decodedVideo.length >= (state.videoFeedDone ? 1 : 3)
      && (state.externalAudioElement || state.pendingAudio.length >= 1);
    if (playbackStartupReady({
      playbackRate: state.playbackRate,
      videoFrames: state.decodedVideo.length,
      audioBlocks: state.pendingAudio.length,
      videoSourceSec, audioWallSec,
      videoFeedDone: state.videoFeedDone,
      audioFeedDone: state.audioFeedDone,
      externalAudio: Boolean(state.externalAudioElement),
      targets,
    })) break;

    if (performance.now() > prebufferDeadline) {
      if (minimumReady) {
        state.startupBufferShortfall = true;
        break;
      }
      throw new Error(`Startup prebuffer timed out: video=${state.decodedVideo.length} audio=${state.pendingAudio.length}`);
    }

    if (fastPlayback && performance.now() - lastBufferStatusAt > 300) {
      lastBufferStatusAt = performance.now();
      state.onStatus?.("buffering", {
        phase: "startup",
        videoSourceSec,
        audioWallSec,
        targetVideoSourceSec: targets.startupVideoSourceSec,
        targetAudioWallSec: targets.startupAudioWallSec,
      });
    }
    await sleep(15);
  }
  if (state.stopRequested) return;
  state.startupVideoBufferSec = decodedVideoAheadSec(state, state.segmentOffsetSourceSec || 0);
  state.startupAudioBufferSec = state.externalAudioElement ? null : pendingAudioBufferedSec(state);

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
  // Observe render failures immediately. A broken audio schedule must release
  // feedTrack's lead limiter instead of waiting for both media feeds to finish.
  const [videoResult, audioResult] = await Promise.all([videoFeed, audioFeed, renderPromise]);
  state.mediaEndSec = Math.max(videoResult.lastPtsSec, audioResult.lastPtsSec || 0);

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
          rebufferCount: state.rebufferCount,
          ...state.serverThroughput,
          lastAvDriftMs: round(lastDrift, 1),
          audioLateBlocks: state.audioLateBlocks,
          audioOverlapPrevented: state.audioOverlapPrevented,
          audioContinuityCorrections: state.audioContinuityCorrections,
          maxAudioScheduleSlipMs: round(state.maxAudioScheduleSlipMs, 1),
          playbackRate: normalizePlaybackRate(state.playbackRate),
          audioMode: state.externalAudioElement ? "media-element" : "web-audio",
          pitchMode: state.externalAudioElement ? "browser-preserves-pitch" : "server-atempo",
          cacheMode: state.preparedStatic ? "processed-static-fmp4" : "live-transcode",
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
          audioDiagnosticGapReason: state.audioDiagnosticGapReason || "none",
          ...audioHealthSnapshot(state),
          receivedMbps: round(state.receivedBytes * 8 / Math.max(0.25, (performance.now() - state.startedAt) / 1000) / 1_000_000, 2),
          startupVideoBufferSec: round(state.startupVideoBufferSec, 2),
          startupAudioBufferSec: round(state.startupAudioBufferSec, 2),
          startupBufferShortfall: state.startupBufferShortfall ? 1 : 0,
          rebufferMs: round(state.rebufferMs, 1),
          maxRebufferMs: round(state.maxRebufferMs, 1),
          compressedPrefetchSourceSec: round(state.compressedPrefetchSourceSec, 1),
          compressedPrefetchBytesMax: state.compressedPrefetchBytesMax || 0,
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
  onStats,
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
    preparedId = null,
    height = 720,
    fps = 30,
    startAt = 0,
    muted = false,
    playbackRate = 1,
    bufferLab = false,
    audioElement = null,
    audioPlayPromise = null,
  } = {}) {
    if (!url && !preparedId) throw new Error("YouTube URL or prepared item id is required");

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
      sourceUrl: url || `processed://${preparedId}`,
      preparedId: preparedId || null,
      preparedStatic: false,
      initialStatus: null,
      staticTracks: null,
      segmentOffsetSourceSec: 0,
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
      lastVideoFrameAt: null,
      lastAudioAheadAt: null,
      bufferLab: Boolean(bufferLab && !preparedId),
      bufferTargets: fastPlaybackBufferTargets({ playbackRate, fps, bufferLab: Boolean(bufferLab && !preparedId) }),
      startupVideoBufferSec: 0,
      startupAudioBufferSec: 0,
      startupBufferShortfall: false,
      rebuffering: false,
      rebufferResumePending: false,
      rebufferStartedAt: null,
      rebufferCount: 0,
      rebufferMs: 0,
      maxRebufferMs: 0,
      videoDecoder: null,
      audioDecoder: null,
      videoFeedDone: false,
      audioFeedDone: false,
      audioEndPtsSec: null,
      audioEndSourceSec: null,
      videoEndPtsSec: null,
      lastVideoPtsSec: 0,
      knownVideoEndSourceSec: null,
      sourceDurationSec: null,
      mediaEndSec: 0,
      renderedFrames: 0,
      droppedFrames: 0,
      decodedAudioBlocks: 0,
      scheduledAudioBlocks: 0,
      audioDiagnosticLastReportAt: performance.now(),
      audioDiagnosticLastFrames: 0,
      audioDiagnosticGapAt: 0,
      audioDiagnosticGapReason: null,
      audioDiagnosticReported: false,
      receivedBytes: 0,
      deliveryBytes: 0,
      capacityBps: null,
      capacityAt: null,
      latencyMs: null,
      latencyAt: null,
      mediaBps: null,
      mediaAt: null,
      effectiveWidth: null,
      effectiveHeight: null,
      compressedPrefetchSourceSec: 0,
      compressedPrefetchBytesMax: 0,
      compressedAheadSec: 0,
      compressedAheadBytes: 0,
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
      onStats,
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
      const endpoint = preparedId
        ? "/api/experimental/cyberdash/prepared/start"
        : "/api/experimental/cyberdash/start";
      const response = await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preparedId ? {
          id: preparedId,
          height: Number.isFinite(Number(height)) ? Number(height) : 0,
          startAt: next.startAt,
          playbackRate: next.playbackRate,
        } : {
          url,
          height: Number.isFinite(Number(height)) ? Number(height) : 0,
          fps: Number(fps) || 30,
          startAt: next.startAt,
          playbackRate: next.playbackRate,
          bufferLab: next.bufferLab,
        }),
      }, preparedId ? 12000 : 45000);
      next.sessionId = response.id;
      const responseDuration = Number(response.duration);
      if (Number.isFinite(responseDuration) && responseDuration > 0) {
        next.sourceDurationSec = responseDuration;
        next.knownVideoEndSourceSec = responseDuration;
      }
      next.preparedStatic = Boolean(response.preparedStatic);
      // A rapid rate change/Stop can finish while the start request is still
      // resolving. Release that late-created encoder instead of orphaning it.
      if (state !== next || next.stopRequested) {
        await stopServerSession(next);
        return;
      }
      next.resolveMs = response.resolveMs;
      next.initialStatus = next.preparedStatic ? response : null;
      next.staticTracks = response.staticTracks || null;
      next.segmentOffsetSourceSec = Math.max(0, Number(response.segmentOffsetSourceSec) || 0);
      if (next.preparedStatic) {
        next.startAt = Math.max(0, Number(response.startAt) || 0);
        next.requestedFps = Math.max(5, Math.min(60, Number(response.fps) || next.requestedFps));
        next.bufferTargets = fastPlaybackBufferTargets({
          playbackRate: next.playbackRate,
          fps: next.requestedFps,
        });
      }
      await runSession(next);
      if (state === next) await sendSummary(next, "completed", "Embedded DASH/WebCodecs playback completed.");
    } catch (error) {
      // Stop/seek/method/rate changes intentionally abort the old session. Treat
      // that as normal cancellation so a stale promise cannot show a fatal toast
      // while the replacement stream is already playing.
      if (next.stopRequested) return;
      // A paused frame must stay a paused frame. If a background fetch/decoder
      // failure races with Pause, defer surfacing it until the user resumes.
      while (!next.stopRequested && next.paused) await sleep(50);
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

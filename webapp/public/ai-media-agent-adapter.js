// Opt-in, same-origin browser adapter for the Phase 1 local relay.
// This is a thin facade over the existing YT Streamer player. It never accepts
// arbitrary URLs, scripts, or OS commands.
(() => {
  "use strict";
  const params = new URLSearchParams(location.search);
  // Both clients remain localhost-only. Neither mode is enabled by default.
  if (location.hostname !== "stream.ameshalex.com" &&
      (!(params.has("ai_agent_dev") || params.has("ai_agent_trusted_dev")) ||
      !["127.0.0.1", "localhost"].includes(location.hostname))) return;

  const results = new Map();
  let lastEvidence = null;
  let lastProgressAt = null;
  let lastPlaybackKey = null;
  const clockEvidence = new Map();
  let controlTail = Promise.resolve();
  const number = (value, fallback = 0) => Number.isFinite(value) ? Math.max(0, value) : fallback;
  function stateSnapshot() {
    const screen = document.querySelector("#screen");
    const video = document.querySelector("#video");
    const stats = activeCompat?.bufferedPlayer?.getStats?.();
    const active = Boolean(replayFn && screen?.classList.contains("playing"));
    const mode = screen?.classList.contains("cyberdash-mode") ? "webcodecs"
      : screen?.classList.contains("mjpeg-buffered-mode") ? "buffered_mjpeg"
      : screen?.classList.contains("mjpeg-mode") ? "mjpeg"
      : screen?.classList.contains("video-mode") ? "native_video" : "inactive";
    const mediaId = active ? String(state?.youtubeSearchPlayingId || state?.youtubeHistoryPlayingId || state?.playingItemId || state?.legacyPlayingId || state?.recommendedPlayingId || "") : "";
    const playbackKey = active ? `${mediaId}|${mode}|${streamAttempt}` : null;
    if (playbackKey !== lastPlaybackKey) {
      lastPlaybackKey = playbackKey;
      lastEvidence = null;
      lastProgressAt = null;
      clockEvidence.clear();
    }
    let playback_phase = "idle";
    if (active) {
      const now = performance.now();
      const sampleClock = (key, value) => {
        const previous = clockEvidence.get(key);
        const advanced = previous && value > previous.value + 0.03 && now - previous.at < 2500;
        clockEvidence.set(key, { value, at: now });
        return Boolean(advanced);
      };
      if (playbackPaused) { lastProgressAt = null; playback_phase = "paused"; }
      else if (document.querySelector("#streamBadge")?.classList.contains("error")) { lastProgressAt = null; playback_phase = "failed"; }
      else if (stats?.state === "autoplay-blocked") { lastProgressAt = null; playback_phase = "needs_user_gesture"; }
      else if (screen.classList.contains("loading") || stats?.state === "buffering") { lastProgressAt = null; playback_phase = "buffering"; }
      const counterReset = stats && lastEvidence && (stats.renderedFrames < lastEvidence.rendered || stats.receivedFrames < lastEvidence.received);
      const countersAdvanced = stats && lastEvidence && !counterReset && (stats.renderedFrames > lastEvidence.rendered || stats.receivedFrames > lastEvidence.received);
      if (counterReset || !stats) lastProgressAt = null;
      if (countersAdvanced) lastProgressAt = now;
      const freshFrames = stats && lastProgressAt != null && now - lastProgressAt < 2500;
      if (stats) lastEvidence = { rendered: stats.renderedFrames || 0, received: stats.receivedFrames || 0 };
      else lastEvidence = null;
      if (playback_phase === "idle") {
        if (mode === "buffered_mjpeg") playback_phase = stats?.state === "playing" && stats.renderedFrames > 0 && freshFrames ? "playing" : "buffering";
        else if (mode === "webcodecs") {
          const currentTime = number(cyberdashPlayer?.currentTime?.());
          playback_phase = cyberdashPlayer?.isActive?.() && sampleClock("webcodecs", currentTime) ? "playing" : "buffering";
        } else if (mode === "native_video") {
          playback_phase = !video?.paused && video.readyState >= 2 && sampleClock("native_video", number(video.currentTime)) ? "playing" : "buffering";
        } else if (mode === "mjpeg") {
          const badge = document.querySelector("#streamBadge");
          playback_phase = !screen.classList.contains("loading") && videoFrameReady() && badge?.classList.contains("live") ? "playing" : "buffering";
        } else playback_phase = "buffering";
      }
    }
    return {
      title: active ? String(document.querySelector("#nowPlaying")?.textContent || "").slice(0, 180) : "",
      media_id: mediaId,
      mode, playback_phase, paused: active ? Boolean(playbackPaused) : true,
      position_seconds: active ? number(getStreamCurrentTime?.()) : 0,
      duration_seconds: active ? number(streamSeek?.duration) : 0,
      rendered_frames: Number.isFinite(stats?.renderedFrames) ? stats.renderedFrames : null,
      observed_at: new Date().toISOString(),
      fullscreen_kind: globalThis.YTStreamerTeslaMonFullscreen?.kind?.() || "unknown",
    };
  }
  function videoFrameReady() {
    const image = document.querySelector("#mjpeg");
    return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }
  async function executeCommand(action, args = {}) {
    if (action === "get_player_state") return { status: "completed", state: stateSnapshot() };
    if (action === "request_fullscreen" || action === "exit_fullscreen") {
      // Invoke the existing player's fullscreen helper immediately. A real
      // user click must reach requestFullscreen before transient activation
      // expires; serializing this behind an async playback command loses it.
      const control = globalThis.YTStreamerTeslaMonFullscreen;
      const run = action === "request_fullscreen" ? control?.enter : control?.exit;
      if (typeof run !== "function") return { status: "unsupported" };
      try {
        await run();
        return { status: "completed", state: stateSnapshot() };
      } catch (error) {
        if (["NotAllowedError", "SecurityError"].includes(error?.name))
          return { status: "needs_user_gesture" };
        return { status: "failed", error: "fullscreen_failed" };
      }
    }
    if (action === "search_media") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query.length < 2 || query.length > 120) return { status: "failed", error: "invalid_query" };
      const limit = Number.isInteger(args.limit) ? Math.min(10, Math.max(1, args.limit)) : 5;
      const latestMkbhd = args.source === "latest_mkbhd";
      const data = await api.get(latestMkbhd
        ? `/api/youtube/latest-channel?channel=mkbhd&limit=${limit}`
        : `/api/youtube/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      const entries = (data.items || []).slice(0, limit).filter((item) => /^[A-Za-z0-9_-]{11}$/.test(item.id || ""));
      results.clear();
      entries.forEach((item) => results.set(item.id, item));
      return { status: "completed", result: { results: entries.map((item) => ({
        media_id: item.id, title: String(item.title || "").slice(0, 160),
        creator: String(item.channelTitle || "").slice(0, 100),
        duration_seconds: Number.isFinite(item.duration) ? item.duration : null,
      })) } };
    }
    if (action === "play_media") {
      const item = results.get(args.media_id);
      if (!item) return { status: "failed", error: "search_and_select_media_id_first" };
      await streamYoutubeSearchResult(item, [...results.values()]);
      return { status: "accepted", state: stateSnapshot() };
    }
    if (!["pause", "resume", "stop"].includes(action)) return { status: "failed", error: "unknown_action" };
    if (action === "stop") {
      if (!replayFn && stateSnapshot().playback_phase === "idle") return { status: "completed", state: stateSnapshot() };
      stopPlayback?.();
      return { status: "completed", state: stateSnapshot() };
    }
    if (!replayFn || !document.querySelector("#screen")?.classList.contains("playing")) return { status: "failed", error: "no_active_playback" };
    if (action === "pause") pausePlayback?.();
    else await resumePlayback?.();
    const state = stateSnapshot();
    return { status: state.playback_phase === "paused" ? "completed" : "accepted", state };
  }
  function execute(action, args = {}) {
    if (action === "get_player_state") return executeCommand(action, args);
    if (!["play_media", "pause", "resume", "stop"].includes(action)) return executeCommand(action, args);
    const run = controlTail.then(() => executeCommand(action, args), () => executeCommand(action, args));
    controlTail = run.then(() => undefined, () => undefined);
    return run;
  }
  globalThis.YTStreamerMediaAgent = { get_player_state: stateSnapshot, execute };
})();

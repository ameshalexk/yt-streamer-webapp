// Local development only. No cross-device actions unless the tab is explicitly paired.
if (new URLSearchParams(location.search).has("ai_agent_dev") && ["127.0.0.1", "localhost"].includes(location.hostname)) {
// Thin dev-only media facade. Reuses existing player state and actions; no media engine.
const aiMediaResultCache = new Map();
const aiMediaSnapshot = () => {
  const screen = $("#screen");
  const active = Boolean(replayFn && screen?.classList.contains("playing"));
  const mode = screen?.classList.contains("cyberdash-mode") ? "webcodecs"
    : screen?.classList.contains("mjpeg-buffered-mode") ? "buffered_mjpeg"
    : screen?.classList.contains("mjpeg-mode") ? "mjpeg"
    : screen?.classList.contains("video-mode") ? "native_video" : "inactive";
  return {
    title: active ? ($("#nowPlaying")?.textContent || "").slice(0,180) : "",
    media_id: state.youtubeSearchPlayingId || state.playingItemId || state.recommendedPlayingId || "",
    mode,
    paused: active ? Boolean(playbackPaused) : true,
    position_seconds: active ? Math.max(0, getStreamCurrentTime() || 0) : 0,
    duration_seconds: active ? Math.max(0, streamSeek.duration || 0) : 0,
    fullscreen_kind: fullscreenElement() === screen ? "native" : syntheticFullscreen ? "synthetic" : "none",
  };
};
window.YTStreamerMediaAgent = {
  get_player_state: aiMediaSnapshot,
  async execute(action, args = {}) {
    const before = aiMediaSnapshot();
    if (action === "get_player_state") return {status:"completed"};
    if (action === "search_media") {
      const query = args.query?.trim();
      if (typeof query !== "string" || query.length < 2 || query.length > 120) return {status:"failed",error:"invalid_query"};
      const limit = Number.isInteger(args.limit) ? Math.min(10,Math.max(1,args.limit)) : 5;
      const data = await api.get(`/api/youtube/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      const entries = (data.items || []).slice(0,limit).filter(item => /^[a-zA-Z0-9_-]{11}$/.test(item.id || ""));
      aiMediaResultCache.clear();
      for (const item of entries) aiMediaResultCache.set(item.id, item);
      // Metadata comes from YouTube and must be treated as untrusted data by callers.
      return {status:"completed",result:{results:entries.map(item => ({
        media_id:item.id,title:String(item.title || "").slice(0,160),
        creator:String(item.channelTitle || "").slice(0,100),
        duration_seconds:Number.isFinite(item.duration) ? item.duration : null,
      }))}};
    }
    if (action === "play_media") {
      const item = aiMediaResultCache.get(args.media_id);
      if (!item) return {status:"failed",error:"search_and_select_media_id_first"};
      await streamYoutubeSearchResult(item,[...aiMediaResultCache.values()]);
      return {status:"accepted"}; // Playback startup/autoplay not yet confirmed.
    }
    if (!replayFn || !$("#screen")?.classList.contains("playing")) return {status:"failed",error:"no_active_playback"};
    if (action === "pause") {
      if (!playbackPaused) pausePlayback();
      return {status:playbackPaused?"completed":"failed"};
    }
    if (action === "resume") {
      if (playbackPaused) await resumePlayback();
      return {status:playbackPaused?"needs_user_gesture":"accepted"}; // Actual audio/video readiness is asynchronous.
    }
    if (action === "seek") {
      if (!streamSeek.seekable || !replayFn) return {status:"unsupported",error:"stream_not_seekable"};
      seekStreamTo(args.position_seconds);
      return {status:"accepted"}; // Restream may fail; do not claim completion.
    }
    if (action === "next") {
      const context = autoplayContext;
      const index = context?.queue?.findIndex(item => String(item.id) === context.itemId) ?? -1;
      const next = index >= 0 ? context.queue[index+1] : null;
      if (!next) return {status:"unsupported",error:"no_next_item"};
      if (context.kind === "youtube-search") await streamYoutubeSearchResult(next,context.queue);
      else if (context.kind === "recommendations") await streamRecommendation(next,context.queue);
      else if (context.kind === "library") playLegacyItem(next,null,0,context.queue);
      else if (context.kind === "library-playlist") await streamLegacyPlaylistVideo(next,context.queue);
      else return {status:"unsupported",error:"unknown_queue"};
      return {status:"accepted"};
    }
    if (action === "set_volume") {
      // HTML media volume support varies by Tesla/iOS and buffered PCM; don't claim system volume.
      return {status:"unsupported",error:"volume_control_unverified_for_current_playback_mode"};
    }
    if (action === "request_fullscreen") {
      const screen = $("#screen");
      if (fullscreenElement() === screen) return {status:"completed"};
      // A WebSocket callback has no transient user activation. Never synthesize a fake native success.
      const button = $("#fullscreenBtn");
      if (button) {
        button.hidden = false;
        button.title = "Tap to enter fullscreen";
        button.classList.add("ai-agent-fullscreen-needed");
      }
      showFullscreenOverlays();
      return {status:"needs_user_gesture",error:"tap_fullscreen_on_player"};
    }
    return {status:"failed",error:"unknown_action"};
  },
};

}

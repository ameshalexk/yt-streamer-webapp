(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PlaybackDiagnostics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const METRICS = Object.freeze([
    ["queueSeconds", "Buffer depth", 0, 3600, 1],
    ["receiveFps", "Receive FPS", 0, 1000, 1],
    ["renderedFps", "Rendered FPS", 0, 1000, 1],
    ["droppedFrames", "Dropped frames", 0, 1e9, 0],
    ["rebufferCount", "Rebuffers", 0, 1e6, 0],
    ["latestAvDriftMs", "A/V drift", -600000, 600000, 0],
    ["decodeMs", "Decode time", 0, 600000, 1],
    ["receiveBytesPerSecond", "Stream delivery", 0, 1e9, 0],
    ["decoderQueueSize", "Decoder queue", 0, 1e6, 0],
    ["fps", "Target FPS", 0, 1000, 1],
  ]);
  const LABELS = Object.freeze({
    method: Object.freeze({ webcodecs: "WebCodecs", mjpeg: "MJPEG", jxl: "JXL", hls: "HLS", native: "Native", vlc: "VLC" }),
    state: Object.freeze({ playing: "Playing", buffering: "Buffering", reconnecting: "Reconnecting", paused: "Paused", idle: "Idle", error: "Error", stopped: "Stopped" }),
    quality: Object.freeze({ low: "Low", medium: "Medium", high: "High", auto: "Auto", source: "Source" }),
    qualityReason: Object.freeze({ startup: "Startup", user: "User selected", manual: "User selected", automatic: "Automatic adjustment", auto: "Automatic adjustment", bandwidth: "Delivery conditions", delivery_pressure: "Delivery conditions", "delivery-slow": "Delivery conditions", delivery_slow: "Delivery conditions", render_pressure: "Rendering conditions", "device-overload": "Rendering conditions", device_overload: "Rendering conditions", recovery: "Recovery", rebuffer: "Rebuffer recovery", "stable-headroom": "Stable playback", stable_headroom: "Stable playback", stable: "Stable playback", unavailable: "Unavailable" }),
    errorCategory: Object.freeze({ network: "Network", decode: "Decoder", playback: "Playback", "playback-failed": "Playback", unsupported: "Unsupported", timeout: "Timeout", cancelled: "Cancelled", unavailable: "Unavailable" }),
    audioStatus: Object.freeze({ synced: "Synced", ready: "Ready", starting: "Starting", retrying: "Retrying", silent: "Silent", muted: "Muted", source: "Source", idle: "Idle" }),
  });
  const safeLabel = (group, value) => {
    if (typeof value !== "string") return "Unavailable";
    const key = value.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(LABELS[group], key) ? LABELS[group][key] : "Unavailable";
  };
  function metricValue(snapshot, key, min, max, decimals) {
    const stats = snapshot && snapshot.stats && typeof snapshot.stats === "object" ? snapshot.stats : {};
    let value = stats[key];
    if (key === "latestAvDriftMs" && value == null) value = stats.avDriftMs ?? stats.lastAvDriftMs;
    if (key === "decodeMs" && value == null) value = stats.averageDecodeMs;
    if (value == null || value === "" || typeof value === "boolean") return "Unavailable";
    const n = typeof value === "number" ? value : (typeof value === "string" ? Number(value) : NaN);
    if (!Number.isFinite(n) || n < min || n > max) return "Unavailable";
    return Number(n.toFixed(decimals));
  }
  function normalize(snapshot) {
    snapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
    const metrics = {};
    for (const [key, , min, max, decimals] of METRICS) metrics[key] = metricValue(snapshot, key, min, max, decimals);
    let hint = "Not enough evidence";
    if (snapshot.state === "buffering") {
      if (snapshot.audioStatus === "silent" || snapshot.audioStatus === "retrying") hint = "Audio may need attention";
      else if (metrics.queueSeconds !== "Unavailable" && metrics.receiveFps !== "Unavailable" && metrics.fps !== "Unavailable"
          && metrics.fps > 0 && metrics.queueSeconds < 1 && metrics.receiveFps < metrics.fps * 0.8) hint = "Possible slow stream delivery";
      else if (metrics.queueSeconds !== "Unavailable" && metrics.renderedFps !== "Unavailable" && metrics.fps !== "Unavailable"
          && metrics.fps > 0 && metrics.queueSeconds >= 1 && metrics.renderedFps < metrics.fps * 0.8) hint = "Device rendering may be behind";
    } else if (snapshot.state === "playing") hint = "No current buffering";
    return Object.freeze({
      method: safeLabel("method", snapshot.method),
      state: safeLabel("state", snapshot.state),
      quality: safeLabel("quality", snapshot.quality),
      qualityReason: safeLabel("qualityReason", snapshot.qualityReason),
      errorCategory: safeLabel("errorCategory", snapshot.errorCategory),
      audioStatus: safeLabel("audioStatus", snapshot.audioStatus),
      hint,
      metrics: Object.freeze(metrics),
    });
  }
  function rows(snapshot) {
    const data = normalize(snapshot);
    const units = { queueSeconds: "s", receiveFps: "fps", renderedFps: "fps",
      latestAvDriftMs: "ms", decodeMs: "ms/frame", receiveBytesPerSecond: "bytes/s",
      decoderQueueSize: "frames", fps: "fps" };
    return [
      ["Method", data.method], ["Status", data.state], ["Audio", data.audioStatus], ["Quality", data.quality],
      ["Playback hint", data.hint], ["Quality reason", data.qualityReason], ["Error category", data.errorCategory],
      ...METRICS.map(([key, label]) => [label, data.metrics[key] === "Unavailable" || !units[key]
        ? data.metrics[key] : `${data.metrics[key]} ${units[key]}`]),
    ];
  }
  function report(snapshot) {
    return `${rows(snapshot).map(([label, value]) => `${label}: ${value}`).join("\n")}\nStream delivery is not an estimate of internet speed. This report excludes titles and URLs.`;
  }
  function render(container, snapshot) {
    if (!container || !container.ownerDocument) return;
    const doc = container.ownerDocument;
    const table = doc.createElement("dl");
    table.className = "playback-diagnostics-list";
    for (const [label, value] of rows(snapshot)) {
      const term = doc.createElement("dt");
      const detail = doc.createElement("dd");
      term.textContent = label;
      detail.textContent = String(value);
      table.append(term, detail);
    }
    container.replaceChildren(table);
  }
  return Object.freeze({ normalize, render, report });
});

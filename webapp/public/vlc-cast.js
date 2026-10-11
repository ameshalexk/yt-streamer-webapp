// Optional VLC handoff UI, loaded after the core player.
(() => {
  "use strict";
  const get = (id) => document.getElementById(id);
  const button = get("castVlcBtn");
  const panel = get("castVlcPanel");
  const detail = get("castVlcStatus");
  const link = get("castVlcOpen");
  if (!button || !panel || !detail || !link) return;
  let playback = null;
  let cast = null;
  function findSource(sources, meta = {}) {
    const yt = String(meta.youtubeUrl || "");
    if (/^https:\/\/(www\.)?youtube\.com\/watch/.test(yt) || /^https:\/\/youtu\.be\//.test(yt))
      return {kind: "youtube", url: yt};
    try {
      const value = new URL(sources?.mjpegUrl || sources?.tsUrl, location.origin);
      if (value.origin !== location.origin) return null;
      const item = /^\/stream\/(?:ts\/)?item\/([A-Za-z0-9_-]+)$/.exec(value.pathname);
      if (item) return {kind: "item", id: item[1]};
      const legacy = /^\/stream\/legacy\/([A-Za-z0-9_-]+)\/\d+$/.exec(value.pathname);
      if (legacy) return {kind:"legacy",id:legacy[1]};
      if (value.pathname === "/stream/youtube" || value.pathname === "/stream/ts/youtube")
        return {kind: "youtube", url: value.searchParams.get("url")};
    } catch {}
    return null;
  }
  window.ytStreamerVlcCast = {
    setSource(sources, meta) {
      playback = findSource(sources, meta);
      button.disabled = !playback;
      button.title = playback ? "Prepare a synchronized VLC stream" : "VLC cast supports saved files and YouTube";
    },
  };
  const show = (message) => { panel.hidden = false; detail.textContent = message; };
  async function call(method, url, body) {
    const r = await fetch(url, {method, credentials:"same-origin", headers:{"Content-Type":"application/json"},
      body: body ? JSON.stringify(body) : undefined, cache:"no-store"});
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(data.error || "Cast request failed (" + r.status + ")");
    return data;
  }
  button.addEventListener("click", async () => {
    if (!playback) return;
    button.disabled = true;
    show("Preparing synchronized video and audio…");
    link.hidden = true;
    try {
      if (cast) await call("DELETE", "/api/cast/sessions/" + encodeURIComponent(cast.id));
      cast = await call("POST", "/api/cast/sessions", playback);
      link.href = "vlc-x-callback://x-callback-url/stream?url=" + encodeURIComponent(cast.url);
      link.hidden = false;
      show("Ready. Tap Open VLC, then select the Chromecast inside VLC. If opening fails, copy the temporary link and paste it in VLC > Network > Open Network Stream. Expires: " + new Date(cast.expiresAt).toLocaleTimeString());
    } catch(e) { show(e.message + ". YT Streamer's current playback is unchanged."); }
    finally { button.disabled = !playback; }
  });
  get("castVlcCopy").addEventListener("click", async () => {
    if (!cast) return;
    try {
      await navigator.clipboard.writeText(cast.url);
      show("Temporary link copied. In VLC open Network > Open Network Stream and paste.");
    } catch { show("iOS blocked copying. Try Open VLC or Share."); }
  });
  get("castVlcShare").addEventListener("click", async () => {
    if (!cast || !navigator.share) return;
    try { await navigator.share({url:cast.url,title:"Temporary YT Streamer video"}); }
    catch(e) { if(e.name !== "AbortError") show("Sharing unavailable. Use Open VLC."); }
  });
  get("castVlcClose").addEventListener("click", () => { panel.hidden = true; });
  get("castVlcStop").addEventListener("click", async () => {
    if (!cast) return;
    try {
      await call("DELETE", "/api/cast/sessions/" + encodeURIComponent(cast.id));
      cast = null;
      panel.hidden = true;
      link.hidden = true;
    } catch(e) { show("Could not revoke session: " + e.message); }
  });
})();

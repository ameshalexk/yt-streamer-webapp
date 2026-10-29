// Dedicated Retro TV virtual host allowlist, keeping regular Streamer UI private.
// Cloudflare Access and Tunnel ingress must be configured separately before DNS goes live.
const RETRO_STATIC = new Set([
  "/buffered-mjpeg.js",
  "/cyberdash-embedded.mjs",
  "/ordered-prefetch.mjs",
  "/mp4box.all.mjs",
]);
export function retroHostAllows(method, pathname) {
  const verb = String(method || "GET").toUpperCase();
  const path = String(pathname || "");
  if (verb === "GET" && (path === "/" || path === "/retro-tv" || path.startsWith("/retro-tv/"))) return true;
  if (verb === "GET" && RETRO_STATIC.has(path)) return true;
  if (verb === "GET" && path === "/api/retro-tv/channels") return true;
  if (verb === "GET" && ["/stream/url", "/stream/audio/url"].includes(path)) return true;
  if (verb === "POST" && path === "/api/experimental/cyberdash/start") return true;
  if (verb === "GET" && /^\/api\/experimental\/cyberdash\/[A-Za-z0-9_-]+\/status$/.test(path)) return true;
  if (verb === "POST" && /^\/api\/experimental\/cyberdash\/[A-Za-z0-9_-]+\/stop$/.test(path)) return true;
  if (verb === "GET" && /^\/stream\/experimental\/cyberdash\/[A-Za-z0-9_-]+\/[\w.-]+$/.test(path)) return true;
  if (verb === "POST" && path === "/api/playback-event") return true;
  return false;
}

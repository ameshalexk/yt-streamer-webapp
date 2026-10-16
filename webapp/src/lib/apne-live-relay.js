// Bounded, ephemeral APNE HLS request relay. No media is persisted to disk.
import crypto from "node:crypto";
import { Readable } from "node:stream";

const SESSION_TTL_MS = 2 * 60 * 60_000;
const MAX_SESSIONS = 12;
const MAX_ASSETS = 1600;
const MAX_PLAYLIST_BYTES = 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const EXACT_HOSTS = new Set(["cdn.justfingram.com", "segments.justfingram.com", "streaming.disk.yandex.net"]);

export function validatedApneLiveAsset(raw, base) {
  let url;
  try { url = new URL(String(raw || ""), base); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.href.length > 4096 || url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
    !(EXACT_HOSTS.has(host) || host === "justfingram.com" || host === "videoapne.to" || host.endsWith(".videoapne.to"))) return null;
  // Some APNE HLS playlists fetch the AES-128 key from a narrowly scoped
  // server-side PHP endpoint rather than a .key file. Never permit arbitrary
  // PHP scripts or hosts through this relay.
  if (host === "justfingram.com" && url.pathname === "/hls_key.php" &&
      /^[A-Za-z0-9_-]{1,180}$/.test(url.searchParams.get("id") || "") &&
      [...url.searchParams.keys()].every(k => k === "id")) return { url: url.href, ext: "key" };
  const ext = url.pathname.match(/\.(m3u8|ts|m4s|mp4|aac|mp3|key|vtt)(?:$)/i)?.[1]?.toLowerCase();
  return ext ? { url: url.href, ext } : null;
}

export function rewriteApneLivePlaylist(source, base, session) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_PLAYLIST_BYTES || !source.startsWith("#EXTM3U"))
    throw new Error("Unexpected APNE HLS manifest");
  if (!session || !/^[a-f0-9]{32}$/.test(session.id) || !(session.assets instanceof Map))
    throw new Error("Invalid HLS relay session");
  const prefix = "/apne/live/media/" + session.id + "/";
  function rewrite(uri) {
    const target = validatedApneLiveAsset(uri, base);
    if (!target) throw new Error("APNE manifest contains an untrusted media URL");
    if (session.assets.size >= MAX_ASSETS) throw new Error("APNE HLS manifest has too many assets");
    const key = session.assets.size + "." + target.ext;
    session.assets.set(key, target.url);
    return prefix + key;
  }
  return source.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return "";
    if (!trimmed.startsWith("#")) return rewrite(trimmed);
    if (/^#EXT-X-(?:KEY|MAP|MEDIA|I-FRAME-STREAM-INF):/.test(trimmed)) {
      return line.replace(/\bURI="([^"]+)"/g, (_m, uri) => 'URI="' + rewrite(uri) + '"');
    }
    return line;
  }).join("\n");
}

export function createApneLiveRelay({ fetchImpl = fetch, now = Date.now } = {}) {
  const sessions = new Map();
  const error = (status, message) => Object.assign(new Error(message), { status });
  function sweep() {
    for (const [id, session] of sessions) if (now() > session.expiresAt) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }
  async function upstream(url, referer, range) {
    const headers = { "User-Agent": USER_AGENT, "Referer": referer, "Accept": "*/*" };
    if (range && /^bytes=(?:\d+-\d*|-\d+)$/.test(range)) headers.Range = range;
    const response = await fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
    if (!response.ok || response.redirected) {
      try { await response.body?.cancel(); } catch {}
      throw error(502, "APNE upstream media is not currently available");
    }
    return response;
  }
  async function manifestText(response) {
    if (Number(response.headers.get("content-length")) > MAX_PLAYLIST_BYTES) throw error(502, "APNE manifest is too large");
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_PLAYLIST_BYTES) throw error(502, "APNE manifest is too large");
    return text;
  }
  async function start({ hlsUrl, referer }) {
    const target = validatedApneLiveAsset(hlsUrl);
    if (!target || target.ext !== "m3u8") throw error(502, "Untrusted APNE playlist source");
    const response = await upstream(target.url, referer);
    const text = await manifestText(response);
    sweep();
    const session = { id: crypto.randomBytes(16).toString("hex"), assets: new Map(), referer, expiresAt: now() + SESSION_TTL_MS };
    const rewritten = rewriteApneLivePlaylist(text, target.url, session);
    sessions.set(session.id, session);
    return rewritten;
  }
  async function media(req, res) {
    const id = String(req.params.session || "");
    const asset = String(req.params.asset || "");
    const session = sessions.get(id);
    if (!session || session.expiresAt < now()) { sessions.delete(id); return res.status(410).end(); }
    const url = session.assets.get(asset);
    if (!url || !validatedApneLiveAsset(url)) return res.status(404).end();
    let upstreamResponse;
    try { upstreamResponse = await upstream(url, session.referer, req.get("range")); }
    catch (e) { return res.status(e.status || 502).end(); }
    if (asset.endsWith(".m3u8")) {
      try {
        const text = await manifestText(upstreamResponse);
        const rewritten = rewriteApneLivePlaylist(text, url, session);
        return res.type("application/vnd.apple.mpegurl").send(rewritten);
      } catch (e) { return res.status(502).end(); }
    }
    const headers = ["content-length", "content-range", "accept-ranges"];
    for (const key of headers) {
      const value = upstreamResponse.headers.get(key);
      if (value) res.set(key, value);
    }
    res.set("Content-Type", upstreamResponse.headers.get("content-type") || (asset.endsWith(".ts") ? "video/mp2t" : "application/octet-stream"));
    res.status(upstreamResponse.status);
    if (!upstreamResponse.body) return res.end();
    const reader = Readable.fromWeb(upstreamResponse.body);
    res.on("close", () => { if (!res.writableEnded) reader.destroy(); });
    reader.on("error", () => { if (!res.headersSent) res.status(502); res.end(); });
    reader.pipe(res);
  }
  return { start, media, active: () => sessions.size };
}

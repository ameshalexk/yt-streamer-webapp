// Central configuration. Override anything via environment variables (.env not required).
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function int(name, fallback) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  // Network
  host: process.env.HOST || "127.0.0.1", // bind localhost; Cloudflare Tunnel connects here
  port: int("PORT", 8099),

  // Paths
  root: ROOT,
  dataDir: process.env.DATA_DIR || path.join(ROOT, "data"),
  libraryDir: process.env.LIBRARY_DIR || path.join(ROOT, "data", "library"),
  publicDir: path.join(ROOT, "public"),

  // External binaries (override if not on PATH)
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ytdlpPath: process.env.YTDLP_PATH || "yt-dlp",

  // MJPEG defaults (tuned for Tesla 4G; dialable from the UI per-stream)
  mjpeg: {
    // ffmpeg -q:v, 2 (best) .. 31 (worst). 7 is a sane 4G default.
    quality: int("MJPEG_QUALITY", 7),
    fps: int("MJPEG_FPS", 12),
    // target height; 0 = source height. 480 is a good 4G default.
    height: int("MJPEG_HEIGHT", 480),
    minFps: 3,
    maxFps: int("MAX_FPS", 30),
    minQuality: 2,
    maxQuality: 31,
    allowedHeights: [240, 360, 480, 720, 1080, 0],
  },

  // Download defaults
  download: {
    maxHeight: int("DL_MAX_HEIGHT", 720),
  },

  // Optional YouTube OAuth for the isolated Recommended tab.
  youtubeOAuth: {
    clientId: process.env.YOUTUBE_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET || "",
    redirectUri: process.env.YOUTUBE_OAUTH_REDIRECT_URI || "",
    tokenFile: process.env.YOUTUBE_OAUTH_TOKEN_FILE || path.join(ROOT, "data", "youtube-oauth.json"),
    maxChannels: int("YOUTUBE_RECOMMEND_MAX_CHANNELS", 24),
    perChannel: int("YOUTUBE_RECOMMEND_PER_CHANNEL", 3),
    maxVideos: int("YOUTUBE_RECOMMEND_MAX_VIDEOS", 60),
  },

  // Live player: single synced H.264+AAC MPEG-TS stream (via mpegts.js / MSE).
  video: {
    // "libx264" (portable, CPU) or "h264_videotoolbox" (Mac hardware, far lighter CPU).
    encoder: process.env.VIDEO_ENCODER || "libx264",
    audioBitrateK: int("AUDIO_BITRATE_K", 128),
  },

  // On-demand Mac desktop capture. AVFoundation input "0:none" is usually
  // "Capture screen 0" with no audio on macOS.
  desktop: {
    enabled: process.env.DESKTOP_STREAM_ENABLED !== "0",
    input: process.env.DESKTOP_CAPTURE_INPUT || "0:none",
    audioInput: process.env.DESKTOP_AUDIO_INPUT || "",
    captureCursor: process.env.DESKTOP_CAPTURE_CURSOR !== "0",
    captureClicks: process.env.DESKTOP_CAPTURE_CLICKS !== "0",
  },

  // Safety: cap concurrent ffmpeg streams so a Mac doesn't melt
  maxConcurrentStreams: int("MAX_STREAMS", 3),

  // Built-in IPTV catalog (iptv-org). Fetched + parsed + cached on demand.
  catalog: {
    cacheTtlMs: int("CATALOG_TTL_MS", 6 * 60 * 60 * 1000), // 6h
    countriesUrl: process.env.CATALOG_COUNTRIES_URL || "https://iptv-org.github.io/api/countries.json",
    countryPlaylistBaseUrl: process.env.CATALOG_COUNTRY_PLAYLIST_BASE_URL || "https://iptv-org.github.io/iptv/countries",
    sources: [
      { id: "all", name: "All channels (huge)", group: "Catalog", url: "https://iptv-org.github.io/iptv/index.m3u" },
      { id: "news", name: "News", group: "Categories", url: "https://iptv-org.github.io/iptv/categories/news.m3u" },
      { id: "movies", name: "Movies", group: "Categories", url: "https://iptv-org.github.io/iptv/categories/movies.m3u" },
      { id: "sports", name: "Sports", group: "Categories", url: "https://iptv-org.github.io/iptv/categories/sports.m3u" },
      { id: "entertainment", name: "Entertainment", group: "Categories", url: "https://iptv-org.github.io/iptv/categories/entertainment.m3u" },
      { id: "music", name: "Music", group: "Categories", url: "https://iptv-org.github.io/iptv/categories/music.m3u" },
      { id: "kids", name: "Kids", group: "Categories", url: "https://iptv-org.github.io/iptv/categories/kids.m3u" },
    ],
  },
};

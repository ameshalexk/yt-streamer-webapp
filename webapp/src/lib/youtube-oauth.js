import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API_BASE = "https://www.googleapis.com/youtube/v3";
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];

const pendingStates = new Map();

function isConfigured() {
  return Boolean(config.youtubeOAuth.clientId && config.youtubeOAuth.clientSecret);
}

function requestBaseUrl(req) {
  if (config.youtubeOAuth.redirectUri) {
    const u = new URL(config.youtubeOAuth.redirectUri);
    return `${u.protocol}//${u.host}`;
  }
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function redirectUri(req) {
  return config.youtubeOAuth.redirectUri || `${requestBaseUrl(req)}/api/youtube-auth/callback`;
}

async function readTokens() {
  try {
    return JSON.parse(await fs.readFile(config.youtubeOAuth.tokenFile, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeTokens(tokens) {
  await fs.mkdir(path.dirname(config.youtubeOAuth.tokenFile), { recursive: true });
  const tmp = `${config.youtubeOAuth.tokenFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), "utf8");
  await fs.rename(tmp, config.youtubeOAuth.tokenFile);
}

async function deleteTokens() {
  try {
    await fs.unlink(config.youtubeOAuth.tokenFile);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Google token request failed (${res.status})`);
  return data;
}

async function apiGet(endpoint, params, accessToken) {
  const u = new URL(`${API_BASE}/${endpoint}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") u.searchParams.set(key, value);
  });
  const res = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message || data.error_description || `YouTube API request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

async function getAccessToken() {
  const tokens = await readTokens();
  if (!tokens?.refresh_token && !tokens?.access_token) return null;
  const expiresAt = Number(tokens.expires_at || 0);
  if (tokens.access_token && expiresAt > Date.now() + 60000) return tokens.access_token;
  if (!tokens.refresh_token) return tokens.access_token || null;

  const refreshed = await tokenRequest({
    client_id: config.youtubeOAuth.clientId,
    client_secret: config.youtubeOAuth.clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
  });
  const next = {
    ...tokens,
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((refreshed.expires_in || 3600) * 1000),
    updated_at: Date.now(),
  };
  await writeTokens(next);
  return next.access_token;
}

function parseDuration(value) {
  const m = String(value || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const days = parseInt(m[1] || "0", 10);
  const hours = parseInt(m[2] || "0", 10);
  const minutes = parseInt(m[3] || "0", 10);
  const seconds = parseInt(m[4] || "0", 10);
  return (((days * 24 + hours) * 60 + minutes) * 60) + seconds;
}

function videoUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

function bestThumbnail(thumbnails = {}) {
  return thumbnails.maxres?.url || thumbnails.standard?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || null;
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      results.push(await fn(current));
    }
  });
  await Promise.all(workers);
  return results;
}

export async function status(req) {
  const tokens = await readTokens();
  return {
    configured: isConfigured(),
    connected: Boolean(tokens?.refresh_token || tokens?.access_token),
    scopes: tokens?.scope ? String(tokens.scope).split(/\s+/).filter(Boolean) : [],
    updatedAt: tokens?.updated_at || tokens?.created_at || null,
    redirectUri: redirectUri(req),
  };
}

export function authUrl(req) {
  if (!isConfigured()) throw new Error("Set YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET first");
  const state = crypto.randomBytes(18).toString("base64url");
  pendingStates.set(state, { createdAt: Date.now() });
  for (const [key, value] of pendingStates) {
    if (Date.now() - value.createdAt > 10 * 60 * 1000) pendingStates.delete(key);
  }
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", config.youtubeOAuth.clientId);
  u.searchParams.set("redirect_uri", redirectUri(req));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function finishAuth(req) {
  const { code, state, error } = req.query || {};
  if (error) throw new Error(String(error));
  if (!code || !state || !pendingStates.has(state)) throw new Error("OAuth state did not match. Start the YouTube connection again.");
  pendingStates.delete(state);
  const tokens = await tokenRequest({
    code,
    client_id: config.youtubeOAuth.clientId,
    client_secret: config.youtubeOAuth.clientSecret,
    redirect_uri: redirectUri(req),
    grant_type: "authorization_code",
  });
  const existing = await readTokens();
  const next = {
    ...existing,
    ...tokens,
    refresh_token: tokens.refresh_token || existing?.refresh_token,
    expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000),
    created_at: existing?.created_at || Date.now(),
    updated_at: Date.now(),
  };
  if (!next.refresh_token) throw new Error("Google did not return a refresh token. Use Connect YouTube again and approve offline access.");
  await writeTokens(next);
}

export async function logout() {
  const tokens = await readTokens();
  const token = tokens?.refresh_token || tokens?.access_token;
  if (token) {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    }).catch(() => {});
  }
  await deleteTokens();
}

export async function recommendations() {
  if (!isConfigured()) throw new Error("YouTube OAuth is not configured");
  const accessToken = await getAccessToken();
  if (!accessToken) {
    const err = new Error("YouTube is not connected");
    err.status = 401;
    throw err;
  }

  const subData = await apiGet("subscriptions", {
    part: "snippet,contentDetails",
    mine: "true",
    order: "unread",
    maxResults: 50,
  }, accessToken);
  const subscriptions = (subData.items || [])
    .filter((item) => item.snippet?.resourceId?.channelId)
    .slice(0, config.youtubeOAuth.maxChannels);
  const channelIds = subscriptions.map((item) => item.snippet.resourceId.channelId);
  if (!channelIds.length) return { generatedAt: Date.now(), source: "subscriptions", items: [] };

  const channelData = await apiGet("channels", {
    part: "snippet,contentDetails",
    id: channelIds.join(","),
    maxResults: 50,
  }, accessToken);
  const channels = new Map((channelData.items || []).map((channel) => [channel.id, channel]));
  const uploadPlaylists = subscriptions
    .map((sub, subscriptionIndex) => {
      const channel = channels.get(sub.snippet.resourceId.channelId);
      return {
        subscriptionIndex,
        channelId: sub.snippet.resourceId.channelId,
        channelTitle: sub.snippet.title,
        uploadsId: channel?.contentDetails?.relatedPlaylists?.uploads,
      };
    })
    .filter((item) => item.uploadsId);

  const playlistPages = await mapLimit(uploadPlaylists, 4, async (channel) => {
    try {
      const page = await apiGet("playlistItems", {
        part: "snippet,contentDetails",
        playlistId: channel.uploadsId,
        maxResults: config.youtubeOAuth.perChannel,
      }, accessToken);
      return (page.items || []).map((item, itemIndex) => ({
        subscriptionIndex: channel.subscriptionIndex,
        itemIndex,
        channelId: channel.channelId,
        channelTitle: channel.channelTitle,
        videoId: item.contentDetails?.videoId || item.snippet?.resourceId?.videoId,
        title: item.snippet?.title,
        publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt,
        thumbnail: bestThumbnail(item.snippet?.thumbnails),
      }));
    } catch (err) {
      console.warn("[youtube-oauth] skipped uploads playlist:", channel.channelTitle, err.message);
      return [];
    }
  });
  const candidates = playlistPages.flat().filter((item) => item.videoId && item.title && item.title !== "Deleted video" && item.title !== "Private video");
  const ids = [...new Set(candidates.map((item) => item.videoId))].slice(0, 50);
  if (!ids.length) return { generatedAt: Date.now(), source: "subscriptions", items: [] };

  const videoData = await apiGet("videos", {
    part: "snippet,contentDetails,statistics,liveStreamingDetails,status",
    id: ids.join(","),
    maxResults: 50,
  }, accessToken);
  const details = new Map((videoData.items || []).map((item) => [item.id, item]));
  const now = Date.now();
  const items = candidates
    .map((candidate) => {
      const detail = details.get(candidate.videoId);
      if (!detail || detail.status?.privacyStatus !== "public") return null;
      const publishedAt = detail.snippet?.publishedAt || candidate.publishedAt;
      const publishedMs = Date.parse(publishedAt || "") || 0;
      const ageHours = publishedMs ? Math.max(1, (now - publishedMs) / 36e5) : 9999;
      const views = parseInt(detail.statistics?.viewCount || "0", 10) || 0;
      const live = detail.snippet?.liveBroadcastContent === "live" || Boolean(detail.liveStreamingDetails?.actualStartTime && !detail.liveStreamingDetails?.actualEndTime);
      const upcoming = detail.snippet?.liveBroadcastContent === "upcoming";
      return {
        id: candidate.videoId,
        title: detail.snippet?.title || candidate.title,
        channelTitle: detail.snippet?.channelTitle || candidate.channelTitle,
        channelId: candidate.channelId,
        publishedAt,
        duration: parseDuration(detail.contentDetails?.duration),
        thumbnail: bestThumbnail(detail.snippet?.thumbnails) || candidate.thumbnail,
        url: videoUrl(candidate.videoId),
        viewCount: views,
        isLive: live,
        isUpcoming: upcoming,
        score: (candidate.subscriptionIndex * -200) + (candidate.itemIndex * -20) + (live ? 1000 : 0) + (Math.log10(views + 10) * 12) - ageHours,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.youtubeOAuth.maxVideos)
    .map(({ score, ...item }) => item);

  return {
    generatedAt: Date.now(),
    source: "subscriptions",
    items,
  };
}

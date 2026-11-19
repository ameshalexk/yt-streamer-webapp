import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { verifyAccessJwt } from "./ai-media-agent-remote-authorization.js";
import { createPinnedCloudflareJwksProvider } from "../../scripts/ai-agent-remote-mcp.mjs";
import { createChiakiRelay, isConsoleIpv4, chiakiRelayProtocol } from "./tesla-remote-play-relay.mjs";

const PLAYER = "/tesla-remote-play";
const API = "/api/tesla-remote-play";
export const TESLA_REMOTE_PLAY_SOCKET = `${PLAYER}/posix-net`;
const ACCESS_ORIGIN = "https://stream.ameshalex.com";
const UPSTREAM = "vendor/chiaki-ng-web";
const KEY = /^[a-f0-9]{32}$/;
const RESPONSE_BUFFER_LIMIT = 8 * 1024 * 1024;
const NO_CACHE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const REJECT = { 401: "Unauthorized", 403: "Forbidden", 409: "Conflict", 503: "Service Unavailable" };

function registration(value) {
  if (!value || Object.keys(value).length !== 2 || typeof value.registKey !== "string" ||
      typeof value.morning !== "string" || !KEY.test(value.registKey) || !KEY.test(value.morning)) return null;
  return { registKey: value.registKey, morning: value.morning };
}

function privateFiles(dir) {
  async function checkDirectory() {
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid()) {
      throw new Error("Remote Play state directory must be private");
    }
  }

  async function read(name) {
    const file = path.join(dir, name);
    try {
      await checkDirectory();
      const info = await fs.lstat(file);
      if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid() || info.size > 1024) {
        throw new Error("Remote Play state file must be private");
      }
      return await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  return {
    async disabled() { return Boolean(await read("disabled")); },
    async consoleIp() {
      const host = (await read("console-ip"))?.trim();
      return isConsoleIpv4(host) ? host : null;
    },
    async registration(host, subject) {
      const saved = await read("registration.json");
      if (!saved) return null;
      const value = JSON.parse(saved);
      return value.host === host && value.subject === subject ? registration(value.keys) : null;
    },
    async save(host, subject, keys) {
      await checkDirectory();
      const temporary = path.join(dir, `.registration-${randomUUID()}`);
      try {
        await fs.writeFile(temporary, JSON.stringify({ host, subject, keys }), { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, path.join(dir, "registration.json"));
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
  };
}

function assertion(headers) {
  // An invalid edge assertion must never fall back to a browser cookie.
  const value = headers["cf-access-jwt-assertion"];
  if (value !== undefined) return typeof value === "string" ? value : null;
  const cookies = headers.cookie?.split(";").map(cookie => cookie.trim()) ?? [];
  const entries = cookies.filter(cookie => cookie.startsWith("CF_Authorization="));
  return entries.length === 1 ? entries[0].slice("CF_Authorization=".length) : null;
}

function ownerAuthentication({ provider, audience, ownerEmail, now }) {
  let pendingKeys;
  let lastRefresh = -Infinity;
  return async (headers) => {
    const token = assertion(headers);
    if (typeof token !== "string" || token.length > 16000 || token.split(".").length !== 3) return { status: 401 };
    try {
      pendingKeys ??= Promise.resolve().then(() => provider.get()).finally(() => { pendingKeys = null; });
      let keys = await pendingKeys;
      const verify = () => verifyAccessJwt(token, {
        jwks: keys, audience, issuer: provider.issuer, maxTokenLifetimeSeconds: null,
        nowSeconds: Math.floor(now() / 1000),
      });
      let identity;
      try {
        identity = verify();
      } catch (error) {
        const kid = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"))?.kid;
        if (!/^[\w.-]{1,180}$/.test(kid ?? "") || keys.keys.some(key => key.kid === kid) ||
            !provider.refresh || now() - lastRefresh < 30_000) throw error;
        lastRefresh = now();
        keys = await provider.refresh();
        identity = verify();
      }
      const { email, exp } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      if (typeof email !== "string" || email.toLowerCase() !== ownerEmail) return { status: 403 };
      if (!Number.isSafeInteger(exp * 1000)) return { status: 401 };
      return { status: 200, subject: identity.subject, expiresAt: exp * 1000 };
    } catch {
      return { status: 401 };
    }
  };
}

export function mountTeslaRemotePlay(app, {
  root, dataDir, revision, enabled = process.platform === "darwin" && process.env.TESLA_REMOTE_PLAY_ENABLED !== "0",
  audience = process.env.YT_AI_AGENT_ACCESS_AUDIENCE,
  ownerEmail = process.env.TESLA_REMOTE_PLAY_OWNER_EMAIL || "ameshalex@gmail.com",
  origin = ACCESS_ORIGIN, provider, now = Date.now, relayFactory = createChiakiRelay,
  pingIntervalMs = 10_000,
} = {}) {
  const available = Boolean(enabled && audience && ownerEmail);
  const authorize = available ? ownerAuthentication({
    provider: provider ?? createPinnedCloudflareJwksProvider({
      teamDomain: process.env.YT_AI_AGENT_ACCESS_TEAM_DOMAIN || "ameshalex.cloudflareaccess.com",
    }), audience, ownerEmail: ownerEmail.toLowerCase(), now,
  }) : async () => ({ status: 404 });
  const state = privateFiles(path.join(dataDir, "tesla-remote-play"));
  const playerRoot = path.join(root, "tesla-remote-play");
  const api = express.Router();
  const player = express.Router();
  const sameOrigin = (req) => req.headers.origin === origin &&
    (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin");
  const protect = (req, res, next) => {
    res.set(NO_CACHE);
    void authorize(req.headers).then(async identity => {
      if (identity.status !== 200) return res.status(identity.status).end();
      if (await state.disabled()) return res.status(404).end();
      req.remotePlayOwner = identity;
      next();
    }).catch(() => res.status(503).end());
  };
  const safe = action => (req, res) => {
    void action(req, res).catch(() => res.status(503).end());
  };

  api.use(protect);
  api.get("/status", safe(async (_req, res) => {
    res.json({ available: true, configured: Boolean(await state.consoleIp()) });
  }));
  api.get("/console", safe(async (req, res) => {
    const host = await state.consoleIp();
    const keys = host ? await state.registration(host, req.remotePlayOwner.subject) : null;
    res.json({ host, registration: keys });
  }));
  api.put("/console", (req, res, next) => sameOrigin(req) ? next() : res.status(403).end(),
    express.json({ limit: "512b" }), safe(async (req, res) => {
      const keys = registration(req.body);
      if (!keys) return res.status(400).end();
      const host = await state.consoleIp();
      if (!host) return res.status(409).end();
      await state.save(host, req.remotePlayOwner.subject, keys);
      res.status(204).end();
    }));
  api.use((_error, _req, res, _next) => res.status(400).end());
  api.use((_req, res) => res.status(404).end());
  app.use(API, api);

  const relayOrigin = origin.replace(/^http/, "ws");
  player.use(protect, (_req, res, next) => {
    res.set({
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": [
        "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval' blob:",
        "worker-src 'self' blob:", `connect-src 'self' ${relayOrigin}`,
        "media-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
        "form-action 'self'", "frame-ancestors 'none'",
      ].join("; "),
    });
    next();
  });
  const asset = (name, type) => (_req, res) => {
    res.type(type).sendFile(path.join(playerRoot, name), error => {
      if (error && !res.headersSent) res.status(error.statusCode === 404 ? 404 : 503).end();
    });
  };
  player.get("/", (req, res) => {
    if (req.originalUrl.split("?")[0] === PLAYER) return res.redirect(`${PLAYER}/`);
    return asset("index.html", "html")(req, res);
  });
  player.get("/player.js", asset("player.js", "text/javascript"));
  player.get("/player.css", asset("player.css", "text/css"));
  player.get("/audio-worklet.js", asset("audio-worklet.js", "text/javascript"));
  player.get("/chiaki.js", asset(`${UPSTREAM}/chiaki.js`, "text/javascript"));
  player.get("/chiaki.wasm", asset(`${UPSTREAM}/chiaki.wasm`, "application/wasm"));
  player.get("/source", (_req, res) => {
    const sourceRef = /^[a-f0-9]{40}$/.test(revision ?? "") ? revision : "main";
    res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tesla Remote Play source</title><h1>Tesla Remote Play source</h1><p>Chiaki-NG and Chiaki-NG Web Edition contributors. The software is provided without a warranty. You may redistribute Chiaki under the linked license.</p><ul><li><a href="chiaki-source.tar.gz">Chiaki corresponding source and build instructions</a></li><li><a href="chiaki-license.txt">GNU Affero General Public License v3</a></li><li><a href="chiaki-manifest.json">Artifact and source checksums</a></li><li><a href="chiaki-notice.txt">Dependency notices</a></li><li><a href="https://github.com/ameshalexk/yt-streamer-webapp/tree/${sourceRef}/webapp">Streamer integration source and build scripts</a></li></ul><a href="./">Return to Tesla Remote Play</a>`);
  });
  player.get("/chiaki-source.tar.gz", asset(`${UPSTREAM}/chiaki-ng-web-source.tar.gz`, "application/gzip"));
  player.get("/chiaki-license.txt", asset(`${UPSTREAM}/licenses/AGPL-3.0-only.txt`, "text/plain"));
  player.get("/chiaki-manifest.json", asset(`${UPSTREAM}/SOURCE-MANIFEST.json`, "application/json"));
  player.get("/chiaki-notice.txt", asset(`${UPSTREAM}/NOTICE.txt`, "text/plain"));
  player.use((_req, res) => res.status(404).end());
  app.use(PLAYER, player);

  let controller = null;
  const wss = new WebSocketServer({ noServer: true, maxPayload: chiakiRelayProtocol.MAX_MESSAGE_BYTES, perMessageDeflate: false });

  function open(req, socket, head, host, expiresAt) {
    wss.handleUpgrade(req, socket, head, ws => {
      let alive = true;
      const relay = relayFactory({ consoleIp: host, send: (packet) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (now() >= expiresAt || ws.bufferedAmount > RESPONSE_BUFFER_LIMIT) return ws.terminate();
        ws.send(packet, { binary: true }, error => { if (error) ws.terminate(); });
      } });
      controller = ws;
      const heartbeat = setInterval(() => {
        if (!alive || now() >= expiresAt) return ws.terminate();
        alive = false;
        ws.ping();
        void Promise.all([state.consoleIp(), state.disabled()]).then(([current, disabled]) => {
          if (disabled || current !== host) ws.terminate();
        }).catch(() => ws.terminate());
      }, pingIntervalMs);
      heartbeat.unref();
      ws.on("pong", () => { alive = true; });
      ws.on("close", () => {
        clearInterval(heartbeat);
        relay.closeAll();
        if (controller === ws) controller = null;
      });
      ws.on("error", () => ws.terminate());
      ws.on("message", (packet, binary) => {
        if (!binary || now() >= expiresAt) return ws.terminate();
        void Promise.resolve(relay.handle(packet)).catch(() => ws.terminate());
      });
    });
  }

  function upgrade(req, socket, head) {
    if (req.url !== TESLA_REMOTE_PLAY_SOCKET) return;
    const reject = code => socket.end(`HTTP/1.1 ${code} ${REJECT[code]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    const onError = () => socket.destroy();
    socket.on("error", onError);
    const handshakeTimeout = setTimeout(() => socket.destroy(), 6000);
    void (async () => {
      if (!available) return reject(503);
      if (!sameOrigin(req) || req.headers["sec-websocket-protocol"] !== "binary") return reject(403);
      const identity = await authorize(req.headers);
      if (socket.destroyed) return;
      if (identity.status !== 200) return reject(identity.status);
      const [host, disabled] = await Promise.all([state.consoleIp(), state.disabled()]);
      if (socket.destroyed) return;
      if (disabled || !host) return reject(503);
      if (controller) return reject(409);
      if (now() >= identity.expiresAt) return reject(401);
      open(req, socket, head, host, identity.expiresAt);
    })().catch(() => socket.destroy()).finally(() => clearTimeout(handshakeTimeout));
  }

  return {
    attach(server) { server.on("upgrade", upgrade); },
    get active() { return controller !== null; },
    close(server) {
      server.off("upgrade", upgrade);
      controller?.terminate();
      wss.close();
    },
  };
}

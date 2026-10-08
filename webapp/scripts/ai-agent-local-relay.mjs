// PRIVATE LOOPBACK-ONLY TEST HARNESS for #28. Not imported by production server.
// This is not the final Cloudflare Access / remote MCP auth implementation.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { AgentSessionRegistry } from "../src/lib/ai-media-agent-session-registry.js";
import { handleDevMcp } from "./ai-agent-dev-mcp.mjs";

function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let input = "";
  for await (const chunk of req) {
    input += chunk;
    if (input.length > 8192) throw new Error("body_too_large");
  }
  try { return JSON.parse(input); } catch { throw new Error("invalid_json"); }
}

export async function startLocalAgentRelay({ ownerToken, pairingToken, port = 0, host = "127.0.0.1",
  timeoutMs = 1500, ttlMs = 7000, browserOrigin = null } = {}) {
  if (host !== "127.0.0.1" || typeof ownerToken !== "string" || ownerToken.length < 32
      || typeof pairingToken !== "string" || pairingToken.length < 32 || equalSecret(ownerToken, pairingToken)) {
    throw new Error("loopback_and_distinct_long_tokens_required");
  }
  if (browserOrigin !== null && !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(browserOrigin)) {
    throw new Error("browser_origin_must_be_explicit_loopback");
  }
  const clients = new Set();
  const registry = new AgentSessionRegistry({
    timeoutMs, ttlMs, authorizePairing: ({ principal, pairingProof }) =>
      principal === "owner" && equalSecret(pairingProof, pairingToken),
  });
  let origin;
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const server = http.createServer(async (req, res) => {
    const allowedOrigin = browserOrigin || origin;
    if (req.headers.origin === allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS" && req.headers.origin === allowedOrigin) {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "300" });
      res.end(); return;
    }
    if (req.headers.origin && req.headers.origin !== allowedOrigin) return json(res, 403, { error: "wrong_origin" });
    if (!equalSecret(req.headers.authorization, `Bearer ${ownerToken}`)) return json(res, 401, { error: "unauthorized" });
    if (req.url === "/dev/mcp") return handleDevMcp(req, res, registry, readJson);
    if (req.method === "GET" && req.url === "/dev/devices") return json(res, 200, { devices: registry.list("owner") });
    if (req.method !== "POST" || req.url !== "/dev/command") return json(res, 404, { error: "not_found" });
    try {
      const input = await readJson(req);
      if (!input || typeof input !== "object") return json(res, 400, { error: "invalid_command" });
      const outcome = await registry.dispatch({
        principal: "owner", deviceId: input.device_id, action: input.action, args: input.args || {},
      });
      json(res, 200, outcome);
    } catch (error) { json(res, 400, { error: error.code || error.message || "bad_request" }); }
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/dev/player" || req.headers.origin !== (browserOrigin || origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(req, socket, head, (ws) => webSocketServer.emit("connection", ws));
  });
  webSocketServer.on("connection", (ws) => {
    const connectionId = crypto.randomUUID();
    clients.add(ws);
    let deviceId = null;
    const authTimeout = setTimeout(() => ws.close(1008, "pairing_required"), 2000);
    authTimeout.unref?.();
    ws.on("message", (buffer) => {
      let message;
      try { message = JSON.parse(buffer.toString("utf8")); } catch { ws.close(1008, "invalid_json"); return; }
      if (!deviceId) {
        if (message?.kind !== "pair" || typeof message?.label !== "string") { ws.close(1008, "pairing_required"); return; }
        try {
          const data = registry.register({ principal: "owner", pairingProof: message.proof,
            connectionId, label: message.label, send: (command) => {
              if (ws.readyState !== ws.OPEN) return false;
              ws.send(JSON.stringify(command));
              return true;
            } });
          deviceId = data.device_id;
          clearTimeout(authTimeout);
          ws.send(JSON.stringify({ kind: "registered", ...data }));
        } catch { ws.close(1008, "invalid_pairing"); }
        return;
      }
      if (message?.kind === "heartbeat") registry.heartbeat({
        principal: "owner", deviceId, connectionId, state: message.state,
      });
      else if (message?.kind === "ack") registry.acknowledge({
        principal: "owner", deviceId, connectionId, commandId: message.command_id,
        status: message.status, state: message.state, result: message.result, error: message.error,
      });
      else ws.close(1008, "invalid_message");
    });
    ws.on("close", () => {
      clearTimeout(authTimeout);
      clients.delete(ws);
      if (deviceId) registry.disconnect({ deviceId, connectionId });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const sweepTimer = setInterval(() => registry.sweep(), Math.min(1000, ttlMs));
  sweepTimer.unref?.();
  return {
    origin, registry,
    // Local test hook, not an HTTP route and never exposed to a browser.
    disconnectPlayersForTest() { for (const client of clients) client.terminate(); },
    async close() {
      clearInterval(sweepTimer);
      for (const ws of clients) ws.terminate();
      await new Promise((resolve) => webSocketServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

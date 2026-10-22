// Loopback-only Phase 1 test relay. It is intentionally not imported by the app server.
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { AgentSessionRegistry } from "../src/lib/ai-media-agent-session-registry.js";

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, body, allowedOrigin = null) => {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (allowedOrigin) { headers["access-control-allow-origin"] = allowedOrigin; headers.vary = "Origin"; }
  res.writeHead(status, headers); res.end(JSON.stringify(body));
};
async function body(req) { let value = ""; for await (const chunk of req) { value += chunk; if (value.length > 8192) throw Error("body_too_large"); } try { return JSON.parse(value); } catch { throw Error("invalid_json"); } }

export async function startLocalAgentRelay({ ownerToken, pairingToken, port = 0, host = "127.0.0.1", browserOrigin, timeoutMs = 95000, ttlMs = 30000 } = {}) {
  let webOrigin;
  try { webOrigin = new URL(browserOrigin); } catch { throw Error("explicit_loopback_browser_origin_required"); }
  if (host !== "127.0.0.1" || typeof ownerToken !== "string" || ownerToken.length < 32 || typeof pairingToken !== "string" || pairingToken.length < 32 || same(ownerToken, pairingToken) || webOrigin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(webOrigin.hostname) || !webOrigin.port || webOrigin.pathname !== "/" || webOrigin.search || webOrigin.hash || webOrigin.username || webOrigin.password) throw Error("loopback_origin_and_distinct_long_tokens_required");
  const registry = new AgentSessionRegistry({ timeoutMs, ttlMs, authorizePairing: ({ principal, pairingProof }) => principal === "owner" && same(pairingProof, pairingToken) });
  const clients = new Set(); let origin = "";
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const server = http.createServer(async (req, res) => {
    const allowed = webOrigin.origin;
    if (req.headers.origin !== allowed) return json(res, 403, { error: "wrong_origin" });
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": allowed, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type" }); return res.end(); }
    if (!same(req.headers.authorization, `Bearer ${ownerToken}`)) return json(res, 401, { error: "unauthorized" }, allowed);
    if (req.method === "GET" && req.url === "/dev/devices") return json(res, 200, { devices: registry.list("owner") }, allowed);
    if (req.method !== "POST" || req.url !== "/dev/command") return json(res, 404, { error: "not_found" }, allowed);
    try { const input = await body(req); const result = await registry.dispatch({ principal: "owner", deviceId: input.device_id, action: input.action, args: input.args || {}, commandId: input.command_id }); return json(res, 200, result, allowed); }
    catch (error) { return json(res, 400, { error: error.code || error.message || "bad_request" }, allowed); }
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/dev/player" || req.headers.origin !== webOrigin.origin) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    const connectionId = crypto.randomUUID(); clients.add(ws); let deviceId = null;
    const timeout = setTimeout(() => ws.close(1008, "pairing_required"), 2000); timeout.unref?.();
    ws.on("message", (raw) => {
      let message; try { message = JSON.parse(raw.toString()); } catch { ws.close(1008, "invalid_json"); return; }
      if (!deviceId) {
        if (message?.kind !== "pair") return ws.close(1008, "pairing_required");
        try { const registered = registry.register({ principal: "owner", pairingProof: message.proof, label: message.label, connectionId, send: (frame) => { if (ws.readyState !== ws.OPEN) return false; ws.send(JSON.stringify(frame)); return true; } }); deviceId = registered.device_id; clearTimeout(timeout); ws.send(JSON.stringify({ kind: "registered", ...registered })); }
        catch { ws.close(1008, "invalid_pairing"); }
        return;
      }
      if (message?.kind === "heartbeat") registry.heartbeat({ principal: "owner", deviceId, connectionId, state: message.state });
      else if (message?.kind === "ack") registry.acknowledge({ principal: "owner", deviceId, connectionId, commandId: message.command_id, status: message.status, state: message.state, result: message.result, error: message.error });
      else ws.close(1008, "invalid_message");
    });
    ws.on("close", () => { clearTimeout(timeout); clients.delete(ws); if (deviceId) registry.disconnect({ deviceId, connectionId }); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const sweep = setInterval(() => registry.sweep(), Math.min(1000, ttlMs)); sweep.unref?.();
  return { origin, registry, async close() { clearInterval(sweep); for (const ws of clients) ws.terminate(); await new Promise((resolve) => wss.close(resolve)); await new Promise((resolve) => server.close(resolve)); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerToken = process.env.AI_AGENT_OWNER_TOKEN;
  const pairingToken = process.env.AI_AGENT_PAIRING_TOKEN;
  const browserOrigin = process.env.AI_AGENT_ORIGIN;
  if (!ownerToken || !pairingToken || !browserOrigin || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/.test(browserOrigin)) {
    console.error("Set AI_AGENT_OWNER_TOKEN, AI_AGENT_PAIRING_TOKEN, and AI_AGENT_ORIGIN=http://127.0.0.1:<port> or http://localhost:<port>.");
    process.exitCode = 2;
  } else {
    const relay = await startLocalAgentRelay({ ownerToken, pairingToken, browserOrigin, port: Number(process.env.AI_AGENT_RELAY_PORT || 0) });
    console.log(`AI media relay listening on ${relay.origin}`);
    process.once("SIGINT", () => relay.close().finally(() => process.exit(0)));
    process.once("SIGTERM", () => relay.close().finally(() => process.exit(0)));
  }
}

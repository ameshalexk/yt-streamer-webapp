import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEBAPP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(WEBAPP_DIR, "src", "server.js");
const TEST_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startServer(port, dirs) {
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dirs.data,
    LIBRARY_DIR: dirs.library,
    APNE_ICLOUD_DIR: dirs.apneIcloud,
    TESLA_PASSIVE_CONFIG: path.join(dirs.home, "tesla-passive"),
    REAL_CHROME_PROFILE_DIR: path.join(dirs.data, "real-chrome-profile"),
    YOUTUBE_OAUTH_TOKEN_FILE: path.join(dirs.data, "youtube-oauth.json"),
    CATALOG_COUNTRIES_URL: "http://127.0.0.1:1/disabled",
    CATALOG_COUNTRY_PLAYLIST_BASE_URL: "http://127.0.0.1:1/disabled",
  };
  // Prevent inherited launchd supervision from enabling any service-control path.
  delete env.XPC_SERVICE_NAME;
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: WEBAPP_DIR,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
  return { child, getStderr: () => stderr };
}

async function waitForServer(server, baseUrl) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`server exited before becoming ready (${server.child.exitCode}): ${server.getStderr()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/watch-history`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become ready within ${START_TIMEOUT_MS}ms: ${server.getStderr()}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}

async function request(baseUrl, route, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.json() };
}

test("watch progress HTTP API validates sessions and persists across server restart", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-watch-progress-api-"));
  const dirs = {
    data: path.join(root, "data"),
    library: path.join(root, "library"),
    apneIcloud: path.join(root, "apne-icloud"),
    home: path.join(root, "home"),
  };
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));
  const port = await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let currentServer = startServer(port, dirs);
  t.after(async () => {
    await stopServer(currentServer.child);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForServer(currentServer, baseUrl);

  const created = await request(baseUrl, "/api/watch-history", {
    method: "POST",
    body: { youtubeId: "http-progress-video", title: "HTTP progress integration", duration: 240, playbackSessionId: "session-http-1" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.playCount, 1);
  const id = created.body.id;

  const progress = { playbackSessionId: "session-http-1", sequence: 0, positionSeconds: 73 };
  const updated = await request(baseUrl, `/api/watch-history/${encodeURIComponent(id)}/progress`, { method: "PATCH", body: progress });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.positionSeconds, 73);
  assert.equal(updated.body.progressSequence, 0);
  assert.equal(updated.body.playCount, 1);

  const listed = await request(baseUrl, "/api/watch-history");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.find((entry) => entry.id === id)?.positionSeconds, 73);

  for (const stale of [
    { playbackSessionId: "old-session", sequence: 1, positionSeconds: 80 },
    { playbackSessionId: "session-http-1", sequence: 0, positionSeconds: 80 },
  ]) {
    assert.equal((await request(baseUrl, `/api/watch-history/${id}/progress`, { method: "PATCH", body: stale })).status, 409);
  }
  for (const invalid of [
    { playbackSessionId: "session-http-1", sequence: 1, positionSeconds: -1 },
    { playbackSessionId: "", sequence: 1, positionSeconds: 80 },
  ]) {
    assert.equal((await request(baseUrl, `/api/watch-history/${id}/progress`, { method: "PATCH", body: invalid })).status, 400);
  }
  assert.equal((await request(baseUrl, "/api/watch-history/missing-progress-entry/progress", {
    method: "PATCH", body: { playbackSessionId: "session-http-1", sequence: 1, positionSeconds: 80 },
  })).status, 404);

  await stopServer(currentServer.child);
  currentServer = startServer(port, dirs);
  await waitForServer(currentServer, baseUrl);
  const afterRestart = await request(baseUrl, "/api/watch-history");
  assert.equal(afterRestart.status, 200);
  const persisted = afterRestart.body.find((entry) => entry.id === id);
  assert.ok(persisted, "history entry should survive a server restart");
  assert.equal(persisted.positionSeconds, 73);
  assert.equal(persisted.progressSequence, 0);
  assert.equal(persisted.playbackSessionId, "session-http-1");
  assert.equal(persisted.playCount, 1);
});

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

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function launch(port, dirs) {
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dirs.data,
    LIBRARY_DIR: dirs.library,
    APNE_ICLOUD_DIR: dirs.apne,
    YOUTUBE_OAUTH_TOKEN_FILE: path.join(dirs.data, "oauth.json"),
    CATALOG_COUNTRIES_URL: "http://127.0.0.1:1/disabled",
    CATALOG_COUNTRY_PLAYLIST_BASE_URL: "http://127.0.0.1:1/disabled",
  };
  delete env.XPC_SERVICE_NAME;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: WEBAPP_DIR, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  return { child, get stderr() { return stderr; } };
}

async function stop(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.kill("SIGTERM");
  if (!await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))])) {
    server.child.kill("SIGKILL");
    await exited;
  }
}

async function ready(server, url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`server exited: ${server.stderr}`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server startup timed out: ${server.stderr}`);
}

async function request(url, route, method = "GET", body) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

test("platform smoke: health metadata, SPA APIs, and persisted library state survive restart", { timeout: 60_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-platform-smoke-"));
  const dirs = { data: path.join(root, "data"), library: path.join(root, "library"), apne: path.join(root, "apne") };
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let server = launch(port, dirs);
  t.after(async () => { await stop(server); await fs.rm(root, { recursive: true, force: true }); });

  const health = await ready(server, url);
  assert.equal(health.ok, true);
  assert.equal(health.release.platform, process.platform);
  assert.ok(health.release.revision === null || /^[a-f0-9]{40}$/.test(health.release.revision));
  const html = await fetch(`${url}/`).then((response) => response.text());
  assert.match(html, /YT Streamer|<html/i);

  const made = await request(url, "/api/playlists", "POST", { name: "Platform regression" });
  assert.equal(made.status, 201);
  const playlistId = made.body.id;
  assert.equal((await request(url, `/api/playlists/${playlistId}/items`, "POST", {
    title: "Local fixture entry", type: "m3u8", url: "http://127.0.0.1:1/fixture.m3u8",
  })).status, 201);
  const watched = await request(url, "/api/watch-history", "POST", {
    youtubeId: "platform-smoke-local", title: "Smoke history", duration: 120,
  });
  assert.equal(watched.status, 201);
  const libraryPlaylist = await request(url, "/api/legacy-library/playlists", "POST", {
    url: "http://127.0.0.1:1/local-playlist.m3u", name: "Local library playlist",
  });
  assert.equal(libraryPlaylist.status, 201);

  await stop(server);
  server = launch(port, dirs);
  const afterRestart = await ready(server, url);
  assert.equal(afterRestart.release.platform, process.platform);
  assert.equal(afterRestart.release.revision, health.release.revision);
  const persisted = await request(url, `/api/playlists/${playlistId}`);
  assert.equal(persisted.body.name, "Platform regression");
  assert.equal(persisted.body.items[0].title, "Local fixture entry");
  assert.equal((await request(url, "/api/watch-history")).body[0].youtubeId, "platform-smoke-local");
  const libraryPlaylists = await request(url, "/api/legacy-library/playlists");
  assert.ok(libraryPlaylists.body.some((playlist) => playlist.id === libraryPlaylist.body.id
    && playlist.name === "Local library playlist"));
});

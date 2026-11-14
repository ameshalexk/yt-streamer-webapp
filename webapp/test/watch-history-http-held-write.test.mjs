import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webapp = fileURLToPath(new URL("..", import.meta.url));
const serverPath = path.join(webapp, "src/server.js");

test("HTTP Clear while a history POST is awaiting disk persistence does not restore history", { timeout: 30_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-http-write-barrier-"));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const preload = path.join(root, "hold-write.mjs");
  await fs.writeFile(preload, `
    import fs from "node:fs/promises";
    const write = fs.writeFile;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let held = false;
    fs.writeFile = async (...args) => {
      if (!held && String(args[0]).endsWith("store.json.tmp")) {
        held = true;
        process.send?.({ type: "held" });
        await gate;
      }
      return write(...args);
    };
    process.on("message", message => {
      if (message?.type === "release") release();
    });
  `);
  const child = spawn(process.execPath, ["--import", preload, serverPath], {
    cwd: webapp,
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: path.join(root, "data"), LIBRARY_DIR: path.join(root, "library"),
      APNE_ICLOUD_DIR: path.join(root, "apne"),
      CATALOG_COUNTRIES_URL: "http://127.0.0.1:1/disabled",
      CATALOG_COUNTRY_PLAYLIST_BASE_URL: "http://127.0.0.1:1/disabled",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  t.after(async () => {
    if (child.connected) child.send({ type: "release" });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(base + "/api/watch-history", { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `isolated server did not start: ${stderr}`);
  const held = new Promise((resolve, reject) => {
    child.on("message", message => { if (message?.type === "held") resolve(); });
    child.once("exit", code => reject(new Error(`server exited ${code}: ${stderr}`)));
  });
  const post = fetch(base + "/api/watch-history", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ youtubeId: "http-held-video", playbackSessionId: "first-session" }),
    signal: AbortSignal.timeout(10000),
  });
  await held;
  // Clear must mutate shared state even though the earlier POST has not responded.
  const clearing = fetch(base + "/api/watch-history", {
    method: "DELETE", signal: AbortSignal.timeout(10000),
  });
  // Wait for Clear's synchronous mutation by observing the isolated HTTP GET.
  let empty = false;
  for (let i = 0; i < 30; i++) {
    const response = await fetch(base + "/api/watch-history", { signal: AbortSignal.timeout(1000) });
    if (response.ok && (await response.json()).length === 0) { empty = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(empty, "Clear must be visible before releasing held POST persistence");
  if (child.connected) child.send({ type: "release" });
  assert.equal((await post).status, 201);
  assert.equal((await clearing).status, 200);
  const final = await fetch(base + "/api/watch-history");
  assert.deepEqual(await final.json(), []);
  const disk = JSON.parse(await fs.readFile(path.join(root, "data", "store.json"), "utf8"));
  assert.deepEqual(disk.watchHistory, []);
});

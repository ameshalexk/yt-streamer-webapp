import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { classifyExtractorError, probeExtractorCandidates, sanitizeExtractorMessage } from "../src/lib/extractor-health.js";

test("only recognizable extractor failures qualify for fallback", () => {
  assert.equal(classifyExtractorError("ERROR: [youtube] Unable to extract initial data"), "extraction");
  assert.equal(classifyExtractorError("Requested format is not available"), "extraction");
  assert.equal(classifyExtractorError("HTTP Error 403: Forbidden"), null);
  assert.equal(classifyExtractorError("HTTP Error 429: Too Many Requests"), null);
  assert.equal(classifyExtractorError("yt-dlp timed out"), null);
  assert.equal(classifyExtractorError("No such file or directory"), null);
});

test("diagnostic messages remove URLs and credential values", () => {
  const safe = sanitizeExtractorMessage("failed https://video.example/x?sig=private token=secret");
  assert.doesNotMatch(safe, /video\.example|private|secret/);
  assert.match(safe, /\[URL redacted\]/);
});

test("candidate probe is local, bounded, and reports only executable basename/version", async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "known-good");
  await writeFile(binary, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 2026.10.01; exit 0; fi\nif [ \"$4\" = \"--help\" ]; then echo help; exit 0; fi\nexit 2\n");
  await chmod(binary, 0o755);
  const diagnostics = await probeExtractorCandidates([binary], { selfTest: true });
  assert.deepEqual(diagnostics.candidates, [{ executable: "known-good", available: true, version: "2026.10.01", error: null, compatibility: "passed" }]);
});

test("classified extraction errors retry once with configured fallback", async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-fallback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const primary = path.join(dir, "primary");
  const fallback = path.join(dir, "fallback");
  await writeFile(primary, "#!/bin/sh\necho 'ERROR: [youtube] Unable to extract initial data' >&2\nexit 1\n");
  await writeFile(fallback, "#!/bin/sh\necho '{\"id\":\"abc\",\"title\":\"fallback\"}'\n");
  await Promise.all([chmod(primary, 0o755), chmod(fallback, 0o755)]);
  const moduleUrl = new URL("../src/lib/ytdlp.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await m.getInfo('https://www.youtube.com/watch?v=abc')));`], {
    encoding: "utf8",
    env: { ...process.env, YTDLP_PATH: primary, YTDLP_FALLBACK_PATH: fallback },
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout.trim()).title, "fallback");
});

test("retained data-directory fallback is selected by default, while an empty env override disables it", async (t) => {
  const { mkdtemp, writeFile, chmod, mkdir, symlink, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-retained-default-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const primary = path.join(dir, "primary");
  const retainedDir = path.join(dir, "extractors", "2026.10.05");
  const retainedBinary = path.join(retainedDir, "bin", "yt-dlp");
  await mkdir(path.dirname(retainedBinary), { recursive: true });
  await writeFile(primary, "#!/bin/sh\necho 'ERROR: [youtube] Unable to extract initial data' >&2\nexit 1\n");
  await writeFile(retainedBinary, "#!/bin/sh\necho '{\"id\":\"retained123\",\"title\":\"retained\"}'\n");
  await Promise.all([chmod(primary, 0o755), chmod(retainedBinary, 0o755)]);
  await symlink(path.join("extractors", "2026.10.05"), path.join(dir, "extractor-backup"));
  const moduleUrl = new URL("../src/lib/ytdlp.js", import.meta.url).href;
  const code = `const m=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify({info:await m.getInfo('https://www.youtube.com/watch?v=retained123'),diagnostics:await m.getExtractorDiagnostics()}));`;
  const env = { ...process.env, DATA_DIR: dir, YTDLP_PATH: primary };
  delete env.YTDLP_FALLBACK_PATH;
  const automatic = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env, timeout: 10_000 });
  assert.equal(automatic.status, 0, automatic.stderr);
  const result = JSON.parse(automatic.stdout.trim());
  assert.equal(result.info.title, "retained");
  assert.equal(result.diagnostics.fallbackConfigured, true);
  assert.equal(result.diagnostics.candidates[1].executable, "yt-dlp");

  const disabled = spawnSync(process.execPath, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(moduleUrl)}); try { await m.getInfo('https://www.youtube.com/watch?v=retained123'); process.exit(3); } catch(e) { console.log(e.extractorClass || 'no-fallback'); }`], {
    encoding: "utf8", env: { ...env, YTDLP_FALLBACK_PATH: "" }, timeout: 10_000,
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /extraction/);
});

test("capture rejects output overflow and terminates timed out executables", async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-bounds-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const oversized = path.join(dir, "oversized");
  const sleeper = path.join(dir, "sleeper");
  await writeFile(oversized, "#!/bin/sh\nhead -c 9000000 /dev/zero\n");
  await writeFile(sleeper, "#!/bin/sh\nsleep 5\n");
  await Promise.all([chmod(oversized, 0o755), chmod(sleeper, 0o755)]);
  const moduleUrl = new URL("../src/lib/ytdlp.js", import.meta.url).href;
  const invoke = (binary, timeoutMs = 3_000) => spawnSync(process.execPath, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(moduleUrl)}); try { await m.capture(['--help'],{timeoutMs:${timeoutMs}}); process.exit(3); } catch(e) { console.log(e.code || e.message); }`], {
    encoding: "utf8", env: { ...process.env, YTDLP_PATH: binary, YTDLP_FALLBACK_PATH: "" }, timeout: 8_000,
  });
  const overflow = invoke(oversized);
  assert.equal(overflow.status, 0, overflow.stderr);
  assert.match(overflow.stdout, /EOUTPUTLIMIT/);
  const timeout = invoke(sleeper, 1_000);
  assert.equal(timeout.status, 0, timeout.stderr);
  assert.match(timeout.stdout, /ETIMEDOUT/);
});

test("playback canary checks each configured candidate and returns no stream URLs", async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-canary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const primary = path.join(dir, "primary-canary");
  const fallback = path.join(dir, "fallback-canary");
  const output = '{"id":"abc123_xyz","url":"/tmp/fake-video","title":"fixture"}';
  for (const binary of [primary, fallback]) {
    await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
    await chmod(binary, 0o755);
  }
  const moduleUrl = new URL("../src/lib/ytdlp.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await m.testExtractorPlayback('https://youtu.be/abc123_xyz')));`], {
    encoding: "utf8", env: { ...process.env, YTDLP_PATH: primary, YTDLP_FALLBACK_PATH: fallback }, timeout: 35_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout.trim());
  assert.deepEqual(results.map(({ executable, ok, sourceId, error }) => ({ executable, ok, sourceId, error })), [
    { executable: "primary-canary", ok: true, sourceId: "abc123_xyz", error: null },
    { executable: "fallback-canary", ok: true, sourceId: "abc123_xyz", error: null },
  ]);
  assert.doesNotMatch(JSON.stringify(results), /tmp\/fake-video|youtu\.be|https?:/);
});

test("playback canary rejects non-YouTube URLs before invoking candidates", async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-canary-url-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "invoked");
  const binary = path.join(dir, "candidate");
  await writeFile(binary, `#!/bin/sh\nprintf invoked > '${marker}'\n`);
  await chmod(binary, 0o755);
  const moduleUrl = new URL("../src/lib/ytdlp.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(moduleUrl)}); try { await m.testExtractorPlayback('https://example.com/watch?v=x'); process.exit(3); } catch(e) { console.log(e.message); }`], {
    encoding: "utf8", env: { ...process.env, YTDLP_PATH: binary, YTDLP_FALLBACK_PATH: "" }, timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /supported YouTube host/);
  await assert.rejects(import("node:fs/promises").then(({ access }) => access(marker)));
});

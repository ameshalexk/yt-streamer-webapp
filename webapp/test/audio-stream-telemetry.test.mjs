import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";

const source = fs.readFileSync(new URL("../src/lib/stream.js", import.meta.url), "utf8");
const body = source.slice(source.indexOf("export function streamAudio("), source.indexOf("// Quick probe"));

function fixture() {
  let now = 1000;
  const reports = [];
  const ff = new EventEmitter();
  ff.stdout = new EventEmitter();
  ff.stdout.pause = ff.stdout.resume = ff.stdout.unpipe = () => {};
  ff.stderr = new EventEmitter();
  ff.exitCode = null;
  ff.kill = () => { ff.killed = true; };
  const res = new EventEmitter();
  res.writeHead = () => { res.headersSent = true; };
  res.write = () => true;
  res.status = code => { res.statusCode = code; return res; };
  res.json = res.end = () => { res.emit("close"); };
  res.destroy = () => { res.destroyed = true; res.emit("close"); };
  const context = vm.createContext({
    config: { maxConcurrentStreams: 4, ffmpegPath: "fixture-ffmpeg" },
    audioActive: 0, spawn: () => ff, buildAudioArgs: () => [],
    Date: { now: () => now }, console: { warn() {} },
  });
  vm.runInContext(body.replace("export function", "function"), context);
  context.streamAudio({}, res, {
    input: "https://example.invalid/audio?token=private-fixture-token",
    onTelemetry: report => reports.push(JSON.parse(JSON.stringify(report))),
  });
  return { ff, res, reports, at: n => { now = n; } };
}

test("audio telemetry measures actual MP3 output and reports completed stream once", () => {
  const f = fixture();
  assert.equal(f.res.headersSent, undefined);
  f.at(1123); f.ff.stdout.emit("data", Buffer.alloc(6));
  f.at(1200); f.ff.stdout.emit("data", Buffer.alloc(4));
  f.at(1300); f.ff.exitCode = 0; f.ff.emit("close", 0);
  f.res.emit("close");
  assert.deepEqual(f.reports, [{ bytesWritten: 10, firstOutputMs: 123, durationMs: 300,
    endReason: "completed", failureKind: null, exitCode: 0 }]);
});

test("cancelled audio loads retain evidence of no bytes without duplicate close reports", () => {
  const f = fixture();
  f.at(5500); f.res.emit("close");
  f.ff.emit("close", null);
  assert.equal(f.ff.killed, true);
  assert.deepEqual(f.reports, [{ bytesWritten: 0, firstOutputMs: null, durationMs: 4500,
    endReason: "client-close", failureKind: null, exitCode: null }]);
});

test("audio errors retain a typed cause without exposing FFmpeg input or stderr", () => {
  const f = fixture();
  f.ff.stderr.emit("data", "HTTP 403 Forbidden https://example.invalid/audio?token=private-fixture-token");
  f.at(1400); f.ff.exitCode = 1; f.ff.emit("close", 1);
  assert.equal(f.res.statusCode, 502);
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].failureKind, "upstream-access-denied");
  assert.equal(f.reports[0].endReason, "error");
  assert.equal(f.reports[0].exitCode, 1);
  assert.doesNotMatch(JSON.stringify(f.reports), /private-fixture-token|example\.invalid|Forbidden/);
});

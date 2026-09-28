// Optional DASH sessions. Existing MJPEG requests never enter this module.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { config } from '../config.js';

const sessions = new Map();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-streamer-dash-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const activeCount = () => sessions.size;

export function buildDashArgs({ input, audioInput, params, startAt = 0, userAgent, referer }, output) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const addInput = source => {
    if (/^https?:\/\//i.test(source)) {
      args.push('-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
      if (userAgent) args.push('-user_agent', userAgent);
      if (referer) args.push('-headers', `Referer: ${referer}\r\n`);
    }
    const seek = Math.max(0, Number(startAt) || 0);
    if (seek) args.push('-ss', String(seek));
    args.push('-re', '-i', source);
  };
  addInput(input);
  if (audioInput && audioInput !== input) addInput(audioInput);
  const separate = audioInput && audioInput !== input;
  const fps = Math.max(3, Math.min(60, Number(params.fps) || 24));
  const height = Number(params.height) || 720;
  args.push('-map', '0:v:0', '-map', separate ? '1:a:0?' : '0:a:0?',
    '-vf', `scale=-2:${height},fps=${fps}`, '-pix_fmt', 'yuv420p');
  const encoder = process.env.DASH_VIDEO_ENCODER || (process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264');
  if (encoder === 'h264_videotoolbox') args.push('-c:v', encoder, '-realtime', '1', '-allow_sw', '1');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency');
  args.push('-b:v', '2000k', '-maxrate', '3000k', '-bufsize', '4000k',
    '-g', String(fps), '-bf', '0', '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-progress', 'pipe:3', '-f', 'dash', '-seg_duration', '1', '-use_template', '1', '-use_timeline', '1',
    '-window_size', '20', '-extra_window_size', '5', '-remove_at_exit', '0', output);
  return args;
}

export async function remove(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.ff && session.ff.exitCode == null) {
    session.ff.kill('SIGKILL');
    await Promise.race([new Promise(resolve => session.ff.once('close', resolve)), delay(1000)]);
  }
  await fs.rm(session.dir, { recursive: true, force: true });
}

export async function serveSession(req, res, options, otherActive = 0) {
  if (sessions.size + otherActive >= config.maxConcurrentStreams) return res.status(429).json({ error: 'Too many streams' });
  const id = crypto.randomUUID();
  const dir = path.join(root, id);
  const session = { id, dir, touched: Date.now(), position: 0, produced: 0, paused: false, stopped: false, done: false, error: null };
  sessions.set(id, session); // Reserve before any await.
  let delivered = false;
  const cancel = () => { if (!delivered) void remove(id); };
  res.once('close', cancel);
  try {
    await fs.mkdir(dir);
    if (!sessions.has(id) || res.destroyed) throw new Error('Cancelled');
    const ff = spawn(config.ffmpegPath, buildDashArgs(options, path.join(dir, 'manifest.mpd')), { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    session.ff = ff;
    ff.stderr.on('data', () => {}); // Do not expose signed source URLs in errors/logs.
    ff.on('error', () => { session.error = 'DASH encoder could not start'; });
    ff.on('close', code => { session.done = true; if (code !== 0) session.error = 'DASH encoder failed'; });
    let progress = '';
    ff.stdio[3].on('data', data => {
      progress += data;
      const lines = progress.split('\n');
      progress = lines.pop().slice(-1000);
      for (const line of lines) if (line.startsWith('out_time_us=')) session.produced = Math.max(0, Number(line.slice(12)) / 1e6 || 0);
      throttle(session);
    });
    const deadline = Date.now() + 25000;
    while (true) {
      if (!sessions.has(id) || res.destroyed) throw new Error('Cancelled');
      if (session.error) throw new Error(session.error);
      try { await fs.access(path.join(dir, 'manifest.mpd')); break; } catch {}
      if (Date.now() > deadline) throw new Error('DASH startup timed out');
      await delay(100);
    }
    delivered = true;
    res.set('Cache-Control', 'no-store').json({ id, manifestUrl: `/stream/dash/${id}/manifest.mpd` });
  } catch (error) {
    await remove(id);
    if (!res.destroyed) res.status(502).json({ error: error.message });
  } finally { res.off('close', cancel); }
}

function throttle(session) {
  if (!session.ff || session.done || session.ff.exitCode != null) return;
  const stop = session.paused || session.produced > session.position + 10;
  if (stop === session.stopped) return;
  session.stopped = stop;
  session.ff.kill(stop ? 'SIGSTOP' : 'SIGCONT');
}

export function heartbeat(req, res) {
  const session = sessions.get(req.params.id);
  if (!session) return res.sendStatus(404);
  session.touched = Date.now();
  const position = Number(req.body?.position);
  if (Number.isFinite(position)) session.position = Math.max(0, Math.min(position, session.produced));
  session.paused = req.body?.paused === true;
  throttle(session);
  res.json({ done: session.done, error: session.error });
}

export function serveFile(req, res) {
  const session = sessions.get(req.params.id);
  const name = req.params.file;
  if (!session || !/^(manifest\.mpd|init-stream\d+\.m4s|chunk-stream\d+-\d+\.m4s)$/.test(name)) return res.sendStatus(404);
  session.touched = Date.now();
  res.set('Cache-Control', 'no-store');
  res.type(name.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4');
  res.sendFile(path.join(session.dir, name), error => { if (error && !res.headersSent) res.sendStatus(404); });
}

const reaper = setInterval(() => {
  for (const session of sessions.values()) if (Date.now() - session.touched > 45000) void remove(session.id);
}, 5000);
reaper.unref();
export async function shutdown() {
  clearInterval(reaper);
  await Promise.all([...sessions.keys()].map(remove));
  await fs.rm(root, { recursive: true, force: true });
}

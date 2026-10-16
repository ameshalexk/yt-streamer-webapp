// Private APNE-only episode progress store. The canonical identity is show/date,
// not the changing APNE/YoDesi source, relay token or downloaded item ID.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_ENTRIES = 800;
const MAX_SECONDS = 24 * 60 * 60;

export function validEpisode(showId, dateKey) {
  return /^[a-z0-9-]{1,90}$/.test(String(showId || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''));
}

export function createApneProgressStore({ filePath }) {
  if (!filePath) throw new Error('APNE progress store path required');
  let cache;
  let chain = Promise.resolve();
  const keyFor = (showId, dateKey) => `${showId}:${dateKey}`;
  const publicEntry = (entry) => entry ? ({
    showId: entry.showId, dateKey: entry.dateKey,
    positionSeconds: entry.positionSeconds, durationSeconds: entry.durationSeconds,
    completed: entry.completed, updatedAt: entry.updatedAt,
  }) : null;
  const error = (status, message) => Object.assign(new Error(message), { status });
  const validate = (showId, dateKey) => {
    if (!validEpisode(showId, dateKey)) throw error(400, 'Invalid APNE episode');
  };
  async function read() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (parsed?.version !== 1 || !parsed.episodes || typeof parsed.episodes !== 'object' || Array.isArray(parsed.episodes))
        throw new Error('Unexpected APNE progress file format');
      cache = parsed;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause; // never overwrite unreadable watch history
      cache = { version: 1, episodes: {} };
    }
    return cache;
  }
  async function persist(data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, filePath);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
    cache = data;
  }
  function serialize(task) {
    const next = chain.then(task);
    chain = next.catch(() => {});
    return next;
  }
  function trim(episodes) {
    const entries = Object.entries(episodes);
    if (entries.length <= MAX_ENTRIES) return;
    entries.sort((a,b) => b[1].updatedAt - a[1].updatedAt);
    for (const [key] of entries.slice(MAX_ENTRIES)) delete episodes[key];
  }
  async function get(showId, dateKey) {
    validate(showId,dateKey);
    await chain;
    return publicEntry((await read()).episodes[keyFor(showId,dateKey)]);
  }
  async function list() {
    await chain;
    const data=await read();
    return Object.values(data.episodes).map(publicEntry);
  }
  async function begin(showId,dateKey) {
    validate(showId,dateKey);
    return serialize(async () => {
      const data = await read();
      const key = keyFor(showId,dateKey), existing = data.episodes[key];
      const sessionId = crypto.randomUUID();
      const entry = {
        showId,dateKey,
        positionSeconds: existing?.positionSeconds ?? 0,
        durationSeconds: existing?.durationSeconds ?? null,
        completed: Boolean(existing?.completed),
        updatedAt: Date.now(),
        sessionId, sequence: -1,
      };
      const next = { version: 1, episodes: { ...data.episodes, [key]: entry } };
      trim(next.episodes);
      await persist(next);
      return { sessionId, progress: publicEntry(entry) };
    });
  }
  async function update(showId,dateKey,body={}) {
    validate(showId,dateKey);
    if (typeof body.sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.sessionId))
      throw error(400,'Invalid playback session');
    if (!Number.isSafeInteger(body.sequence) || body.sequence < 0) throw error(400,'Invalid progress sequence');
    if (typeof body.positionSeconds !== 'number' || !Number.isFinite(body.positionSeconds) || body.positionSeconds < 0 || body.positionSeconds > MAX_SECONDS)
      throw error(400,'Invalid playback position');
    if (body.durationSeconds != null && (typeof body.durationSeconds !== 'number' || !Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0 || body.durationSeconds > MAX_SECONDS))
      throw error(400,'Invalid playback duration');
    if (body.ended !== undefined && typeof body.ended !== 'boolean') throw error(400,'Invalid ended flag');
    return serialize(async () => {
      const data = await read();
      const key = keyFor(showId,dateKey), existing = data.episodes[key];
      if (!existing || existing.sessionId !== body.sessionId || body.sequence <= existing.sequence)
        throw error(409,'Stale playback session or sequence');
      const duration = body.durationSeconds ?? existing.durationSeconds;
      const position = duration ? Math.min(duration,body.positionSeconds) : body.positionSeconds;
      const entry = { ...existing, positionSeconds: position, durationSeconds:duration,
        completed: existing.completed || body.ended === true,
        sequence: body.sequence, updatedAt: Date.now() };
      await persist({version:1, episodes:{...data.episodes,[key]:entry}});
      return publicEntry(entry);
    });
  }
  async function mark(showId,dateKey,watched) {
    validate(showId,dateKey);
    if (typeof watched !== 'boolean') throw error(400,'Watched must be a boolean');
    return serialize(async () => {
      const data=await read();
      const key=keyFor(showId,dateKey),existing=data.episodes[key];
      const entry={showId,dateKey,positionSeconds:watched ? (existing?.durationSeconds ?? existing?.positionSeconds ?? 0) : 0,
        durationSeconds:existing?.durationSeconds ?? null,completed:watched,updatedAt:Date.now(),
        sessionId:null,sequence:-1};
      const next={version:1,episodes:{...data.episodes,[key]:entry}};
      trim(next.episodes);await persist(next);return publicEntry(entry);
    });
  }
  return {get,list,begin,update,mark};
}

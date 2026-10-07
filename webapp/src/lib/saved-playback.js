import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as prepared from './prepared-cache.js';
import * as processed from './processed-library.js';
import * as store from './store.js';

export function youtubeVideoId(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    let id;
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      id = url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)\/?$/)?.[1];
    }
    return /^[\w-]{1,100}$/.test(id || '') ? id : null;
  } catch { return null; }
}

async function regularFileInside(file, root) {
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    const relative = path.relative(realRoot, realFile);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return false;
    return (await fs.stat(realFile)).isFile();
  } catch { return false; }
}

export function createSavedPlaybackLookup({ getPrepared = prepared.get, listProcessed = processed.list,
  listPlaylists = store.listPlaylists, videoPath = processed.videoPath, audioPath = processed.audioPath,
  dataDir = config.dataDir, libraryDir = config.libraryDir } = {}) {
  return async function findSavedPlayback(source) {
    const id = youtubeVideoId(source);
    if (!id) return null;
    const cached = await getPrepared(id);
    if (cached && await regularFileInside(cached.filePath, path.join(dataDir, 'prepared-cache'))) {
      return { id, title: cached.title, duration: cached.duration, videoPath: cached.filePath, audioPath: cached.filePath, kind: 'prepared' };
    }
    const item = (await listProcessed()).find(entry => entry.originalYoutubeId === id || youtubeVideoId(entry.originalUrl) === id);
    if (item && /^[\w.-]{1,100}$/.test(item.id) && !['.', '..'].includes(item.id)) {
      const resolution = (item.resolutions || []).map(Number).filter(n => Number.isInteger(n) && n >= 144 && n <= 2160).sort((a, b) => b - a)[0];
      const video = videoPath(item.id, resolution);
      const audio = audioPath(item.id);
      if (await regularFileInside(video, path.join(dataDir, 'processed-library'))) {
        return { id, title: item.title, duration: item.duration, videoPath: video,
          audioPath: await regularFileInside(audio, path.join(dataDir, 'processed-library')) ? audio : video, kind: 'processed' };
      }
    }
    for (const playlist of await listPlaylists()) {
      const saved = (playlist.items || []).find(entry => entry.type === 'file'
        && (entry.meta?.originalYoutubeId === id || youtubeVideoId(entry.meta?.originalUrl) === id));
      if (saved && await regularFileInside(saved.url, libraryDir)) {
        return { id, title: saved.title, duration: saved.meta?.duration, videoPath: saved.url, audioPath: saved.url, kind: 'library' };
      }
    }
    return null;
  };
}
export const findSavedPlayback = createSavedPlaybackLookup();

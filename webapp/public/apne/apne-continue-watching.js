/* APNE continue-watching selection: one history across all configured shows. */
(() => {
  'use strict';
  const validShow = (value) => /^[a-z0-9-]{1,90}$/.test(String(value || ''));
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}(?:-e[1-9]\d{0,5})?$/.test(String(value || ''));
  function select(episodes, shows, limit = 8) {
    const known = new Map((Array.isArray(shows) ? shows : [])
      .filter(show => validShow(show?.id))
      .map(show => [show.id, show]));
    const seen = new Map();
    for (const progress of Array.isArray(episodes) ? episodes : []) {
      if (!progress || !validShow(progress.showId) || !validDate(progress.dateKey)) continue;
      const item = known.get(progress.showId);
      const position = Number(progress.positionSeconds);
      const duration = Number(progress.durationSeconds);
      if (!item || progress.completed || !Number.isFinite(position) || position < 5 ||
          (Number.isFinite(duration) && duration > 0 && position >= duration - 4)) continue;
      const listed = (item.recentEpisodes || []).find(ep => ep.dateKey === progress.dateKey);
      const updatedAt = Number(progress.updatedAt);
      const entry = {
        showId: item.id, showName: String(item.name || item.id),
        dateKey: progress.dateKey,
        episodeTitle: String(listed?.episodeTitle || ''),
        episodeNumber: listed?.episodeNumber || null,
        status: String(listed?.status || ''),
        positionSeconds: position,
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
      };
      entry.percent = entry.durationSeconds
        ? Math.max(0, Math.min(99, Math.round(entry.positionSeconds / entry.durationSeconds * 100)))
        : null;
      const key = entry.showId + ':' + entry.dateKey;
      if (!seen.has(key) || seen.get(key).updatedAt < entry.updatedAt) seen.set(key, entry);
    }
    return [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt ||
      a.showId.localeCompare(b.showId) || b.dateKey.localeCompare(a.dateKey))
      .slice(0, Math.max(0, Math.min(12, Math.floor(Number(limit) || 0))));
  }
  window.ApneContinueWatching = { select };
})();

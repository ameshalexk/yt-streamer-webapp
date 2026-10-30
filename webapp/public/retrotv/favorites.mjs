// Retro TV favorites are browser-local. The same initial three are seeded
// on every browser, and later star/unstar choices remain device-specific.
export const FAVORITES_STORAGE_KEY = "ytstreamer:retrotv:favorites:v1";
export const DEFAULT_FAVORITES = Object.freeze([
  "family-matinee",                  // 43
  "chaplin-two-reelers",             // 33
  "buster-keaton-in-an-evening",     // 34
]);

export function loadFavorites(storage) {
  try {
    const saved = storage?.getItem(FAVORITES_STORAGE_KEY);
    if (saved === null || saved === undefined) return [...DEFAULT_FAVORITES];
    const ids = JSON.parse(saved);
    if (!Array.isArray(ids)) return [...DEFAULT_FAVORITES];
    return [...new Set(ids.filter((id) => typeof id === "string" && /^[a-z0-9_-]{1,71}$/i.test(id)))].slice(0, 100);
  } catch {
    return [...DEFAULT_FAVORITES];
  }
}
export function saveFavorites(storage, ids) {
  try {
    storage?.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}
export function toggleFavorite(ids, channelId) {
  if (ids.includes(channelId)) return ids.filter((id) => id !== channelId);
  return [...ids, channelId];
}
export function groupChannels(channels, ids) {
  const selected = new Map(channels.map((c) => [c.id, c]));
  const favorites = ids.map((id) => selected.get(id)).filter(Boolean);
  const others = channels.filter((c) => !ids.includes(c.id));
  return { favorites, others };
}

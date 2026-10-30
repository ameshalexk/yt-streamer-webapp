import test from "node:test";
import assert from "node:assert/strict";
import { FAVORITES_STORAGE_KEY, DEFAULT_FAVORITES, loadFavorites, saveFavorites, toggleFavorite, groupChannels } from "../public/retrotv/favorites.mjs";

test("new Retro TV browsers favorite channels 43, 33 and 34", () => {
  assert.deepEqual(loadFavorites({ getItem: () => null }), ["family-matinee", "chaplin-two-reelers", "buster-keaton-in-an-evening"]);
  assert.equal(DEFAULT_FAVORITES.length, 3);
});
test("saved favorites persist and deliberate empty selection stays empty", () => {
  let raw = null;
  const storage = { getItem: () => raw, setItem: (key, value) => { assert.equal(key, FAVORITES_STORAGE_KEY); raw = value; } };
  assert.ok(saveFavorites(storage, []));
  assert.deepEqual(loadFavorites(storage), []);
  assert.ok(saveFavorites(storage, ["family-matinee", "family-matinee", "chaplin-two-reelers"]));
  assert.deepEqual(loadFavorites(storage), ["family-matinee", "chaplin-two-reelers"]);
});
test("unavailable or corrupted storage falls back without throwing", () => {
  assert.deepEqual(loadFavorites({ getItem: () => { throw Error("blocked"); } }), DEFAULT_FAVORITES);
  assert.deepEqual(loadFavorites({ getItem: () => "not json" }), DEFAULT_FAVORITES);
  assert.equal(saveFavorites({ setItem: () => { throw Error("blocked"); } }, []), false);
  assert.deepEqual(loadFavorites({ getItem: () => JSON.stringify(["valid", "bad/../id", 123, "valid"]) }), ["valid"]);
});
test("star/unstar and grouping do not duplicate channels", () => {
  const ids = toggleFavorite([...DEFAULT_FAVORITES], "family-matinee");
  assert.ok(!ids.includes("family-matinee"));
  assert.ok(toggleFavorite(ids, "family-matinee").includes("family-matinee"));
  const channels = [{ id: "other" }, { id: "chaplin-two-reelers" }, { id: "family-matinee" }, { id: "buster-keaton-in-an-evening" }];
  const grouped = groupChannels(channels, DEFAULT_FAVORITES);
  assert.deepEqual(grouped.favorites.map((x) => x.id), DEFAULT_FAVORITES);
  assert.deepEqual(grouped.others.map((x) => x.id), ["other"]);
});

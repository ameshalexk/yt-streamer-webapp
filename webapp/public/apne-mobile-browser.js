// Date-first episode navigation for the Anupamaa mobile view.
// Pure helpers are exposed to the existing classic APNE controller.
(function (root) {
  "use strict";
  const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  function selectEpisodes(episodes, filters = {}, progressByKey = {}, showId = "anupamaa") {
    const date = validDate(filters.date) ? filters.date : "";
    return (Array.isArray(episodes) ? episodes : [])
      .filter((ep) => !date || ep.dateKey === date)
      .filter((ep) => !filters.onlyUnwatched || progressByKey[showId + ":" + ep.dateKey]?.completed !== true)
      .slice()
      .sort((a, b) => filters.order === "oldest"
        ? String(a.dateKey || "").localeCompare(String(b.dateKey || ""))
        : String(b.dateKey || "").localeCompare(String(a.dateKey || "")));
  }
  function recentDates(episodes, limit = 7) {
    return [...new Set((episodes || []).map((episode) => episode.dateKey).filter(validDate))]
      .sort((a, b) => b.localeCompare(a))
      .slice(0, Math.max(0, limit));
  }
  function dateChipLabel(dateKey) {
    if (!validDate(dateKey)) return "";
    const parts = dateKey.split("-");
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12);
    return {
      day: date.toLocaleDateString("en-US", {weekday:"short"}),
      date: date.toLocaleDateString("en-US", {month:"short", day:"numeric"})
    };
  }
  root.ApneMobileBrowser = {selectEpisodes, recentDates, dateChipLabel};
})(typeof window === "undefined" ? globalThis : window);

// Date-first episode navigation for the Anupamaa mobile view.
// Pure helpers are exposed to the existing classic APNE controller.
(function (root) {
  "use strict";
  const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  // Keep the air date first, then sort multipart episodes numerically (e10 after e9).
  function compareEpisodes(a, b) {
    const dateA = String(a?.airDateKey || a?.dateKey || "").slice(0, 10);
    const dateB = String(b?.airDateKey || b?.dateKey || "").slice(0, 10);
    const dateOrder = dateA.localeCompare(dateB);
    if (dateOrder) return dateOrder;
    const part = ep => Number(ep?.episodeNumber || /-e(\d+)$/.exec(ep?.dateKey || "")?.[1] || 0);
    return part(a) - part(b);
  }
  function watchState(progress) {
    if (progress?.completed) return "watched";
    if (Number(progress?.positionSeconds) >= 5) return "in-progress";
    return "not-started";
  }
  function selectEpisodes(episodes, filters = {}, progressByKey = {}, showId = "anupamaa") {
    const date = validDate(filters.date) ? filters.date : "";
    return (Array.isArray(episodes) ? episodes : [])
      .filter((ep) => !date || ep.dateKey === date)
      .filter((ep) => {
        const status = watchState(progressByKey[showId + ":" + ep.dateKey]);
        if (filters.watchFilter === "not-started") return status === "not-started";
        if (filters.watchFilter === "in-progress") return status === "in-progress";
        if (filters.watchFilter === "watched") return status === "watched";
        return !filters.onlyUnwatched || status !== "watched";
      })
      .slice()
      .sort((a, b) => (filters.order === "oldest" ? 1 : -1) * compareEpisodes(a, b));
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
  root.ApneMobileBrowser = {selectEpisodes, recentDates, dateChipLabel, compareEpisodes, watchState};
})(typeof window === "undefined" ? globalThis : window);

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  episodeMatchesDownloadedItem,
  normalizeApneShowInput,
  parseFlashTargetFromEpisodeHtml,
  parseLatestEpisodeFromShowHtml,
  parseRecentEpisodesFromShowHtml,
  parseMediagramingHlsFromHtml,
  parseNewsportalingRedirect,
} from "../src/lib/apne-daily.js";

const apneDailySource = fs.readFileSync(new URL("../src/lib/apne-daily.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const show = {
  id: "anupamaa",
  name: "Anupamaa",
  url: "https://apnetv.xyz/Hindi-Serial/Anupamaa",
};

test("APNE Daily detects the newest dated episode from a show page", () => {
  const fixture = [
    '<select>',
    '<option value="_self#@#https://apnetv.xyz/Hindi-Serial/show/286337/Anupamaa">14th September 2026</option>',
    '<option value="_self#@#https://apnetv.xyz/Hindi-Serial/show/286378/Anupamaa">15th September 2026</option>',
    '<option value="_self#@#https://apnetv.xyz/Hindi-Serial/show/286310/Anupamaa">13th September 2026</option>',
    '</select>',
  ].join("");
  const episode = parseLatestEpisodeFromShowHtml(fixture, show);
  assert.equal(episode.url, "https://apnetv.xyz/Hindi-Serial/show/286378/Anupamaa");
  assert.equal(episode.dateLabel, "15th September 2026");
  assert.equal(episode.dateKey, "2026-09-15");
});

test("APNE Daily returns up to 10 recent episodes in newest-first order", () => {
  const fixture = Array.from({ length: 12 }, (_, index) => {
    const day = 12 - index;
    return `<option value="_self#@#https://apnetv.xyz/Hindi-Serial/show/${286300 + day}/Anupamaa">${day}th September 2026</option>`;
  }).join("");
  const episodes = parseRecentEpisodesFromShowHtml(fixture, show, 10);
  assert.equal(episodes.length, 10);
  assert.equal(episodes[0].dateKey, "2026-09-12");
  assert.equal(episodes[9].dateKey, "2026-09-03");
});


test("APNE Daily resolves the browserless APNE to Newsportaling to Mediagraming HLS chain", () => {
  const episodeHtml = '<div data-id="252828be46d8f1433be256ee1e3f212f" data-href="https://newsportaling.com/finnance-account-insurance-yield" class="flash_link">Flash Link</div>';
  const flash = parseFlashTargetFromEpisodeHtml(episodeHtml);
  assert.deepEqual(flash, {
    id: "252828be46d8f1433be256ee1e3f212f",
    href: "https://newsportaling.com/finnance-account-insurance-yield",
  });

  const newsHtml = '<script>myRedirect("https://mediagraming.com/tales-of-wall-street/", "id", "252828be46d8f1433be256ee1e3f212f");</script><input type="hidden" name="channel" value="starplus1">';
  const handoff = parseNewsportalingRedirect(newsHtml);
  assert.equal(handoff.url, "https://mediagraming.com/tales-of-wall-street/");
  assert.equal(handoff.id, flash.id);
  assert.equal(handoff.channel, "starplus1");

  const mediaHtml = '<iframe src="https://mediagraming.com/new/video.php/?url=https://s2.videoapne.to/hls/,abc,.urlset/master.m3u8"></iframe>';
  assert.equal(
    parseMediagramingHlsFromHtml(mediaHtml),
    "https://s2.videoapne.to/hls/,abc,.urlset/master.m3u8",
  );
});

test("APNE Daily duplicate detection skips an already downloaded episode", () => {
  const episode = {
    url: "https://apnetv.xyz/Hindi-Serial/show/286378/Anupamaa",
    dateLabel: "15th September 2026",
    dateKey: "2026-09-15",
  };

  assert.equal(episodeMatchesDownloadedItem({
    id: "existing",
    title: "Anupamaa 15th September",
    type: "file",
    url: "/library/Anupamaa 15th September.mp4",
    meta: { source: "apnetv", duration: 1762.64 },
  }, show, episode), true);

  assert.equal(episodeMatchesDownloadedItem({
    id: "previous",
    title: "Anupamaa 14th September",
    type: "file",
    url: "/library/Anupamaa 14th September.mp4",
    meta: { source: "apnetv" },
  }, show, episode), false);

  assert.match(apneDailySource, /if \(saved\) \{[\s\S]*job\.status = "Saved";[\s\S]*Already downloaded/);
  assert.match(apneDailySource, /if \(episode\.dateKey !== todayKey\(\)\) \{[\s\S]*"Not available yet"/);
});

test("APNE Daily downloads register as seekable local files in Downloaded Videos", () => {
  assert.match(apneDailySource, /kind: "downloaded-files"/);
  assert.match(apneDailySource, /spawn\("ffprobe"/);
  assert.match(apneDailySource, /registerDownloadedVideo\(finalPath, title/);
  assert.match(apneDailySource, /type: "file"/);
  assert.match(apneDailySource, /source: "apnetv"/);
  assert.match(apneDailySource, /"-map", "0:v:0\?"/);
  assert.match(apneDailySource, /"-map", "0:a:0\?"/);
  assert.match(apneDailySource, /"-c", "copy"/);
  assert.match(apneDailySource, /duration \? \{ \.\.\.meta, duration \} : meta/);
});

test("APNE Daily show management normalizes APNE show and episode URLs", () => {
  assert.deepEqual(normalizeApneShowInput(
    "https://apnetv.xyz/Hindi-Serial/show/286378/Anupamaa",
    "",
  ), {
    id: "anupamaa",
    name: "Anupamaa",
    url: "https://apnetv.xyz/Hindi-Serial/Anupamaa",
    builtIn: false,
  });
  assert.throws(
    () => normalizeApneShowInput("https://example.com/Anupamaa"),
    /apnetv\.xyz/,
  );
});

test("APNE Daily UI renders the tab, statuses, Download Today, Play, and Manage Shows", () => {
  assert.match(html, /data-mode="apne"[^>]*>APNE Daily<\/button>/);
  assert.match(html, /id="apneDailyView"/);
  assert.match(html, /id="apneManageShowsBtn"[^>]*>Manage Shows<\/button>/);
  assert.match(app, /function renderApneDaily\(\)/);
  assert.match(app, /Download Today/);
  assert.match(app, /saved \? "Play"/);
  assert.match(app, /Recent episodes/);
  assert.match(app, /apne-recent-link/);
  assert.match(apneDailySource, /recentEpisodes/);
  assert.match(app, /if \(item\.type === "youtube"\) \{[\s\S]*refreshYoutubeMetadataInBackground/);
  for (const status of ["Checking", "Not available yet", "Available", "Downloading", "Saved", "Failed"]) {
    assert.ok((apneDailySource + app).includes(status), "missing APNE Daily status: " + status);
  }
  assert.match(server, /app\.get\("\/api\/apne-daily"/);
  assert.match(server, /\/api\/apne-daily\/shows\/:id\/download/);
});

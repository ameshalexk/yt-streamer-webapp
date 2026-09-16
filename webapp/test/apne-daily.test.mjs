import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  episodeMatchesDownloadedItem,
  filterApneEpisodesByMonths,
  normalizeApneShowInput,
  parseActorAgeCheckEpisodeMetadata,
  parseFlashTargetFromEpisodeHtml,
  parseLatestEpisodeFromShowHtml,
  parseRecentEpisodesFromShowHtml,
  parseSkyEpisodeMetadata,
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

test("APNE Daily keeps a three-month episode history window", () => {
  const episodes = [
    { dateKey: "2026-09-16", dateLabel: "16th September 2026" },
    { dateKey: "2026-08-01", dateLabel: "1st August 2026" },
    { dateKey: "2026-06-16", dateLabel: "16th June 2026" },
    { dateKey: "2026-06-15", dateLabel: "15th June 2026" },
  ];
  assert.deepEqual(
    filterApneEpisodesByMonths(episodes, 3).map((episode) => episode.dateKey),
    ["2026-09-16", "2026-08-01", "2026-06-16"],
  );
});

test("APNE Daily enriches Anupamaa dates with episode numbers and real titles", () => {
  const fixture =
    'self.__next_f.push([1,"x:{\\"episode\\":{\\"uuid\\":\\"one\\",\\"title\\":\\"Leela Eyes the Shah House\\",\\"episodeNumber\\":2136,\\"synopsis\\":\\"x\\",\\"waysToWatch\\":{\\"overTheTop\\":[{\\"startTime\\":\\"2026-09-09T20:00:00.000Z\\"}]}}}"])' +
    '<script>self.__next_f.push([1,"y:{\\"episode\\":{\\"uuid\\":\\"two\\",\\"title\\":\\"Anupamaa\\",\\"episodeNumber\\":2142,\\"synopsis\\":\\"x\\",\\"waysToWatch\\":{\\"overTheTop\\":[{\\"startTime\\":\\"2026-09-15T20:00:00.000Z\\"}]}}}"])';
  const meta = parseSkyEpisodeMetadata(fixture, "Anupamaa");
  assert.deepEqual(meta["2026-09-10"], {
    episodeNumber: 2136,
    episodeTitle: "Leela Eyes the Shah House",
  });
  assert.deepEqual(meta["2026-09-16"], {
    episodeNumber: 2142,
    episodeTitle: "",
  });
});


test("APNE Daily never exposes serialized Sky payload as an episode title", () => {
  const fixture =
    'self.__next_f.push([1,"a:{\\"episode\\":{\\"uuid\\":\\"one\\",\\"title\\":\\"Sat - Aug 15, 2026\\",\\"episodeNumber\\":2111,\\"synopsis\\":\\"x\\",\\"waysToWatch\\":{\\"overTheTop\\":[{\\"startTime\\":\\"2026-08-15T20:00:00.000Z\\"}]}}}"])' +
    'self.__next_f.push([1,"b:{\\"episode\\":{\\"uuid\\":\\"two\\",\\"title\\":\\"Anupamaa\\",\\"episodeNumber\\":2112,\\"synopsis\\":\\"x\\",\\"waysToWatch\\":{\\"overTheTop\\":[{\\"startTime\\":\\"2026-08-16T20:00:00.000Z\\"}]}}}"])';
  const meta = parseSkyEpisodeMetadata(fixture, "Anupamaa");
  assert.deepEqual(meta["2026-08-16"], { episodeNumber: 2111, episodeTitle: "" });
  assert.deepEqual(meta["2026-08-17"], { episodeNumber: 2112, episodeTitle: "" });
  for (const value of Object.values(meta)) {
    assert.doesNotMatch(value.episodeTitle || "", /episodeNumber|synopsis|waysToWatch/);
    assert.ok((value.episodeTitle || "").length <= 160);
  }
});


test("APNE Daily parses full-season date, number, and title metadata", () => {
  const fixture = [
    '<div class="movie episode"><a href="tv/Anupamaa/116479/season/1/episode/2103" title="Anupamaa - Season 1 - Tables Turn at the Food Carnival (Episode 2103)">Tables Turn at the Food Carnival</a><div></div><span class="ageinmovie">2103</span><div class="release"><span class="seinfo">Episode Air Date: </span>Fri, Aug 07 2026</div></div>',
    '<div class="movie episode"><a href="tv/Anupamaa/116479/season/1/episode/2138" title="Anupamaa - Season 1 - Episode 2138 (Episode 2138)">Episode 2138</a><div></div><span class="ageinmovie">2138</span><div class="release"><span class="seinfo">Episode Air Date: </span>Fri, Sep 11 2026</div></div>',
  ].join("");
  const meta = parseActorAgeCheckEpisodeMetadata(fixture, "Anupamaa");
  assert.deepEqual(meta["2026-08-07"], { episodeNumber: 2103, episodeTitle: "Tables Turn at the Food Carnival" });
  assert.deepEqual(meta["2026-09-11"], { episodeNumber: 2138, episodeTitle: "" });
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

  assert.match(apneDailySource, /download_duplicate/);
  assert.match(apneDailySource, /export async function startEpisodeDownload\(showId, dateKey\)/);
  assert.match(apneDailySource, /history\.find\(\(item\) => item\.dateKey === key\)/);
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

test("APNE Daily UI renders latest controls, three-month history, and pagination", () => {
  assert.match(html, /data-mode="apne"[^>]*>APNE Daily<\/button>/);
  assert.match(html, /id="apneDailyView"/);
  assert.match(html, /id="apneManageShowsBtn"[^>]*>Manage Shows<\/button>/);
  assert.match(app, /function renderApneDaily\(\)/);
  assert.match(app, /Download Latest/);
  assert.match(app, /saved \? "Play Latest"/);
  assert.match(app, /Last .* months/);
  assert.match(app, /apne-page-newer/);
  assert.match(app, /apne-page-older/);
  assert.match(app, /Page .* of/);
  assert.match(app, /recent\.episodeNumber \? "Episode "/);
  assert.match(app, /recent\.episodeTitle/);
  assert.match(app, /apne-episode-name/);
  assert.match(apneDailySource, /SKY_EPISODE_METADATA_URLS/);
  assert.match(apneDailySource, /episode_metadata_ok/);
  assert.match(app, /recentAction = recentSaved \? "play-episode" : "download-episode"/);
  assert.match(app, /button\.dataset\.act === "play-episode"/);
  assert.match(app, /startApneEpisodeDownload/);
  assert.match(apneDailySource, /recentEpisodes/);
  assert.match(apneDailySource, /APNE_HISTORY_MONTHS = 3/);
  assert.match(apneDailySource, /APNE_HISTORY_PAGE_SIZE = 10/);
  assert.match(apneDailySource, /Indian TV date/);
  assert.match(app, /if \(item\.type === "youtube"\) \{[\s\S]*refreshYoutubeMetadataInBackground/);
  for (const status of ["Checking", "Available", "Downloading", "Saved", "Failed"]) {
    assert.ok((apneDailySource + app).includes(status), "missing APNE Daily status: " + status);
  }
  assert.match(server, /app\.get\("\/api\/apne-daily"/);
  assert.match(server, /\/api\/apne-daily\/shows\/:id\/download/);
  assert.match(server, /\/api\/apne-daily\/shows\/:id\/episodes\/:dateKey\/download/);
});


test("APNE Daily keeps structured rotating diagnostics for source-chain changes", () => {
  assert.match(apneDailySource, /apne-daily\.log/);
  assert.match(apneDailySource, /LOG_MAX_BYTES/);
  for (const event of [
    "show_check_start", "show_check_ok", "show_check_failed",
    "resolve_start", "episode_html_ok", "flash_target_ok",
    "newsportaling_html_ok", "mediagraming_handoff_ok", "mediagraming_html_ok",
    "hls_resolved", "ffmpeg_start", "ffmpeg_failed", "download_saved", "download_failed",
  ]) assert.ok(apneDailySource.includes(event), `missing APNE diagnostic event ${event}`);
  assert.match(apneDailySource, /hlsHost: hostOf\(hlsUrl\)/);
  assert.doesNotMatch(apneDailySource, /hlsUrl, fileName/);
});

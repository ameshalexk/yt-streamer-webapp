import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  episodeMatchesDownloadedItem,
  filterApneEpisodesByMonths,
  normalizeApneShowInput,
  validateApneShowName,
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

test("APNE background scans are lightweight and use cached source status without downloads", () => {
  assert.match(apneDailySource, /export async function scanLatestForBackground/);
  assert.match(apneDailySource, /detectRecent\(show,3\)/);
  assert.match(apneDailySource, /sourceAvailability\.check\(show\.id,episode\.dateKey,episode\.url\)/);
  assert.match(apneDailySource, /if \(earlier\.dateKey && earlier\.dateKey !== episode\.dateKey\)/);
  assert.match(server, /createApneBackgroundCheck/);
  assert.match(server, /apneBackgroundCheck\.start\(\)/);
  assert.match(server, /apneBackgroundCheck: apneBackgroundCheck\.status\(\)/);
});

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

test("APNE Daily accepts Dr Aarambhi NewsMagics flash links without trusting lookalike hosts", () => {
  const id = "23a17a19ab70f3861295714ddc974ed8";
  const tag = (href) => `<div data-id="${id}" data-href="${href}" class="flash_link">Flash Link</div>`;
  assert.deepEqual(parseFlashTargetFromEpisodeHtml(tag("https://newsmagics.com/savvings-budget-income-expense")), {
    id,
    href: "https://newsmagics.com/savvings-budget-income-expense",
  });
  for (const url of [
    "https://newsmagics.com.evil.example/savvings-budget-income-expense",
    "https://evilnewsmagics.com/savvings-budget-income-expense",
    "http://newsmagics.com/savvings-budget-income-expense",
    "https://newsmagics.com/other-budget-income-expense",
    "https://newsmagics.com/savvings-budget-income-expense?redirect=1",
    "https://user@newsmagics.com/savvings-budget-income-expense",
  ]) assert.throws(() => parseFlashTargetFromEpisodeHtml(tag(url)), /Flash Link was not found/);
});

test("APNE Daily accepts the live Seher Newscurting handoff and rejects untrusted flash targets", () => {
  const id = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(
    parseFlashTargetFromEpisodeHtml(`<div class="flash_link" data-href="https://newscurting.com/savvings-seher-hone-ko-hai" data-id="${id}"></div>`),
    { id, href: "https://newscurting.com/savvings-seher-hone-ko-hai" },
  );
  const handoff = parseNewsportalingRedirect(
    `<script>myRedirect("https://mediagraming.com/seher/", "id", "${id}");</script><input name="channel" value="colors2">`,
  );
  assert.deepEqual(handoff, {
    url: "https://mediagraming.com/seher/",
    id,
    channel: "colors2",
  });

  const legacy = `<div class="flash_link" data-id="${id}" data-href="https://www.newsportaling.com/finnance-account-insurance-yield"></div>`;
  assert.equal(parseFlashTargetFromEpisodeHtml(legacy).href, "https://www.newsportaling.com/finnance-account-insurance-yield");
  for (const href of [
    "https://example.com/savvings-seher",
    "https://newscurting.com/other-seher",
    "https://newscurting.com/finnance-seher",
    "https://newsportaling.com/savvings-seher",
    "https://newscurting.com/savvings-seher?redirect=https://example.com",
    "https://newscurting.com.evil.example/savvings-seher",
  ]) {
    assert.throws(
      () => parseFlashTargetFromEpisodeHtml(`<div class="flash_link" data-id="${id}" data-href="${href}"></div>`),
      /Flash Link was not found/,
    );
  }
  assert.throws(
    () => parseFlashTargetFromEpisodeHtml('<div class="flash_link" data-id="not-an-id" data-href="https://newscurting.com/savvings-seher"></div>'),
    /Flash Link was not found/,
  );
  for (const url of [
    "https://evilmediagraming.com/seher/",
    "https://mediagraming.com.evil.example/seher/",
    "https://user@mediagraming.com/seher/",
    "https://mediagraming.com:444/seher/",
  ]) {
    assert.throws(
      () => parseNewsportalingRedirect(`<script>myRedirect("${url}", "id", "${id}");</script>`),
      /unexpected Mediagraming host/,
    );
  }
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
  assert.match(apneDailySource, /mirrorApneVideoToICloud\(finalPath\)/);
  assert.match(apneDailySource, /const savedMeta = \{ \.\.\.meta, iCloudPath/);
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

test("APNE Daily display-name edit validates labels and retains existing saved episode identity", () => {
  assert.equal(validateApneShowName("  Dr.  Aarambhi  "), "Dr. Aarambhi");
  assert.equal(validateApneShowName("അനുപമ"), "അനുപമ");
  for (const invalid of ["", "   ", "x".repeat(121), "Bad\nName", null, 25]) {
    assert.throws(() => validateApneShowName(invalid), /show name/i);
  }
  const priorEpisode = {
    url: "https://apnetv.xyz/Hindi-Serial/show/286378/Anupamaa",
    dateLabel: "15th September 2026",
    dateKey: "2026-09-15",
  };
  const savedItem = {type: "file", title: "Anupamaa 15th September", meta: {
    source: "apnetv", apneShowId: "anupamaa", apneEpisodeDate: "2026-09-15",
  }};
  assert.equal(episodeMatchesDownloadedItem(savedItem, {...show, name:"New Display Name"}, priorEpisode), true);
  assert.match(apneDailySource, /nameOverrides/);
  assert.match(apneDailySource, /export async function renameShow\(showId, input = \{\}\)/);
  assert.match(apneDailySource, /const metadataName = DEFAULT_SHOWS/);
  assert.match(server, /app\.patch\("\/api\/apne-daily\/shows\/:id"/);
  assert.match(server, /isSameOriginRequest\(req\)/);
});

test("APNE Daily exposes a separate edit control while the show is collapsed", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(app, /apne-show-wrap/);
  assert.match(app, /apne-edit-name-btn/);
  assert.match(app, /data-act="edit-apne-name"/);
  assert.match(app, /function openApneRenameShow\(showId\)/);
  assert.match(app, /id="apneRenameInput"/);
  assert.match(app, /\/api\/apne-daily\/shows\//);
  assert.match(css, /\.apne-show-wrap \{ position: relative/);
  assert.match(css, /\.apne-edit-name-btn/);
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
  assert.match(app, /recentAction = recentSaved \? "play-episode" : \(streamOnly \? "stream-apne"/);
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


test("APNE Daily separates source availability from catalog listings and preserved saves", () => {
  assert.match(apneDailySource, /SOURCE_STATUS/);
  assert.match(apneDailySource, /SOURCE_STATUS\[checked\?\.state\] \|\| "Listed"/);
  assert.match(apneDailySource, /sourceAvailability\.check/);
  assert.match(server, /app\.post\("\/api\/apne-daily\/shows\/:id\/episodes\/:dateKey\/check-source"/);
  assert.match(app, /function applyApneSourceStatus/);
  assert.match(app, /function checkApneSourceForTile/);
  assert.match(app, /"check-apne-source"/);
  assert.match(app, /Source unavailable/);
  assert.match(apneDailySource, /link: "Available"/);
  assert.match(app, /\.dataset\.thumbSaved === "check"/);
});

test("APNE source fallback supports two-part embedded streaming without pretending download works", () => {
  const player=fs.readFileSync(new URL("../public/apne-live-player.js", import.meta.url), "utf8");
  assert.match(apneDailySource, /resolveYoDesiEmbed/);
  assert.match(apneDailySource, /if \(resolved\.embedUrls\) throw new Error\("Streaming is available/);
  assert.match(apneDailySource, /verified\?\.mode === "embed"/);
  assert.match(server, /resolved\.embedUrls\) return res\.json\(\{format:"embed",parts:/);
  assert.match(server, /frame-src https:\/\/www\.blogger\.com/);
  assert.match(server, /id="apneEmbedStage"/);
  assert.match(player, /source\.format === 'embed'/);
  assert.match(player, /setAttribute\('sandbox', 'allow-scripts allow-same-origin allow-presentation'\)/);
  assert.match(player, /Part ' \+ \(i \+ 1\)/);
  assert.match(app, /streamOnly \? "stream-apne"/);
  assert.match(app, /recent\.dateKey && !streamOnly/);
  assert.match(app, /apnePreviewKind\(showId,dateKey,false,result.status,result.mode\)/);
});

test("APNE Daily Phase A renders responsive episode tiles and preview placeholders without starting downloads", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(app, /class="apne-episode-grid"/);
  assert.match(app, /class="apne-recent-row apne-episode-tile /);
  assert.match(app, /class="apne-episode-preview" data-show-id=/);
  assert.match(app, /data-date-key="' \+ esc\(recent\.dateKey \|\| ""\)/);
  assert.match(app, /Preview coming soon/);
  assert.match(app, /class="apne-episode-status /);
  assert.match(app, /class="apne-episode-tile-body"/);
  assert.match(app, /class="apne-recent-actions"/);
  assert.match(app, /data-act="stream-apne"/);
  assert.match(app, /data-act="' \+ recentAction/);
  assert.match(app, /mobileActive && !visibleEpisodes\.length/);
  assert.match(css, /container: apne-episodes \/ inline-size/);
  assert.match(css, /@container apne-episodes \(min-width: 450px\)/);
  assert.match(css, /aspect-ratio: 16 \/ 9/);
  assert.match(css, /\.apne-episode-tile \.btn\.apne-recent-action/);
  assert.match(css, /min-height: 46px/);
});

test("APNE Daily show cards collapse by default, retain expansion across polls, and keep buttons inside", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(app, /expandedByShow: \{\}/);
  assert.match(app, /querySelectorAll\("details\.apne-show-card\[data-show-id\]"\)/);
  assert.match(app, /expandedByShow\[card\.dataset\.showId\] = card\.open/);
  assert.match(app, /focusedShowId/);
  assert.match(app, /preventScroll: true/);
  assert.match(css, /\.layout\.mode-apne > \.apne-daily-view/);
  assert.match(css, /\.layout\.mode-apne > \.player/);
  assert.match(app, /const expanded = state\.apneDaily\.expandedByShow\[show\.id\] === true/);
  assert.match(app, /'<details class="apne-show-card /);
  assert.match(app, /<summary class="apne-show-toggle">/);
  assert.match(app, /<div class="apne-show-content">/);
  assert.match(app, /'<\/details>'/);
  assert.match(css, /\.apne-show-card\[open\] \.apne-show-chevron/);
  assert.match(css, /\.apne-show-toggle:focus-visible/);
  assert.match(app, /data-act="' \+ action/);
  assert.match(app, /historyHtml/);
});

test("APNE Daily uses one Available label and routes live playback or downloads through a source-agnostic backend", () => {
  const player=fs.readFileSync(new URL("../public/apne-live-player.js", import.meta.url),"utf8");
  assert.match(apneDailySource, /parsePlayApneTargetFromEpisodeHtml/);
  assert.match(apneDailySource, /parsePlayApneMp4/);
  assert.match(apneDailySource, /await checkApneMp4Range/);
  assert.match(apneDailySource, /hlsUrl: resolved.hlsUrl \|\| resolved.mp4Url/);
  assert.match(apneDailySource, /link: "Available"/);
  assert.match(app, /recentStatus === "Available"/);
  assert.match(server, /app\.get\("\/apne\/live\/source\/:showId\/:dateKey"/);
  assert.match(server, /app\.get\("\/apne\/live\/mp4\/:token"/);
  assert.match(server, /requireApneNativeAccess/);
  assert.match(player, /source.format === 'mp4'/);
  assert.match(player, /hls.loadSource\(source.src\)/);
  assert.match(server, /data-source="\$\{unifiedSource\}"/);
});

test("APNE Daily offers native Stream actions and routes unsaved episodes to live HLS", () => {
  assert.match(app, /data-act=\"stream-apne\"/);
  assert.match(app, /function streamApneLiveEpisode\(showId, dateKey, resume = false\)/);
  assert.match(app, /streamApneLiveEpisode\(card\.dataset\.showId, button\.dataset\.dateKey, resume\)/);
  assert.match(app, /https:\/\/stream\.ameshalex\.com\/apne\/live\/watch\//);
  assert.match(app, /recent\.dateKey && !streamOnly \? '<button class=/);
  assert.match(app, /episode\.dateKey \? '<button class=/);
  assert.match(server, /app\.get\("\/apne\/live\/watch\/:showId\/:dateKey"/);
  assert.match(server, /app\.get\("\/apne\/live\/playlist\/:showId\/:dateKey\.m3u8"/);
  assert.match(server, /app\.get\("\/apne\/live\/media\/:session\/:asset"/);
  assert.match(server, /resolveApneEpisodeByDate/);
  assert.match(server, /requireApneNativeAccess/);
  assert.match(app, /function streamApneNativeItem\(itemId, resume = false\)/);
  assert.match(app, /https:\/\/stream\.ameshalex\.com\/apne\/watch\//);
  assert.match(app, /recent\.dateKey && !streamOnly \? '<button class=/);
  assert.match(app, /episode\.dateKey \? '<button class=/);
  assert.match(server, /app\.get\("\/apne\/watch\/:itemId"/);
  assert.match(server, /app\.get\("\/apne\/native-media\/:itemId\.mp4"/);
  assert.match(server, /createCastAccess/);
  assert.match(server, /requireApneNativeAccess/);
  assert.match(server, /APNE_NATIVE_LOOPBACK_PREVIEW === "1"/);
  assert.match(server, /found\.item\.meta\?\.source !== "apnetv"/);
  assert.match(server, /await fs\.realpath\(config\.libraryDir\)/);
  assert.match(server, /acceptRanges: true/);
  assert.match(server, /controls playsinline preload="metadata"/);
  assert.match(server, /Content-Disposition": "inline"/);
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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  APNE_UPSTREAM_VIDEO_MISSING,
  parseMediagramingHlsFromHtml,
  resolveApneEpisodeDirect,
} from "../src/lib/apne-daily.js";
import { summarizeApneSourceError } from "../src/lib/apne-source-availability.js";

const errorPage = '<div class="error-box">Error: No master-playlist.m3u8 stream found.</div>';
const episodeUrl = "https://apnetv.xyz/Hindi-Serial/show/286636/Anupamaa";
const safeMp4 = "https://sto.vkcdn5.com/abcdefghijklmnopqrstuvwxy0123456/v.mp4";
const playerEmbed = "https://vkspeed.com/embed-foootoy4ccs9.html";
const id1 = "0123456789abcdef0123456789abcdef";
const id2 = "1123456789abcdef0123456789abcdef";
const episodeHtml = `<div class="flash_link" data-id="${id1}" data-href="https://newsportaling.com/finnance-primary">Flash Link</div><div class="flash_link" data-id="${id2}" data-href="https://newscurting.com/savvings-playapne">PlayApne Link</div>`;
const sourceFromEpisode = '<div class="flash_link" data-id="0123456789abcdef0123456789abcdef" data-href="https://newsportaling.com/finnance-primary">Flash Link</div>';
const mediaPlayerFrame = '<iframe src="https://mediagraming.com/player.php?id=test"></iframe>';
const pack = (plain) => {
  const words = plain.split(/\W+/).filter(Boolean);
  const dict = [...new Set(words)];
  const encoded = plain.replace(/\b\w+\b/g, (word) => dict.indexOf(word).toString(36));
  return `eval(function(p,a,c,k,e,d){return p}('${encoded}',36,${dict.length},'${dict.join("|")}'.split('|')))`;
};

async function withFetch(handler, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => handler(String(url), options);
  try { return await run(); } finally { globalThis.fetch = previous; }
}

function response(body, status = 200, headers = {}) { return new Response(body, { status, headers }); }

test("exact visible player error is typed after failed PlayApne fallback and retains the parser error", async () => {
  const requests = [];
  await withFetch(async (url) => {
    requests.push(url);
    if (url === episodeUrl) return response(episodeHtml);
    if (url.includes("newsportaling.com")) return response(`<script>myRedirect("https://mediagraming.com/episode/", "id", "${id1}");</script>`);
    if (url.includes("mediagraming.com/episode")) return response(mediaPlayerFrame);
    if (url.includes("mediagraming.com/player.php")) return response(errorPage);
    if (url.includes("newscurting.com")) return response("alternate unavailable");
    throw new Error(`unexpected URL ${url}`);
  }, async () => {
    await assert.rejects(resolveApneEpisodeDirect(episodeUrl, { showId: "anupamaa", dateKey: "2026-10-01", apneOnly: true }), (error) => {
      assert.equal(error.code, APNE_UPSTREAM_VIDEO_MISSING);
      assert.equal(error.message, "Mediagraming HLS source was not found.");
      return true;
    });
  });
  assert.ok(requests.some((url) => url.includes("mediagraming.com/player.php")), "fetched the player containing the observed page");
  assert.ok(requests.some((url) => url.includes("newscurting.com")), "PlayApne fallback was attempted before final throw");
});

test("generic no-source parser failure and transient HTTP 503 remain untyped", async () => {
  await withFetch(async (url) => {
    if (url === episodeUrl) return response(sourceFromEpisode);
    if (url.includes("newsportaling.com")) return response(`<script>myRedirect("https://mediagraming.com/episode/", "id", "${id1}");</script>`);
    if (url.includes("mediagraming.com/episode")) return response(mediaPlayerFrame);
    if (url.includes("mediagraming.com/player.php")) return response("<html>generic upstream markup</html>");
    throw new Error(`unexpected URL ${url}`);
  }, async () => {
    await assert.rejects(resolveApneEpisodeDirect(episodeUrl, { apneOnly: true }), (error) => {
      assert.equal(error.code, undefined);
      assert.equal(error.message, "Mediagraming HLS source was not found.");
      return true;
    });
  });

  await withFetch(async (url) => {
    if (url === episodeUrl) return response(sourceFromEpisode);
    if (url.includes("newsportaling.com")) return response(`<script>myRedirect("https://mediagraming.com/episode/", "id", "${id1}");</script>`);
    if (url.includes("mediagraming.com/episode")) return response("", 503);
    throw new Error(`unexpected URL ${url}`);
  }, async () => {
    await assert.rejects(resolveApneEpisodeDirect(episodeUrl, { apneOnly: true }), (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /HTTP 503/);
      return true;
    });
  });
});

test("hidden error-box text cannot override a valid source in the same page", () => {
  const html = `<div class="error-box" hidden>${errorPage}</div><script>var videoUrl="https://cdn.justfingram.com/hls/master.m3u8";</script>`;
  assert.equal(parseMediagramingHlsFromHtml(html), "https://cdn.justfingram.com/hls/master.m3u8");
});

test("legacy and XOR encoded HLS parsing stay supported", () => {
  assert.equal(parseMediagramingHlsFromHtml('<iframe src="https://mediagraming.com/new/video.php/?url=https%3A%2F%2Fs2.videoapne.to%2Fhls%2Fmaster.m3u8"></iframe>'), "https://s2.videoapne.to/hls/master.m3u8");
  const url = "https://cdn.justfingram.com/hls/master.m3u8";
  const key = "abc";
  const bytes = Buffer.from([...Buffer.from(url)].map((byte, i) => byte ^ key.charCodeAt(i % key.length))).toString("base64");
  const encoded = `<script>var k="${key}";function decodeUrl(s){var a=atob(s);for(var i=0;i<a.length;i++){a[i]=String.fromCharCode(a.charCodeAt(i)^k.charCodeAt(i%k.length));}return a;}var videoUrl=decodeUrl("${bytes}");</script>`;
  assert.equal(parseMediagramingHlsFromHtml(encoded), url);
});

test("PlayApne success wins over the typed primary error", async () => {
  await withFetch(async (url, options) => {
    if (url === episodeUrl) return response(episodeHtml);
    if (url.includes("newsportaling.com")) return response(`<script>myRedirect("https://mediagraming.com/episode/", "id", "${id1}");</script>`);
    if (url.includes("mediagraming.com/episode")) return response(mediaPlayerFrame);
    if (url.includes("mediagraming.com/player.php")) return response(errorPage);
    if (url.includes("newscurting.com")) return response(`<script>myRedirect("https://mediagraming.com/alternate/", "id", "${id2}");</script>`);
    if (url.includes("mediagraming.com/alternate")) return response(`<iframe src="${playerEmbed}"></iframe>`);
    if (url === playerEmbed) return response(pack(`jwplayer().setup({sources:[{file:"${safeMp4}",label:"720p"}]})`));
    if (url === safeMp4) return response("", 206, { "content-type": "video/mp4", "content-range": "bytes 0-1023/4096" });
    throw new Error(`unexpected URL ${url}`);
  }, async () => {
    const resolved = await resolveApneEpisodeDirect(episodeUrl, { showId: "anupamaa", dateKey: "2026-10-01", apneOnly: true });
    assert.equal(resolved.mp4Url, safeMp4);
  });
});

test("availability and live source route expose only the static typed-error response", async () => {
  assert.deepEqual(summarizeApneSourceError(Object.assign(new Error("provider internals"), { code: APNE_UPSTREAM_VIDEO_MISSING })), {
    state: "unavailable",
    detail: "APNE's provider has no playable video for this episode. Check again later.",
  });
  assert.equal(summarizeApneSourceError(new Error("provider internals")).state, "error");

  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const body = server.match(/app\.get\("\/apne\/live\/source\/:[\s\S]*?asyncH\(async \(req, res\) => \{([\s\S]*?)\n\}\)\);/)?.[1];
  assert.ok(body, "found live source route body");
  const codedError = Object.assign(new Error("provider internals"), { code: APNE_UPSTREAM_VIDEO_MISSING });
  const context = {
    apneDaily: { resolveApneEpisodeByDate: async () => { throw codedError; } },
    apneMp4Relay: {}, apneLiveRelay: {}, apneManifestSession: () => "unused",
  };
  const route = vm.runInNewContext(`(async (req, res) => {${body}\n})`, context);
  const result = { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return this; } };
  await route({ params: { showId: "anupamaa", dateKey: "2026-10-01" }, query: {} }, result);
  assert.equal(result.statusCode, 502);
  assert.equal(JSON.stringify(result.payload), JSON.stringify({
    code: "APNE_UPSTREAM_VIDEO_MISSING",
    error: "APNE's provider has no playable video for this episode. Check again later.",
  }));

  const unrelated = new Error("other failure");
  context.apneDaily.resolveApneEpisodeByDate = async () => { throw unrelated; };
  await assert.rejects(route({ params: { showId: "anupamaa", dateKey: "2026-10-01" }, query: {} }, result), (error) => error === unrelated);
});

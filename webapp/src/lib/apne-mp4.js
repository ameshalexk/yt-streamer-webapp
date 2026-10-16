// Strict, no-eval extraction of a supported APNE alternate MP4 player.
// Never run provider JavaScript, follow redirects, or accept caller-provided URLs.
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const MP4_HOST = 'sto.vkcdn5.com';
const MP4_PATH = /^\/[A-Za-z0-9_-]{12,120}\/v\.mp4$/;

export function validatedApneMp4(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== MP4_HOST || url.port ||
      url.username || url.password || url.search || url.hash || !MP4_PATH.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

export function parsePlayApneEmbed(html) {
  const iframes = String(html || '').matchAll(/<iframe\b[^>]*\bsrc=['"]([^'"<>]+)['"][^>]*>/gi);
  for (const found of iframes) {
    try {
      const url = new URL(found[1]);
      if (url.protocol === 'https:' && url.hostname === 'vkspeed.com' &&
        !url.username && !url.password && !url.port && !url.search && !url.hash &&
        /^\/embed-[a-z0-9]{8,25}\.html$/.test(url.pathname)) return url.href;
    } catch {}
  }
  return null;
}

export function parsePlayApneMp4(html, preference = 'best') {
  const code = String(html || '');
  if (code.length > 100000) throw new Error('Alternate player exceeds extraction limits');
  const packed = code.match(/\}\('((?:\\.|[^'\\])*)',(\d+),(\d+),'((?:\\.|[^'\\])*)'\.split\('\|'\)\)\)/s);
  if (!packed || Number(packed[2]) !== 36 || Number(packed[3]) > 240 || packed[1].length > 12000)
    throw new Error('Unsupported alternate player format');
  const words = packed[4].split('|');
  if (words.length > 250) throw new Error('Alternate player dictionary too large');
  let decoded = packed[1];
  // Plain text substitution only: never eval or execute any provider code.
  for (let i = Number(packed[3]) - 1; i >= 0; i -= 1) {
    if (words[i]) decoded = decoded.replace(new RegExp('\\b' + i.toString(36) + '\\b', 'g'), words[i]);
  }
  const sources = decoded.match(/\bsources:\[([^\]\r\n]{1,2200})\]/);
  if (!sources) throw new Error('Alternate video sources missing');
  const found = [...sources[1].matchAll(/\bfile:"([^"]+)"\s*,\s*label:"(720p|360p|192p)"/g)]
    .map((m) => ({ url: validatedApneMp4(m[1]), quality: Number.parseInt(m[2], 10) }))
    .filter((item) => item.url)
    .sort((a, b) => b.quality - a.quality);
  if (!found.length) throw new Error('Unsupported alternate media URL');
  // iPhone Safari may need the smaller APNE variant: the upstream CDN can
  // be slower than the higher-bitrate file. Prefer 192p only if offered.
  return (preference === 'low' ? found.find((item) => item.quality <= 192) : null)?.url || found[0].url;
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145 Safari/537.36';
export async function checkApneMp4Range(mp4Url, referer, fetchImpl = fetch) {
  const safe = validatedApneMp4(mp4Url);
  if (!safe || !/^https:\/\/vkspeed\.com\/embed-[a-z0-9]{8,25}\.html$/.test(referer || ''))
    throw new Error('Invalid alternate media URL');
  const resp = await fetchImpl(safe, {
    headers: {Range:'bytes=0-1023', Referer:referer, 'User-Agent':USER_AGENT},
    redirect:'manual',signal:AbortSignal.timeout(15000),
  });
  if (resp.status !== 206 || resp.redirected || !/^video\/mp4\b/i.test(resp.headers.get('content-type') || '') ||
      !/^bytes 0-\d{1,4}\/\d{3,15}$/.test(resp.headers.get('content-range') || '')) {
    try { await resp.body?.cancel(); } catch {}
    throw new Error('Alternate media is not currently reachable');
  }
  try { await resp.body?.cancel(); } catch {}
  return true;
}

// Limit each provider read to 1 MiB. The APNE alternate CDN currently
// delivers roughly 30 KiB/s: its ~865 KiB MP4 metadata atom can take
// >24 seconds. Bounding each range keeps transfers within the relay timeout,
// while Safari can request the following byte range after receiving the first.
export function boundedApneMp4Range(range, maxBytes = 1024 * 1024) {
  if (!range) return `bytes=0-${maxBytes - 1}`;
  const suffix = /^bytes=-(\d+)$/.exec(String(range));
  if (suffix) {
    const count = Number(suffix[1]);
    return Number.isSafeInteger(count) && count > 0 ? `bytes=-${Math.min(count,maxBytes)}` : null;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(range));
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === '' ? start + maxBytes - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
  return `bytes=${start}-${Math.min(end, start + maxBytes - 1)}`;
}

export function createApneMp4Relay({fetchImpl = fetch, now = Date.now} = {}) {
  const sessions = new Map();
  const TTL = 2 * 60 * 60000;
  function open({mp4Url,referer}) {
    const url = validatedApneMp4(mp4Url);
    if (!url || !/^https:\/\/vkspeed\.com\/embed-[a-z0-9]{8,25}\.html$/.test(referer || ''))
      throw Object.assign(new Error('Unsupported media source'), {status:502});
    for (const [key, record] of sessions) if (record.expires < now()) sessions.delete(key);
    while (sessions.size >= 12) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(16).toString('hex');
    sessions.set(id,{url,referer,expires:now()+TTL});
    return '/apne/live/mp4/' + id;
  }
  async function media(req,res) {
    const id = String(req.params.token || '');
    const record = sessions.get(id);
    if (!/^[a-f0-9]{32}$/.test(id) || !record) return res.status(404).end();
    if (record.expires < now()) {sessions.delete(id);return res.status(410).end();}
    const headOnly = req.method === 'HEAD';
    const range = headOnly ? 'bytes=0-0' : boundedApneMp4Range(req.get('range'));
    if (!range) return res.status(416).end();
    let response;
    try {
      response=await fetchImpl(record.url,{
        headers:{Range:range,Referer:record.referer,'User-Agent':USER_AGENT},
        redirect:'manual',signal:AbortSignal.timeout(90000),
      });
    } catch {return res.status(502).end();}
    if (response.status !== 206 || response.redirected ||
        !/^video\/mp4\b/i.test(response.headers.get('content-type') || '') ||
        !/^bytes \d+-\d+\/\d+$/.test(response.headers.get('content-range') || '')) {
      try {await response.body?.cancel();}catch{}
      return res.status(502).end();
    }
    if (headOnly) {
      const total = response.headers.get('content-range').split('/').at(-1);
      try {await response.body?.cancel();} catch {}
      return res.status(200).set({
        'Content-Type':'video/mp4', 'Content-Length':total,
        'Accept-Ranges':'bytes', 'Cache-Control':'private, no-store, max-age=0',
      }).end();
    }
    for (const key of ['content-length','content-range','accept-ranges']) {
      const value=response.headers.get(key);if(value)res.set(key,value);
    }
    res.set({'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'private, no-store, max-age=0'});
    res.status(206);
    if (!response.body)return res.end();
    const reader=Readable.fromWeb(response.body);
    res.on('close',()=>{if(!res.writableEnded)reader.destroy();});
    reader.on('error',()=>res.end());
    reader.pipe(res);
  }
  return {open,media};
}

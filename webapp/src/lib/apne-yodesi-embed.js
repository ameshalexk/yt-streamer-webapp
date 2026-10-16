// Source fallback after APNE's own HLS and PlayApne MP4 have both failed.
// Match show/date EXACTLY using YoDesi's WordPress catalog. Only embed public
// Blogger videos; never evaluate provider scripts, proxy media, or download MP4.
const SITE = 'https://yodesi-online.com';
const SHOWS = Object.freeze({
  anupamaa: {slug:'anupama',title:'Anupama'},
  'seher-hone-ko-hai': {slug:'seher-hone-ko-hai',title:'Seher Hone Ko Hai'},
  'dr-aarambhi': {slug:'dr-aarambhi',title:'Dr Aarambhi'},
  'udne-ki-aasha': {slug:'udne-ki-aasha',title:'Udne Ki Aasha'},
  'mannat-har-khushi-paane-ki': {slug:'mannat-har-khushi-paane-ki',title:'Mannat Har Khushi Paane Ki'},
});
const FIXED_ARTICLES = Object.freeze({
  'anupamaa:2026-09-25':'https://yodesi-online.com/anupama-25th-september-2026-full-episode-2148/',
  'anupamaa:2026-09-26':'https://yodesi-online.com/anupama-26th-september-2026-full-episode-2149/',
});
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145 Safari/537.36';
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
const discoveryCache = new Map();
const discoveryPending = new Map();

export function supportedYoDesiShows(){ return Object.keys(SHOWS); }
export function yodesiArticleFor(showId,dateKey){
  return Object.hasOwn(FIXED_ARTICLES,`${showId}:${dateKey}`)?FIXED_ARTICLES[`${showId}:${dateKey}`]:null;
}

function dateInfo(dateKey){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey||''))return null;
  const date=new Date(dateKey+'T00:00:00Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==dateKey)return null;
  // Callers already validate against APNE's three-month episode history.
  const day=date.getUTCDate();
  const ordinal=day+(day%100>=11&&day%100<=13?'th':({1:'st',2:'nd',3:'rd'}[day%10]||'th'));
  const month=MONTHS[date.getUTCMonth()];const year=date.getUTCFullYear();
  return {date,day,ordinal,month,year,slug:`${ordinal}-${month}-${year}`,label:`${ordinal} ${month} ${year}`};
}

function plainTitle(value){
  return String(value||'').replace(/<[^>]*>/g,' ').replace(/&amp;/gi,'&').replace(/&#0*39;|&apos;/gi,"'").replace(/&quot;/gi,'"')
    .replace(/&nbsp;/gi,' ').replace(/[.\-_]+/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
}

export function matchesYoDesiEpisodeTitle(title,showId,dateKey){
  const show=SHOWS[showId],date=dateInfo(dateKey);
  if(!show||!date)return false;
  const exact=plainTitle(`${show.title} ${date.label} Full Episode`);
  // The original article HTML adds " | Yo Desi Online" to the page title,
  // whereas the WordPress search API omits that suffix.
  const pageTitle=plainTitle(title).replace(/\s*\|\s*yo desi online$/,'');
  return pageTitle===exact || (pageTitle.startsWith(exact+' ')&&/^\d{1,6}$/.test(pageTitle.slice(exact.length+1)));
}

export function validYoDesiArticle(value,showId,dateKey){
  const show=SHOWS[showId],date=dateInfo(dateKey);
  if(!show||!date)return null;
  try{
    const u=new URL(value);
    if(u.protocol!=='https:'||u.hostname!=='yodesi-online.com'||u.username||u.password||u.port||u.search||u.hash)return null;
    const prefix=`/${show.slug}-${date.slug}-full-episode`;
    if(!new RegExp('^'+prefix+'(?:-\\d{1,6})?/$').test(u.pathname))return null;
    return u.href;
  }catch{return null;}
}

export function validVidupEmbed(value){
  try {
    const u=new URL(String(value||'').replace(/&amp;/gi,'&'));
    const cd=(u.searchParams.get('cd')||'').replace(/ /g,'+');
    return u.protocol==='https:'&&u.hostname==='vidup.site'&&!u.port&&!u.username&&!u.password&&!u.hash&&
      ['/play','/play/'].includes(u.pathname)&&cd.length>=40&&cd.length<=600&&/^[A-Za-z0-9+/=]+$/.test(cd)&&
      [...u.searchParams.keys()].every(k=>k==='cd'||k==='autoplay')&&['1',null].includes(u.searchParams.get('autoplay'))?u.href:null;
  }catch{return null;}
}

export function validBloggerEmbed(value){
  try {
    const u=new URL(String(value||'').replace(/&amp;/gi,'&'));
    const token=u.searchParams.get('token')||'';
    return u.protocol==='https:'&&u.hostname==='www.blogger.com'&&u.pathname==='/video.g'&&
      !u.port&&!u.username&&!u.password&&!u.hash&&/^[A-Za-z0-9_-]{50,400}$/.test(token)&&
      [...u.searchParams.keys()].every(k=>k==='token'||k==='autoplay')&&['1',null].includes(u.searchParams.get('autoplay'))?u.href:null;
  }catch{return null;}
}

export function extractYoDesiPlayers(html,dateKey='2026-09-25',showId='anupamaa'){
  const text=String(html||'');
  const title=text.match(/<title[^>]*>([^<]{1,220})<\/title>/i)?.[1];
  if(!matchesYoDesiEpisodeTitle(title,showId,dateKey))throw Error('Episode date/title did not match fallback');
  const links=[...text.matchAll(/<iframe\b[^>]*\bsrc=['"]([^'"<>]{1,1000})['"][^>]*>/gi)]
    .map(m=>validVidupEmbed(m[1])).filter(Boolean);
  const fixedCount = showId === 'anupamaa' && dateKey === '2026-09-25' ? 2 :
    showId === 'anupamaa' && dateKey === '2026-09-26' ? 3 : null;
  if(links.length<1||links.length>4||new Set(links).size!==links.length||
      (fixedCount!==null&&links.length!==fixedCount))
    throw Error('Expected episode parts not found');
  return links;
}

export function extractBloggerPlayer(html){
  const url=[...String(html||'').matchAll(/<iframe\b[^>]*\bsrc=['"]([^'"<>]{1,1000})['"][^>]*>/gi)]
    .map(m=>validBloggerEmbed(m[1])).find(Boolean);
  if(!url)throw Error('Embedded video not found');
  return url;
}

async function boundedText(response,contentType,limit){
  if(response.status!==200||response.redirected||!(response.headers.get('content-type')||'').toLowerCase().startsWith(contentType)){
    try{await response.body?.cancel()}catch{};throw Error('Fallback response unavailable');
  }
  const size=Number(response.headers.get('content-length'));
  if(size>limit){try{await response.body?.cancel()}catch{};throw Error('Fallback content too large')}
  if(!response.body)throw Error('Missing fallback response');
  const reader=response.body.getReader();let bytes=0,result='';const decoder=new TextDecoder();
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit)throw Error('Fallback response exceeds limit');result+=decoder.decode(value,{stream:true})}result+=decoder.decode()}
  finally{try{await reader.cancel()}catch{}}
  return result;
}

async function requestText(url,referer,fetchImpl,article,redirects=0){
  if(url!==article&&!validVidupEmbed(url)&&!validBloggerEmbed(url))throw Error('Unapproved fallback URL');
  const response=await fetchImpl(url,{headers:{'User-Agent':UA,Referer:referer,Accept:'text/html,*/*'},redirect:'manual',signal:AbortSignal.timeout(14000)});
  if([301,302,307,308].includes(response.status)&&redirects===0){
    const next=new URL(response.headers.get('location')||'',url).href;
    if(validVidupEmbed(next)){
      try{await response.body?.cancel()}catch{}
      return requestText(next,referer,fetchImpl,article,1);
    }
  }
  return boundedText(response,'text/html',250000);
}

export function selectYoDesiSearchResult(items,showId,dateKey){
  if(!Array.isArray(items)||items.length>25)return null;
  const match=items.filter(item=>item&&typeof item==='object'&&
    matchesYoDesiEpisodeTitle(item.title,showId,dateKey)&&validYoDesiArticle(item.url,showId,dateKey));
  if(match.length!==1)return null; // ambiguous results must never select the wrong episode
  return validYoDesiArticle(match[0].url,showId,dateKey);
}

export async function discoverYoDesiArticle(showId,dateKey,{fetchImpl=fetch,now=Date.now,cache=true}={}){
  const show=SHOWS[showId],date=dateInfo(dateKey);
  if(!show||!date)throw Error('Unsupported fallback show or date');
  const key=showId+':'+dateKey;
  if(cache){const previous=discoveryCache.get(key);if(previous&&previous.until>now())return previous.url;
    if(discoveryPending.has(key))return discoveryPending.get(key);
  }
  const job=(async()=>{
    const query=`${show.title} ${date.label}`;
    const api=new URL('/wp-json/wp/v2/search',SITE);
    api.searchParams.set('search',query);api.searchParams.set('per_page','20');
    const response=await fetchImpl(api.href,{headers:{'User-Agent':UA,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(15000)});
    const text=await boundedText(response,'application/json',150000);
    let results;try{results=JSON.parse(text)}catch{throw Error('Invalid fallback search response')}
    const article=selectYoDesiSearchResult(results,showId,dateKey);
    if(cache){if(discoveryCache.size>=128)discoveryCache.delete(discoveryCache.keys().next().value);
      discoveryCache.set(key,{url:article,until:now()+(article?6:1)*3600000})}
    return article;
  })();
  if(cache)discoveryPending.set(key,job);
  try{return await job}finally{if(cache&&discoveryPending.get(key)===job)discoveryPending.delete(key)}
}

export async function resolveYoDesiEmbed(showId,dateKey,{fetchImpl=fetch,now=Date.now,cache=true}={}){
  if(!SHOWS[showId]||!dateInfo(dateKey))throw Error('No supported fallback show/date');
  const article=yodesiArticleFor(showId,dateKey)||await discoverYoDesiArticle(showId,dateKey,{fetchImpl,now,cache});
  if(!article)throw Error('No matching Yodesi episode published');
  if(!validYoDesiArticle(article,showId,dateKey))throw Error('Invalid matched episode URL');
  const html=await requestText(article,SITE+'/',fetchImpl,article);
  const parts=extractYoDesiPlayers(html,dateKey,showId);
  const frames=[];
  for(const part of parts){
    const player=await requestText(part,article,fetchImpl,article);
    const embed=extractBloggerPlayer(player);
    const checked=await requestText(embed,part,fetchImpl,article);
    if(!/Blogger video player/i.test(checked)&&!/video\.g/i.test(checked))throw Error('Embedded video unavailable');
    frames.push(embed);
  }
  return {format:'embed',embedUrls:frames};
}

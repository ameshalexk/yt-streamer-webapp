// Episode-specific artwork for a precisely matched subset of Anupamaa.
// Sky's public catalog exposes individual episode stills: using these instead
// of rehydrating large iCloud placeholders or downloading the video itself.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SERIES = 'https://www.sky.com/watch/series/16f8285a-09c0-4b5b-812b-12c154d2c9f4';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const MAX_PAGE = 1200 * 1024;
const MAX_IMAGE = 1024 * 1024;
const CACHE_DAYS = 30;
const PREVIEW_DATES = Object.freeze({
 '2026-09-23':2150,
 '2026-09-24':2151,
 '2026-09-25':2152,
 '2026-09-26':2153,
 '2026-09-27':2154,
 '2026-09-28':2155,
});

export function officialArtworkEpisode(showId,dateKey) {
 if (showId!=='anupamaa') return null;
 return Object.hasOwn(PREVIEW_DATES,dateKey) ? PREVIEW_DATES[dateKey] : null;
}

export function parseSkyEpisodeImages(html) {
 if (typeof html!=='string'||Buffer.byteLength(html)>MAX_PAGE) throw Error('Invalid official episode listing');
 const result=new Map();
 for(const match of html.matchAll(/data-testid="episode-card-number-(\d{3,5})"/g)) {
  const n=Number(match[1]);
  const previous=html.slice(Math.max(0,match.index-2700),match.index);
  const images=[...previous.matchAll(/imageservice\.sky\.com\/uuid\/([a-f0-9-]{36})\/16-9\/(?:\d{2,4})/g)];
  const id=images.at(-1)?.[1];
  if(id&&UUID.test(id))result.set(n,id);
 }
 return result;
}

async function boundedResponse(res,maxBytes,expectedType) {
 if(res.status!==200||res.redirected||res.headers.get('content-type')?.split(';')[0]!==expectedType) {
  try{await res.body?.cancel()}catch{}
  throw Error('Unusable artwork response');
 }
 const stated=Number(res.headers.get('content-length'));
 if(stated&&stated>maxBytes){try{await res.body?.cancel()}catch{};throw Error('Artwork response too large')}
 if(!res.body)throw Error('Artwork response empty');
 const reader=res.body.getReader();const chunks=[];let total=0;
 try {for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>maxBytes)throw Error('Artwork response size exceeded');chunks.push(Buffer.from(value))}}
 finally{try{await reader.cancel()}catch{}}
 return Buffer.concat(chunks,total);
}

export function createApneOfficialArtwork({cacheDir,fetchImpl=fetch,now=Date.now}={}) {
 if(!cacheDir)throw TypeError('cacheDir required');
 const pending=new Map(),cooldowns=new Map();let listing=null;let listingUntil=0;let listingRequest=null;
 async function getMap(){
  if(listing&&now()<listingUntil)return listing;
  if(listingRequest)return listingRequest;
  listingRequest=(async()=>{
    const res=await fetchImpl(SERIES,{redirect:'manual',headers:{'User-Agent':'Mozilla/5.0 Chrome/145 Safari/537.36',Accept:'text/html'},signal:AbortSignal.timeout(18000)});
    const body=await boundedResponse(res,MAX_PAGE,'text/html');
    const map=parseSkyEpisodeImages(body.toString('utf8'));
    if(![2150,2151,2152,2153,2154,2155].every(n=>map.has(n)))throw Error('Official episode still listing incomplete');
    listing=map;listingUntil=now()+12*3600000;
    return map;
  })();
  try{return await listingRequest}finally{listingRequest=null}
 }
 async function ready(file){
  const stat=await fs.lstat(file).catch(()=>null);
  return Boolean(stat?.isFile()&&!stat.isSymbolicLink()&&stat.size>100&&stat.size<MAX_IMAGE&&now()-stat.mtimeMs<CACHE_DAYS*86400000);
 }
 async function build(dateKey,episode){
  const map=await getMap();const id=map.get(episode);
  if(!UUID.test(id||''))throw Error('Official episode artwork unavailable');
  const asset=`https://imageservice.sky.com/uuid/${id}/16-9/500`;
  const resp=await fetchImpl(asset,{redirect:'manual',headers:{'User-Agent':'Mozilla/5.0 Chrome/145 Safari/537.36',Accept:'image/jpeg'},signal:AbortSignal.timeout(16000)});
  const image=await boundedResponse(resp,MAX_IMAGE,'image/jpeg');
  if(image.length<100||image[0]!==0xff||image[1]!==0xd8||image.at(-2)!==0xff||image.at(-1)!==0xd9)throw Error('Invalid JPEG image');
  await fs.mkdir(cacheDir,{recursive:true,mode:0o700});
  const root=await fs.realpath(cacheDir);
  const file=path.join(root,dateKey+'-official-v1.jpg');
  const tmp=path.join(root,'.'+dateKey+'-'+crypto.randomUUID()+'.tmp');
  try{await fs.writeFile(tmp,image,{flag:'wx',mode:0o600});await fs.rename(tmp,file)}finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
 }
 async function request(showId,dateKey){
  const n=officialArtworkEpisode(showId,dateKey);
  if(!n)return {status:'missing'};
  const file=path.join(cacheDir,dateKey+'-official-v1.jpg');
  if(await ready(file))return {status:'ready',file};
  if(pending.has(dateKey))return {status:'pending'};
  if((cooldowns.get(dateKey)||0)>now())return {status:'cooldown'};
  if(pending.size>=6)return {status:'busy'};
  const job=build(dateKey,n).then(()=>cooldowns.delete(dateKey)).catch(()=>cooldowns.set(dateKey,now()+10*60*1000)).finally(()=>pending.delete(dateKey));
  pending.set(dateKey,job);
  return {status:'pending'};
 }
 return {request,stats:()=>({pending:pending.size,imagesCached:listing?.size||0})};
}

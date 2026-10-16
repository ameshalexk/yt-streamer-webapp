import test from 'node:test';
import assert from 'node:assert/strict';
import {
 yodesiArticleFor, validVidupEmbed, validBloggerEmbed,
 extractYoDesiPlayers, extractBloggerPlayer, resolveYoDesiEmbed,
 supportedYoDesiShows, matchesYoDesiEpisodeTitle, validYoDesiArticle,selectYoDesiSearchResult,discoverYoDesiArticle,
} from '../src/lib/apne-yodesi-embed.js';

const p1='https://vidup.site/play?cd='+('Ab0+/' .repeat(15))+'==&autoplay=1';
const p2='https://vidup.site/play?cd='+('Xz1+/' .repeat(15))+'==&autoplay=1';
const p3='https://vidup.site/play?cd='+('Qr2+/' .repeat(15))+'==&autoplay=1';
const blogger='https://www.blogger.com/video.g?token='+('AbCdEF1234_-' .repeat(9))+'&autoplay=1';

test('Fallback is configured only for the two confirmed, exact dated episodes',()=>{
 assert.equal(yodesiArticleFor('anupamaa','2026-09-25'),'https://yodesi-online.com/anupama-25th-september-2026-full-episode-2148/');
 assert.equal(yodesiArticleFor('anupamaa','2026-09-26'),'https://yodesi-online.com/anupama-26th-september-2026-full-episode-2149/');
 for(const params of [['anupamaa','2026-09-27'],['dr-aarambhi','2026-09-25'],['anupamaa','2026-09-24']])assert.equal(yodesiArticleFor(...params),null);
});

test('Vidup and Blogger frame validators reject arbitrary origins, ports, paths and parameters',()=>{
 assert.equal(validVidupEmbed(p1),p1);
 assert.equal(validBloggerEmbed(blogger),blogger);
 for(const bad of [p1.replace('vidup.site','vidup.site.attacker.org'),p1.replace('https:','http:'),p1+'&redirect=https://evil.example',p1.replace('/play','/admin')])assert.equal(validVidupEmbed(bad),null);
 for(const bad of [blogger.replace('www.blogger.com','blogger.com.attacker.org'),blogger.replace('https:','http:'),blogger+'&next=https://evil.example',blogger.replace('video.g','other.g')])assert.equal(validBloggerEmbed(bad),null);
});

test('Two or three uniquely identified episode parts with the exact dated title are required',()=>{
 const html=`<title>Anupama 25th September 2026 Full Episode 2148</title><iframe src="${p1}"></iframe><iframe src="${p2}"></iframe>`;
 assert.deepEqual(extractYoDesiPlayers(html),[p1,p2]);
 assert.throws(()=>extractYoDesiPlayers(html.replace('25th','26th')),/date\/title/);
 assert.throws(()=>extractYoDesiPlayers(html.replace(p2,p1)),/Expected episode parts/);
 assert.throws(()=>extractYoDesiPlayers(html.replace(`<iframe src="${p2}"></iframe>`,'<iframe src="https://evil.example/x"></iframe>')),/Expected episode parts/);
 const three=`<title>Anupama 26th September 2026 Full Episode 2149</title><iframe src="${p1}"></iframe><iframe src="${p2}"></iframe><iframe src="${p3}"></iframe>`;
 assert.deepEqual(extractYoDesiPlayers(three,'2026-09-26'),[p1,p2,p3]);
 assert.throws(()=>extractYoDesiPlayers(three,'2026-09-25'),/date\/title/);
 assert.throws(()=>extractYoDesiPlayers(three.replace(`<iframe src="${p3}"></iframe>`,''),'2026-09-26'),/Expected episode parts/);
 assert.throws(()=>extractYoDesiPlayers(three.replace(p3,p2),'2026-09-26'),/Expected episode parts/);
 assert.equal(extractBloggerPlayer(`<iframe src="${blogger.replaceAll('&','&amp;')}"></iframe>`),blogger);
 assert.throws(()=>extractBloggerPlayer('<iframe src="https://evil.example/video.g"></iframe>'),/not found/);
});

test('No remote fallback fetching occurs for an unconfigured show/date',async()=>{
 let called=false;
 await assert.rejects(()=>resolveYoDesiEmbed('other-show','2026-10-14',{fetchImpl:()=>{called=true;throw Error('unexpected')}}),/No supported fallback/);
 assert.equal(called,false);
});

test('all five shows support exact-date listing lookup, including Dr. Aarambhi punctuation',()=>{
 assert.deepEqual(supportedYoDesiShows().sort(),['anupamaa','dr-aarambhi','mannat-har-khushi-paane-ki','seher-hone-ko-hai','udne-ki-aasha'].sort());
 const cases={
  'anupamaa':['Anupama','anupama'],
  'seher-hone-ko-hai':['Seher Hone Ko Hai','seher-hone-ko-hai'],
  'dr-aarambhi':['Dr.Aarambhi','dr-aarambhi'],
  'udne-ki-aasha':['Udne Ki Aasha','udne-ki-aasha'],
  'mannat-har-khushi-paane-ki':['Mannat Har Khushi Paane Ki','mannat-har-khushi-paane-ki'],
 };
 for(const [showId,[title,slug]] of Object.entries(cases)){
  const epTitle=title+' 14th October 2026 Full Episode';
  const link=`https://yodesi-online.com/${slug}-14th-october-2026-full-episode/`;
  assert.equal(matchesYoDesiEpisodeTitle(epTitle,showId,'2026-10-14'),true,showId);
  assert.equal(matchesYoDesiEpisodeTitle(epTitle+' | Yo Desi Online',showId,'2026-10-14'),true,showId);
  assert.equal(validYoDesiArticle(link,showId,'2026-10-14'),link,showId);
  assert.equal(matchesYoDesiEpisodeTitle(epTitle.replace('14th','13th'),showId,'2026-10-14'),false);
  assert.equal(validYoDesiArticle(link.replace('14th','13th'),showId,'2026-10-14'),null);
  assert.equal(validYoDesiArticle(link.replace('yodesi-online.com','yodesi-online.com.evil.test'),showId,'2026-10-14'),null);
  assert.equal(validYoDesiArticle(link+'?evil=true',showId,'2026-10-14'),null);
  assert.equal(validYoDesiArticle('http:'+link.slice(6),showId,'2026-10-14'),null);
 }
 assert.equal(matchesYoDesiEpisodeTitle('Anupama 14th October 2026 Full Episode','seher-hone-ko-hai','2026-10-14'),false);
});

test('WordPress search selects only a unique show/date match, never unrelated articles',()=>{
 const good={title:'Anupama 14th October 2026 Full Episode 2167',url:'https://yodesi-online.com/anupama-14th-october-2026-full-episode-2167/'};
 const unrelated={title:'Kyunki Saas Bhi Kabhi Bahu Thi 2 14th October 2026 Full Episode',url:'https://yodesi-online.com/kyunki-saas-bhi-kabhi-bahu-thi-2-14th-october-2026-full-episode/'};
 assert.equal(selectYoDesiSearchResult([unrelated,good],'anupamaa','2026-10-14'),good.url);
 assert.equal(selectYoDesiSearchResult([good,good],'anupamaa','2026-10-14'),null);
 assert.equal(selectYoDesiSearchResult([unrelated],'anupamaa','2026-10-14'),null);
 assert.equal(selectYoDesiSearchResult([good],'anupamaa','2026-10-13'),null);
 assert.equal(selectYoDesiSearchResult([good],'dr-aarambhi','2026-10-14'),null);
});

test('automated discovery uses constrained WP API, caches matches, and does not fetch video',async()=>{
 const found={title:'Udne Ki Aasha 14th October 2026 Full Episode',url:'https://yodesi-online.com/udne-ki-aasha-14th-october-2026-full-episode/'};
 const requested=[];
 const fetchImpl=async url=>{requested.push(url);return new Response(JSON.stringify([found]),{status:200,headers:{'content-type':'application/json'}})};
 const item=await discoverYoDesiArticle('udne-ki-aasha','2026-10-14',{fetchImpl,cache:false});
 assert.equal(item,found.url);
 assert.equal(requested.length,1);
 const u=new URL(requested[0]);assert.equal(u.hostname,'yodesi-online.com');assert.equal(u.pathname,'/wp-json/wp/v2/search');
 assert.equal(u.searchParams.get('search'),'Udne Ki Aasha 14th october 2026');
 const notThere=await discoverYoDesiArticle('mannat-har-khushi-paane-ki','2026-10-14',{fetchImpl,cache:false});
 assert.equal(notThere,null);
 await assert.rejects(()=>discoverYoDesiArticle('evil-show','2026-10-14',{fetchImpl,cache:false}),/Unsupported/);
});

test('dynamic embedded article allows one to four unique parts but rejects unrelated title',()=>{
 const title='<title>Seher Hone Ko Hai 14th October 2026 Full Episode | Yo Desi Online</title>';
 const iframe=u=>`<iframe src="${u}"></iframe>`;
 assert.deepEqual(extractYoDesiPlayers(title+iframe(p1),'2026-10-14','seher-hone-ko-hai'),[p1]);
 assert.deepEqual(extractYoDesiPlayers(title+iframe(p1)+iframe(p2),'2026-10-14','seher-hone-ko-hai'),[p1,p2]);
 assert.throws(()=>extractYoDesiPlayers(title+iframe(p1),'2026-10-14','dr-aarambhi'),/date\/title/);
 assert.throws(()=>extractYoDesiPlayers(title+iframe(p1)+iframe(p1),'2026-10-14','seher-hone-ko-hai'),/Expected episode parts/);
});

test('future episodes automatically reach the correct embedded player without hard-coded article URLs',async()=>{
 const show='mannat-har-khushi-paane-ki',date='2026-10-14';
 const article='https://yodesi-online.com/mannat-har-khushi-paane-ki-14th-october-2026-full-episode/';
 const title='Mannat Har Khushi Paane Ki 14th October 2026 Full Episode';
 const calls=[];
 const make=(body,type='text/html')=>new Response(body,{status:200,headers:{'content-type':type}});
 const fetchImpl=async(url)=>{
  calls.push(url);
  const parsed=new URL(url);
  if(parsed.pathname==='/wp-json/wp/v2/search')return make(JSON.stringify([{title,url:article}]),'application/json');
  if(url===article)return make(`<title>${title} | Yo Desi Online</title><iframe src="${p1}"></iframe><iframe src="${p2}"></iframe>`);
  if(url===p1||url===p2)return make(`<iframe src="${blogger}"></iframe>`);
  if(url===blogger)return make('<title>Blogger video player</title>');
  throw Error('unexpected external fetch '+url);
 };
 const result=await resolveYoDesiEmbed(show,date,{fetchImpl,cache:false});
 assert.equal(result.format,'embed');assert.deepEqual(result.embedUrls,[blogger,blogger]);
 assert.equal(calls.length,6);
 assert.ok(calls.every(u=>['yodesi-online.com','vidup.site','www.blogger.com'].includes(new URL(u).hostname)));
});

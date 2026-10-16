import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePlayApneEmbed,parsePlayApneMp4,validatedApneMp4,checkApneMp4Range,createApneMp4Relay,boundedApneMp4Range} from '../src/lib/apne-mp4.js';
import {parsePlayApneTargetFromEpisodeHtml} from '../src/lib/apne-daily.js';

const safe = 'https://sto.vkcdn5.com/abcdefghijklmnopqrstuvwxy0123456/v.mp4';
const embed='https://vkspeed.com/embed-foootoy4ccs9.html';

test('alternate source chooses only a valid APNE handoff (not ad or attacker link)',()=>{
 const id='7e2f192bff966004afdcc4f2a6fbf6f7';
 const valid=`<div data-id="${id}" data-href="https://newsportaling.com/finnance-insurance-currency-portfolio" class="flash_link"><img src="/pub/images/playapne_new.png">PlayApne Link</div>`;
 const flash=`<div data-id="${id}" data-href="https://newsportaling.com/finnance-insurance-currency-portfolio" class="flash_link">Flash Link</div>`;
 assert.deepEqual(parsePlayApneTargetFromEpisodeHtml(flash+valid), {id,href:'https://newsportaling.com/finnance-insurance-currency-portfolio'});
 assert.equal(parsePlayApneTargetFromEpisodeHtml(flash),null);
 assert.equal(parsePlayApneTargetFromEpisodeHtml(valid.replace('newsportaling.com','evil.example')),null);
});

test('alternate embed and text-only packed video source parsing reject unapproved targets',()=>{
 assert.equal(parsePlayApneEmbed(`<iframe src='${embed}'></iframe>`),embed);
 assert.equal(parsePlayApneEmbed('<iframe src="https://evil.example/embed-foootoy4ccs9.html"></iframe>'),null);
 const pack = code => `eval(function(p,a,c,k,e,d){}('${code}',36,0,''.split('|'))) `;
 assert.equal(parsePlayApneMp4(pack(`jwplayer().setup({sources:[{file:"${safe}",label:"720p"}]})`)),safe);
 assert.throws(()=>parsePlayApneMp4(pack('jwplayer().setup({sources:[{file:"https://evil.example/test/v.mp4",label:"720p"}]})')),/Unsupported alternate/);
 const second=safe.replace('abcdefghijklmnopqrstuvwxy0123456','differentabcdefghijklmnopqrstuvwxy01');
 assert.throws(()=>parsePlayApneMp4(pack('jwplayer().setup({sources:[{file:"'+second+'",label:"192p"}]})')),/Only a low-resolution APNE source/);
 assert.equal(parsePlayApneMp4(pack('jwplayer().setup({sources:[{file:"'+safe+'",label:"360p"},{file:"'+second+'",label:"192p"}]})')),safe);
 for(const bad of ['http://sto.vkcdn5.com/abc/v.mp4',safe+'?x=1',safe.replace('sto.vkcdn5.com','sto.vkcdn5.com.evil.example'),safe.replace('/v.mp4','/another.mp4')])assert.equal(validatedApneMp4(bad),null);
});

test('alternate MP4 probe requires a 206 byte-range video and does not fetch whole file',async()=>{
 let opt;
 const fetchImpl=async(_url,opts)=>{opt=opts;return new Response(new Uint8Array(1024),{status:206,headers:{'content-range':'bytes 0-1023/20000000','content-type':'video/mp4','content-length':'1024'}})};
 assert.equal(await checkApneMp4Range(safe,embed,fetchImpl),true);
 assert.equal(opt.headers.Range,'bytes=0-1023');
 await assert.rejects(()=>checkApneMp4Range(safe,embed,async()=>new Response('not video',{status:200})),/not currently reachable/);
});

test('MP4 relay issues ephemeral opaque sessions and disallows path and non-Range requests',async()=>{
 const relay=createApneMp4Relay({now:()=>1234567,fetchImpl:async()=>{throw Error('should not fetch')}});
 const path=relay.open({mp4Url:safe,referer:embed});
 assert.match(path,/^\/apne\/live\/mp4\/[a-f0-9]{32}$/);
 assert.throws(()=>relay.open({mp4Url:'https://evil.example/test/v.mp4',referer:embed}));
 let code=null;
 const res={status(n){code=n;return this},end(){return this}};
 await relay.media({params:{token:path.split('/').at(-1)},get:()=>''},res);
 assert.equal(code,502);
});

test('MP4 open-ended and oversized browser ranges stay bounded',()=>{
 assert.equal(boundedApneMp4Range('bytes=0-'),'bytes=0-1048575');
 assert.equal(boundedApneMp4Range(null),'bytes=0-1048575');
 assert.equal(boundedApneMp4Range('bytes=-500'),'bytes=-500');
 assert.equal(boundedApneMp4Range('bytes=8388608-'),'bytes=8388608-9437183');
 assert.equal(boundedApneMp4Range('bytes=1000-1200'),'bytes=1000-1200');
 assert.equal(boundedApneMp4Range('bytes=0-90000000'),'bytes=0-1048575');
 for (const invalid of ['bytes=-0','bytes=0-1,10-20','bytes=abc-','bytes=20-10']) assert.equal(boundedApneMp4Range(invalid),null);
});

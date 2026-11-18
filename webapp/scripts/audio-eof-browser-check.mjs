// Visible, isolated Chrome fixture for the WebCodecs audio-EOF recovery path.
// Start this server, open the printed URL in the user's existing signed-in
// Chrome, then press Run. It never launches Chrome or touches production.
import http from "node:http";
import fs from "node:fs/promises";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDashManifest } from "../src/lib/cyberdash-dash.js";

const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-eof-browser-"));
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const sessions = [];
const reports = [];
const mime = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".json":"application/json" };

function ff(args) {
  const p = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", ...args], { encoding:"utf8", timeout:30000, maxBuffer:2_000_000 });
  if (p.status !== 0) throw new Error(`ffmpeg failed: ${p.stderr || p.error || p.status}`);
}
async function makeDash(name, audioSeconds) {
  const dir = path.join(temp, name); await fs.mkdir(dir);
  const manifest = path.join(dir, "manifest.mpd");
  ff(["-y", "-t","8","-f","lavfi","-i","testsrc2=size=320x180:rate=24", "-t",String(audioSeconds),"-f","lavfi","-i","sine=frequency=440:sample_rate=48000", "-map","0:v:0","-map","1:a:0", "-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-g","12","-c:a","aac","-b:a","96k", "-f","dash","-seg_duration","0.5","-use_template","1","-use_timeline","1","-window_size","0","-extra_window_size","0","-init_seg_name","init-$RepresentationID$.m4s","-media_seg_name","chunk-$RepresentationID$-$Number%05d$.m4s", "-adaptation_sets","id=0,streams=v id=1,streams=a", manifest]);
  return dir;
}
const shortDash = await makeDash("short-audio", 2);
const fullDash = await makeDash("full-audio", 8);

const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Audio EOF browser check</title>
<style>body{font:16px system-ui;background:#101318;color:#f5f5f5;margin:0;padding:20px}button{font:700 18px system-ui;min-height:48px;padding:10px 18px}iframe{display:block;width:min(100%,768px);height:680px;border:1px solid #555;margin:16px 0;background:#111}pre{white-space:pre-wrap}</style>
<h1>WebCodecs audio EOF recovery fixture</h1><p>Local fixture only. Press Run to use the real app and its WebCodecs player. The first session has 2s audio and 8s video; recovery replays full 8s media at the current position.</p><button id="run">Run browser checks</button> <span id="state">Ready</span><pre id="out"></pre><iframe id="app" title="YT Streamer local fixture"></iframe>
<script>
const out=document.querySelector('#out'), state=document.querySelector('#state'), frame=document.querySelector('#app');
const post=async path=>fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({at:Date.now()})});
const sessions=async()=>{const r=await fetch('/__state');return r.json()};
const wait=(fn,ms=25000)=>new Promise((resolve,reject)=>{const end=Date.now()+ms;const poll=async()=>{try{const v=await fn();if(v)return resolve(v)}catch(e){if(Date.now()>end)return reject(e)}if(Date.now()>end)return reject(Error('Timed out waiting for '+fn.name));setTimeout(poll,100)};void poll()});
async function one(width,ui){
  state.textContent=width+'px '+ui; frame.style.width=width+'px';
  frame.src='/?ui='+ui+'&fixture='+Date.now();
  await new Promise((resolve,reject)=>{frame.onload=resolve;setTimeout(()=>reject(Error('App load timeout')),15000)});
  const w=frame.contentWindow,d=frame.contentDocument;
  await wait(()=>typeof w.playCyberdashStream==='function' && d.querySelector('#cyberdashCanvas'));
  const before=(await sessions()).sessions.length;
  // Use the production player function directly, as the speed regression does:
  // unrelated playlist/history bootstrap stubs must not gate audio-EOF coverage.
  w.eval('youtubePlaybackMethod="webcodecs";renderYoutubePlaybackMethod();replayFn=(startAt=0)=>playCyberdashStream("https://fixture.invalid/audio-eof","Audio EOF fixture",{startAt,seekable:true,duration:8});void replayFn(0);');
  const doc=d,win=w;
  const first=await wait(async function initialSession(){const x=await sessions();return x.sessions[before]||null},20000);
  const recovered=await wait(async function recoveredSession(){const x=await sessions();return x.sessions[before+1]||null},35000);
  const start=Number(recovered.startAt)||0;
  const quality=[...doc.querySelectorAll('button')].find(x=>/quality/i.test((x.getAttribute('aria-label')||'')+' '+x.textContent));
  const dims={width:doc.documentElement.scrollWidth,client:doc.documentElement.clientWidth,qualityHeight:quality?.getBoundingClientRect().height||0};
  const result={width,ui,initialStartAt:Number(first.startAt)||0,recoveryStartAt:start,retainedPosition:start>=0.5,sessionCount:(await sessions()).sessions.length,layout:dims};
  if(!result.retainedPosition) throw Error('Recovery replay did not resume at a positive current position: '+JSON.stringify(result));
  if(dims.width>dims.client+1) throw Error('Horizontal overflow: '+JSON.stringify(result));
  if(quality && dims.qualityHeight<44) throw Error('Quality control below 44px: '+JSON.stringify(result));
  await post('/__report?result='+encodeURIComponent(JSON.stringify(result)));
  return result;
}
document.querySelector('#run').onclick=async()=>{document.querySelector('#run').disabled=true;try{const all=[];for(const width of [320,375,390,430,768])for(const ui of ['classic','new']){state.textContent='Running '+width+'px '+ui;all.push(await one(width,ui));}out.textContent=JSON.stringify({passed:true,checks:all},null,2);state.textContent='PASS — '+all.length+' runs';}catch(e){out.textContent='FAIL: '+(e.stack||e);state.textContent='Failed';}finally{document.querySelector('#run').disabled=false}};
</script>`;

const server = http.createServer(async (req,res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/__check") { res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});res.end(page);return; }
  if (u.pathname === "/__report") { reports.push(u.searchParams.get("result"));res.writeHead(204);res.end();return; }
  if (u.pathname === "/__state") { res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify({sessions,reports}));return; }
  if (u.pathname === "/api/youtube/info") { res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"fixtureAudioEof",title:"Audio EOF fixture",duration:8,webpage_url:"https://www.youtube.com/watch?v=fixtureAudioEof",thumbnail:""}));return; }
  if (u.pathname === "/api/experimental/cyberdash/start" && req.method === "POST") {
    let body="";for await(const chunk of req)body+=chunk;const parsed=JSON.parse(body||"{}");
    const id=String(sessions.length+1);sessions.push({...parsed,id,createdAt:Date.now()});res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id,resolveMs:1,isLive:false,duration:8,title:"Audio EOF fixture",player:"experimental-cyberdash-v1"}));return;
  }
  const sm=u.pathname.match(/^\/api\/experimental\/cyberdash\/([^/]+)\/status$/);
  if(sm){
    const n=Number(sm[1]),dir=fixtureDir(n),manifest=parseDashManifest(await fs.readFile(path.join(dir,"manifest.mpd"),"utf8"));
    const files=syncFiles(dir),video=files.filter(x=>x.startsWith('chunk-'+manifest.video.id+'-')).sort(),audio=files.filter(x=>x.startsWith('chunk-'+manifest.audio.id+'-')).sort();
    const report={manifestReady:true,manifest,init:{video:'init-'+manifest.video.id+'.m4s',audio:'init-'+manifest.audio.id+'.m4s'},available:{video,audio},done:true,error:null};
    res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(report));return;}
  if(/^\/api\/experimental\/cyberdash\/[^/]+\/stop$/.test(u.pathname)){res.writeHead(204);res.end();return;}
  if(u.pathname.startsWith("/stream/experimental/cyberdash/")){
    const name=decodeURIComponent(u.pathname.split("/").at(-1));const n=Number(u.pathname.split("/").at(-2));const dir=fixtureDir(n);
    try{const b=await fs.readFile(path.join(dir,name));res.writeHead(200,{"content-type":"video/iso.segment","cache-control":"no-store"});res.end(b)}catch{res.writeHead(404);res.end("fixture segment missing")};return;
  }
  if(["/api/watch-history","/api/playlists","/api/youtube/history"].includes(u.pathname)){res.writeHead(200,{"content-type":"application/json"});res.end("[]");return;}
  if(u.pathname.startsWith("/api/")){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true,items:[],playlists:[],sessions:[],data:[]}));return;}
  const rel=u.pathname==="/"?"index.html":decodeURIComponent(u.pathname.slice(1));const file=path.resolve(publicRoot,rel);
  if(!file.startsWith(publicRoot+path.sep)){res.writeHead(403);res.end();return;}
  try{const b=await fs.readFile(file);res.writeHead(200,{"content-type":mime[path.extname(file)]||"application/octet-stream","cache-control":"no-store"});res.end(b)}catch{res.writeHead(404);res.end("Not found")}
});
function fixtureDir(n){return n%2===1?shortDash:fullDash;}
function fixtureNames(n,audio){
  const dir=fixtureDir(n);
  // FFmpeg's DASH representation ids are selected from manifest contentType.
  // Keep deterministic by mapping from the generated manifest representation.
  const files=syncFiles(dir);return files.filter(x=>x.startsWith(audio?"chunk-1-":"chunk-0-")||x===`init-${audio?1:0}.m4s`).sort();
}
function syncFiles(dir){try{return requireSyncReaddir(dir)}catch{return []}}
function requireSyncReaddir(dir){return nodeFs.readdirSync(dir)}

const addr=await new Promise(resolve=>server.listen(0,"127.0.0.1",()=>resolve(server.address())));
console.log(`Fixture ready: http://127.0.0.1:${addr.port}/__check`);
console.log("Open this URL in the existing signed-in Chrome, press Run browser checks, then keep this process open until results appear.");
const cleanup=async()=>{server.close();await fs.rm(temp,{recursive:true,force:true});process.exit(0)};
process.on("SIGINT",cleanup);process.on("SIGTERM",cleanup);

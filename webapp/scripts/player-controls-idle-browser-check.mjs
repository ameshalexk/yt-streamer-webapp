// Signed-in Chrome regression fixture for the five-second player-controls
// inactivity behavior. The fixture serves only this checkout on loopback;
// browser state is driven from the page and no media/API work is started.
// Run: node scripts/player-controls-idle-browser-check.mjs --serve [--output /tmp/player-controls.json]
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webapp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(webapp, 'public');
const outputArg = process.argv.indexOf('--output');
const outputPath = outputArg >= 0 ? path.resolve(process.argv[outputArg + 1] || '') : null;
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp' };

const runner = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Player controls idle check</title>
<style>
*{box-sizing:border-box}html,body{margin:0;font:14px system-ui;color:#eef;background:#10141b}body{padding:10px}button{min-height:44px;padding:8px 14px}#status{white-space:pre-wrap}#grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px;overflow:auto}.case{border:1px solid #536171;padding:4px;min-width:0;overflow:auto}.case h2{font-size:13px;margin:2px 4px}.case iframe{display:block;width:var(--w);height:var(--h);border:0;background:#fff;max-width:none}
</style>
<h1>Five second player controls check</h1><p>Runs against this checkout in the current Chrome profile. It does not launch media or contact production.</p>
<button id="run">Run browser checks</button> <span id="status">Waiting</span><div id="grid"></div>
<script>
const viewports=[[320,568],[375,812],[390,844],[430,932],[768,1024],[844,390],[1280,800]],sizes=viewports.flatMap(([w,h])=>['classic','new'].map(ui=>[w,h,ui]));
const grid=document.querySelector('#grid'),status=document.querySelector('#status');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function assertion(ok,message){if(!ok)throw Error(message)}
function makeCase([w,h,ui]){const box=document.createElement('section');box.className='case';box.style.setProperty('--w',w+'px');box.style.setProperty('--h',h+'px');box.innerHTML='<h2>'+ui+' · '+w+'×'+h+'</h2><iframe title="'+ui+' '+w+'×'+h+' local app"></iframe>';box.querySelector('iframe').src='/index.html?ui='+ui+'&controls-idle-check=1';box.dataset.width=w;box.dataset.height=h;box.dataset.ui=ui;grid.append(box);return box;}
const cases=sizes.map(makeCase);
async function ready(box){const f=box.querySelector('iframe');for(let n=0;n<160;n++){try{if(f.contentDocument.querySelector('#screen')&&typeof f.contentWindow.setMode==='function')return {w:f.contentWindow,d:f.contentDocument};}catch{}await wait(100)}throw Error('App not ready: '+box.dataset.width+' '+box.dataset.ui)}
function visible(w,el){const s=w.getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0.05&&r.width>0&&r.height>0}
function sample(w,d){const overlay=d.querySelector('#videoControlsOverlay'),quality=d.querySelector('#playerQualityBtn'),pause=d.querySelector('#pauseBtn');return {idle:d.body.classList.contains('player-controls-idle')||d.body.classList.contains('fullscreen-controls-idle'),overlayVisible:visible(w,overlay),qualityVisible:visible(w,quality),overlayOpacity:w.getComputedStyle(overlay).opacity,qualityOpacity:w.getComputedStyle(quality).opacity,overlayInert:!!overlay.inert,qualityInert:!!quality.inert,overlayAriaHidden:overlay.getAttribute('aria-hidden'),qualityAriaHidden:quality.getAttribute('aria-hidden'),pauseLabel:pause?.getAttribute('aria-label'),width:d.documentElement.scrollWidth,vw:w.innerWidth};}
async function runCase(box){const {w,d}=await ready(box),screen=d.querySelector('#screen'),quality=d.querySelector('#playerQualityBtn'),overlay=d.querySelector('#videoControlsOverlay');
  // Browser fixtures test visibility/inert state, not CSS fade timing; many
  // offscreen iframes have throttled transition animations in headless Chrome.
  const instant=d.createElement('style');instant.textContent='.video-controls-overlay,.screen > .player-quality-trigger{transition:none!important}';d.head.append(instant);
  // Arrange a real paused/active player state without starting a stream or job.
  screen.classList.add('playing');screen.classList.remove('loading');w.eval('playbackPaused = true');
  if(typeof w.beginNewPlaybackQuality==='function')w.beginNewPlaybackQuality();
  w.updatePlayerQualityAccess?.();
  screen.dispatchEvent(new w.PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:20,clientY:20}));
  await wait(5200);
  const paused=sample(w,d);assertion(paused.idle,'controls did not hide after five seconds in paused state '+JSON.stringify({w:box.dataset.width,ui:box.dataset.ui,paused}));
  assertion(!paused.overlayVisible&&!paused.qualityVisible,'hidden controls remain visible '+JSON.stringify(paused));
  assertion(paused.overlayInert&&paused.qualityInert,'hidden controls remain interactive '+JSON.stringify(paused));
  w.eval('playbackPaused = false');screen.dispatchEvent(new w.PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:20,clientY:20}));
  await wait(5200);assertion(sample(w,d).idle,'controls did not hide after five seconds in playing state');
  // Reveal with pointer input, and verify first tap reveals without toggling pause.
  screen.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true,pointerType:'touch',button:0,clientX:30,clientY:30}));
  screen.dispatchEvent(new w.PointerEvent('pointerup',{bubbles:true,pointerType:'touch',button:0,clientX:30,clientY:30}));
  await wait(100);const reveal=sample(w,d);assertion(!reveal.idle&&reveal.overlayVisible&&reveal.qualityVisible,'pointer did not reveal controls '+JSON.stringify(reveal));
  assertion(w.eval('playbackPaused')===false,'first tap on idle player toggled pause');
  await wait(5200);assertion(sample(w,d).idle,'controls failed to auto-hide again');
  // Keyboard and genuine keyboard focus must reveal but never pin.
  d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));await wait(100);
  assertion(!sample(w,d).idle,'keyboard did not reveal player controls');
  d.querySelector('#fullscreenBtn')?.focus();
  await wait(5200);assertion(sample(w,d).idle,'keyboard focus pinned controls');
  // Loading, buffering callbacks, and a visible notice must not extend the timer.
  screen.classList.add('loading');const notice=d.querySelector('#streamNotice');if(notice){notice.hidden=false;notice.textContent='Fixture notice';}
  const started=Date.now();const churn=setInterval(()=>{w.eval('diagnosticsStats = diagnosticsStats ? {...diagnosticsStats, state:"buffering"} : {state:"buffering"}');w.updatePlaybackDiagnostics?.();},700);
  await wait(5350);clearInterval(churn);screen.classList.add('playing');screen.classList.remove('loading');
  const churnResult=sample(w,d);assertion(churnResult.idle,'periodic state changes reset auto-hide timer '+JSON.stringify(churnResult));assertion(Date.now()-started>=5000,'real inactivity wait was shortened');
  // Quality interaction reveals and its popover closes on inactivity.
  screen.dispatchEvent(new w.PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:20,clientY:20}));await wait(100);quality.click();await wait(100);assertion(quality.getAttribute('aria-expanded')==='true','Quality did not open');
  await wait(5200);assertion(sample(w,d).idle,'Quality interaction failed to return to idle');
  const panel=d.querySelector('#playerQualityPanel');assertion(!panel||panel.hidden,'Quality panel stayed open while idle');
  // Fullscreen uses the same inactivity contract. Fake only browser API outcome,
  // keeping the page's real five-second timer in place.
  Object.defineProperty(d,'fullscreenElement',{configurable:true,get:()=>screen});
  d.dispatchEvent(new w.Event('fullscreenchange'));await wait(100);
  await wait(5200);const fullIdle=sample(w,d);assertion(fullIdle.idle&&!fullIdle.overlayVisible&&!fullIdle.qualityVisible,'fullscreen controls did not hide '+JSON.stringify(fullIdle));
  d.exitFullscreen=async()=>{Object.defineProperty(d,'fullscreenElement',{configurable:true,get:()=>null});d.dispatchEvent(new w.Event('fullscreenchange'));};
  await d.exitFullscreen();await wait(100);assertion(!sample(w,d).idle,'fullscreen exit did not restore controls');
  // Drag release outside the seek track must finish interaction and allow hiding.
  const seek=d.querySelector('#streamSeekTrack');if(seek){const r=seek.getBoundingClientRect();seek.dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true,pointerId:44,clientX:r.left+5,clientY:r.top+3,button:0}));d.dispatchEvent(new w.PointerEvent('pointerup',{bubbles:true,pointerId:44,clientX:w.innerWidth-2,clientY:5,button:0}));await wait(5200);assertion(sample(w,d).idle,'lost pointer release outside player pinned controls');}
  const touchTargets=[...d.querySelectorAll('#playerQualityBtn,#pauseBtn,#fullscreenBtn')].map(el=>{const r=el.getBoundingClientRect();return {id:el.id,width:r.width,height:r.height};});
  // Match the mobile-player regression: selecting from another tab reveals the
  // player, and browser-controlled quality is described explicitly.
  w.setMode('recommended');w.beginNewPlaybackQuality?.();screen.classList.add('playing');screen.scrollIntoView({block:'start'});await wait(100);
  const playerTop=screen.getBoundingClientRect().top;assertion(playerTop>=-100&&playerTop<Number(box.dataset.height)*.7,'recommendation selection did not reveal player top='+playerTop);
  screen.classList.add('browser-mode');w.updatePlayerQualityAccess?.();
  screen.dispatchEvent(new w.PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:20,clientY:20}));await wait(100);
  quality.click();await wait(100);const sourceText=d.querySelector('#playerQualityContext')?.textContent||'';
  assertion(/source manages its own resolution/i.test(sourceText),'browser Quality explanation missing: '+sourceText);
  const docWidth=d.documentElement.scrollWidth,vw=w.innerWidth;const metrics=sample(w,d);assertion(docWidth<=vw+2,'horizontal overflow '+JSON.stringify({docWidth,vw}));
  for(const t of touchTargets)assertion(t.width>=44&&t.height>=44,'touch target below 44px '+JSON.stringify(t));
  return {viewport:[Number(box.dataset.width),Number(box.dataset.height)],ui:box.dataset.ui,paused,reveal,fullscreen:fullIdle,touchTargets,overflow:docWidth-vw,playerRevealedFromRecommendations:true,sourceQualityExplanation:sourceText,checks:['paused idle hide','controls inert','pointer reveal without pause toggle','keyboard focus reveal then hide','buffering/notice and state callbacks do not pin','Quality auto-close','fullscreen enter and exit','lost pointerup outside','44px controls','no horizontal overflow','player revealed after recommendation','source-managed Quality explanation']};
}
document.querySelector('#run').onclick=async()=>{document.querySelector('#run').disabled=true;status.textContent='Running in '+cases.length+' frames…';try{const results=await Promise.all(cases.map(runCase));const report={status:'PASS',fixture:'checked-out app served on loopback; no media playback or network jobs',actualPlayback:false,realTimer:true,results};status.textContent='PASS · '+results.length+' responsive cases';document.title='PASS player controls idle';await fetch('/__result__',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)});}catch(e){const report={status:'FAIL',fixture:'checked-out app served on loopback; no media playback or network jobs',actualPlayback:false,realTimer:true,error:e.stack||String(e)};status.textContent=report.error;document.title='FAIL player controls idle';await fetch('/__result__',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)});}}
</script>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/__controls-check__') { res.writeHead(200, { 'content-type':mime['.html'] }); res.end(runner); return; }
  if (req.method === 'POST' && url.pathname === '/__result__') {
    const chunks=[];for await (const chunk of req) chunks.push(chunk);
    const body=Buffer.concat(chunks).toString('utf8');
    try { const report=JSON.parse(body); console.log(JSON.stringify(report,null,2)); if(outputPath) await fs.writeFile(outputPath,JSON.stringify(report,null,2)+'\n'); res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}'); }
    catch(error){res.writeHead(400);res.end(String(error));} return;
  }
  if (url.pathname.startsWith('/api/')) { const value=url.pathname==='/api/playlists'?[]:{ok:true,playlists:[],items:[],sessions:[],data:[]};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));return; }
  let pathname;try{pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);}catch{res.writeHead(400);res.end();return;}
  const file=path.resolve(root,'.'+pathname);if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{const body=await fs.readFile(file);res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});res.end(body);}catch{res.writeHead(404);res.end('not found');}
});
await new Promise(resolve=>server.listen(Number(process.env.PLAYER_CONTROLS_TEST_PORT||0),'127.0.0.1',resolve));
console.log(`Fixture ready: http://127.0.0.1:${server.address().port}/__controls-check__`);
console.log('Open this URL in the existing signed-in Chrome window and press “Run browser checks”. Ctrl+C stops the fixture.');
if(outputPath) console.log(`JSON report will be written to: ${outputPath}`);
await new Promise(resolve=>{server.on('close',resolve);process.once('SIGINT',()=>server.close());process.once('SIGTERM',()=>server.close());});

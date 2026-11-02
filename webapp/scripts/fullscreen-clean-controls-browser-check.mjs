// Local-only fixture for fullscreen controls. Start with `node
// scripts/fullscreen-clean-controls-browser-check.mjs --serve`, then open the
// printed loopback URL in the existing signed-in Chrome window and press Run.
// The page is the checked-out app; API calls are fixture responses and the AI
// panel is enabled only by removing its hostname guard in the served copy.
// No source files, live jobs, microphone, or remote services are touched.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webapp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(webapp, 'public');
const mime = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp' };
const checkPage = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fullscreen clean-controls check</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;font:16px system-ui}button{min-height:44px;padding:8px 14px}#run{position:fixed;z-index:10;top:8px;left:8px}#result{position:fixed;left:-10000px;top:0}</style>
<button id="run">Run fullscreen checks</button><pre id="result" role="status">Waiting to run.</pre>
<iframe id="app" title="Local YT Streamer fixture" style="position:fixed;inset:0;width:100vw;height:100vh;border:0"></iframe>
<script>
const result=document.querySelector('#result'), frame=document.querySelector('#app');
const assert={ok(v,m){if(!v)throw Error(m||'assertion failed')},equal(a,b,m){if(a!==b)throw Error((m||'values differ')+': '+JSON.stringify([a,b]))},notEqual(a,b,m){if(a===b)throw Error((m||'values unexpectedly equal')+': '+JSON.stringify(a))},match(a,re,m){if(!re.test(a))throw Error((m||'text did not match')+': '+String(a))},deepEqual(a,b,m){if(JSON.stringify(a)!==JSON.stringify(b))throw Error((m||'values differ')+': '+JSON.stringify([a,b]))}};
  const ui=new URLSearchParams(location.search).get('ui')==='new'?'new':'classic';
  frame.src='/index.html?ui='+ui+'&fullscreen-check=1';
document.querySelector('#run').onclick=async()=>{
 document.querySelector('#run').hidden=true;
 const w=frame.contentWindow,d=frame.contentDocument;
 const wait=async fn=>{for(let i=0;i<80;i++){if(fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out waiting for app readiness');};
 try{
  await wait(()=>d.querySelector('#screen')&&typeof w.enterScreenFullscreen==='function');
  const screen=d.querySelector('#screen'), full=d.querySelector('#fullscreenBtn'), quality=d.querySelector('#playerQualityBtn');
  await wait(()=>d.querySelector('#aiMediaProductionPanel')&&d.querySelector('#aiMediaProductionReopen'));
  const panel=d.querySelector('#aiMediaProductionPanel'), reopen=d.querySelector('#aiMediaProductionReopen'), notice=d.querySelector('#fullscreenFallbackNotice');
  const scenarios=[];
  screen.classList.add('playing');
  w.eval('playbackPaused = false');
  // Preserve the real five-second auto-hide timer: this fixture intentionally
  // does not fake time or replace the timer.
  await new Promise(r=>setTimeout(r,5100));
  assert.equal(panel.hidden,true,'AI panel auto-hides after five seconds');
  assert.equal(reopen.hidden,false,'AI reopen button appears after auto-hide');
  reopen.click();
  assert.equal(panel.hidden,false,'one tap reopens AI panel');
  assert.equal(reopen.hidden,true,'reopen button hides while panel is open');
  scenarios.push('five-second AI auto-hide and one-tap reopen work with the real timer');
  const setNative=active=>{Object.defineProperty(d,'fullscreenElement',{configurable:true,get:()=>active?screen:null});d.dispatchEvent(new Event('fullscreenchange'));};
  d.exitFullscreen=async()=>setNative(false);
  let optionsSeen=null;
  screen.requestFullscreen=async opts=>{optionsSeen=opts;setNative(true);};
  full.click();
  await wait(()=>d.body.classList.contains('screen-fullscreen'));
  assert.deepEqual(optionsSeen,{navigationUI:'hide'},'native fullscreen requests hidden browser navigation UI');
  assert.equal(w.getComputedStyle(panel).display,'none');assert.equal(w.getComputedStyle(reopen).display,'none');
  assert.equal(full.getAttribute('aria-label'),'Exit full screen');scenarios.push('native fullscreen passes navigationUI hide and suppresses both AI controls');
  full.click();setNative(false);
  await wait(()=>!d.body.classList.contains('screen-fullscreen'));
  assert.equal(w.getComputedStyle(panel).display==='none',panel.hidden,'panel visual state restored');assert.equal(w.getComputedStyle(reopen).display==='none',reopen.hidden,'reopen visual state restored');scenarios.push('native exit restores the expanded AI panel');
  screen.requestFullscreen=async()=>{throw Object.assign(new Error('fixture rejection'),{name:'NotAllowedError'});};
  full.click();
  await wait(()=>screen.classList.contains('synthetic-fullscreen'));
  assert.match(full.getAttribute('aria-label'),/Exit expanded player/i);
  assert.match(notice.textContent,/expanded player/i);assert.equal(notice.hidden,false);
  assert.equal(w.getComputedStyle(panel).display,'none');assert.equal(w.getComputedStyle(reopen).display,'none');scenarios.push('rejected native request enters truthfully labelled expanded player');
  full.click();
  await wait(()=>!screen.classList.contains('synthetic-fullscreen'));
  assert.equal(w.getComputedStyle(panel).display==='none',panel.hidden,'panel visual state restored');assert.equal(w.getComputedStyle(reopen).display==='none',reopen.hidden,'reopen visual state restored');scenarios.push('expanded-player exit restores the expanded AI panel');
  screen.requestFullscreen=async()=>{throw new TypeError('navigationUI option unsupported');};
  full.click();await wait(()=>screen.classList.contains('synthetic-fullscreen'));
  assert.match(full.getAttribute('aria-label'),/Exit expanded player/i,'unsupported fullscreen options use expanded-player wording');
  assert.match(notice.textContent,/expanded player/i);
  scenarios.push('unsupported native fullscreen enters truthfully labelled expanded player');
  full.click();await wait(()=>!screen.classList.contains('synthetic-fullscreen'));
  
  // Idle fullscreen controls must hide the popup close button, then reveal it
  // after user input. Trigger the app's existing reveal handler via pointer.
  const close=d.querySelector('#browserClosePopupBtn');close.hidden=false;
  d.body.classList.add('screen-fullscreen','fullscreen-controls-idle');
  screen.classList.add('playing');
  await new Promise(r=>setTimeout(r,300));
  assert.equal(w.getComputedStyle(close).visibility,'hidden');
  assert.equal(w.getComputedStyle(quality).visibility,'hidden','Quality hides in idle fullscreen');
  d.querySelector('#screen').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
  await new Promise(r=>setTimeout(r,300));
  assert.equal(w.getComputedStyle(close).visibility,'visible');scenarios.push('idle popup close hides and player interaction reveals it');
  // Active player controls are visible, reachable in one click, and 44px+.
  screen.classList.add('playing');d.body.classList.remove('fullscreen-controls-idle');
  w.updatePlayerQualityAccess?.();
  const targetMetrics=await Promise.all([quality,full,close].map(async el=>{const r=el.getBoundingClientRect();return {id:el.id,w:r.width,h:r.height,display:w.getComputedStyle(el).display};}));
  const qRect=quality.getBoundingClientRect(), closeRect=close.getBoundingClientRect();
  assert.ok(qRect.left>=closeRect.right || closeRect.left>=qRect.right || qRect.top>=closeRect.bottom || closeRect.top>=qRect.bottom,'Quality and popup-close targets must not overlap');
  assert.notEqual(w.getComputedStyle(quality).display,'none','Quality stays available');
  assert.notEqual(w.getComputedStyle(full).display,'none','Exit stays available');
  for(const t of targetMetrics)assert.ok(t.w>=44&&t.h>=44,JSON.stringify(t)+' is under 44x44');
  quality.click();assert.equal(quality.getAttribute('aria-expanded'),'true','one tap opens Quality');
  d.querySelector('#playerQualityCloseBtn').click();assert.equal(quality.getAttribute('aria-expanded'),'false','one tap closes Quality');
  scenarios.push('playing Quality, Exit, and popup close controls retain 44px targets');
  const width=w.innerWidth,docWidth=d.documentElement.scrollWidth;
  assert.ok(docWidth<=width+2,JSON.stringify({width,docWidth})+' horizontal overflow');
  result.textContent='PASS\\n'+scenarios.map(x=>'✓ '+x).join('\\n')+'\\nTargets: '+JSON.stringify(targetMetrics)+'\\nUI: '+ui+'\\nFixture viewport: '+width+'x'+w.innerHeight;
  document.title='PASS fullscreen clean-controls '+ui+' '+width+'x'+w.innerHeight;
 }catch(e){result.textContent='FAIL: '+(e.stack||e);throw e;}
};
</script>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__fullscreen-check__') { res.writeHead(200, { 'content-type':'text/html; charset=utf-8' }); res.end(checkPage); return; }
  if (url.pathname.startsWith('/api/')) {
    const value = url.pathname === '/api/playlists' ? [] : { ok:true, playlists:[], items:[], sessions:[], data:[] };
    res.writeHead(200, { 'content-type':'application/json' }); res.end(JSON.stringify(value)); return;
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
  catch { res.writeHead(400); res.end(); return; }
  const file = path.resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    let body = await fs.readFile(file);
    if (pathname === '/ai-media-agent-production.js') {
      body = Buffer.from(body.toString().replace("if (location.protocol !== 'https:' || location.hostname !== 'stream.ameshalex.com') return;", ''));
    }
    res.writeHead(200, { 'content-type':mime[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-store' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});

await new Promise(resolve => server.listen(Number(process.env.FULLSCREEN_TEST_PORT || 0), '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}/__fullscreen-check__`;
console.log(`Fixture ready: ${address}`);
console.log('Open this URL in the existing Chrome window and press “Run fullscreen checks”. Ctrl+C stops the fixture.');
if (!process.argv.includes('--serve')) {
  console.log('Use --serve for the Chrome-profile/CUA workflow; this script does not launch another browser.');
}
await new Promise(resolve => { server.on('close', resolve); process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close()); });

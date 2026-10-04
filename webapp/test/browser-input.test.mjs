import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { enqueueBrowserInput } from '../src/lib/browser-input-queue.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function harness(post) {
  const sent = [];
  const context = vm.createContext({
    performance: { now: () => 1000 }, Date, Promise, Math,
    api: { post: post || (async (url, payload) => { sent.push({ url, ...payload }); return { ok: true }; }) },
    toast() {}, queueBrowserKeyboardFocus() {}, hideBrowserKeyboard() {},
    setBrowserZoom() {}, panBrowserZoom() {},
    $: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) }),
    activeScreenMediaElement: () => ({ naturalWidth: 1280, naturalHeight: 720 }),
  });
  const declarations = `${app.slice(app.indexOf('let browserSessionId ='), app.indexOf('let browserFullscreenTapAt ='))}\nconst BROWSER_TOUCH_SCROLL_THRESHOLD_PX = 18;`;
  const queue = app.slice(app.indexOf('function postBrowserInput('), app.indexOf('function browserKeyboardInputMode('));
  const handlers = app.slice(app.indexOf('function browserMediaBaseRect('), app.indexOf('function handleBrowserZoomWheel('));
  vm.runInContext(`${declarations}
    browserSessionId = 'test'; browserStreamActive = true; browserInputActive = true;
    let browserViewport = {width:1280,height:720};
    let browserZoom = {scale:1,panX:0,panY:0,pointers:new Map(),pinching:false};
    let browserFullscreenTapAt=0,browserFullscreenTapX=0,browserFullscreenTapY=0;
    function browserInputActiveForScreen(){return browserInputActive && !!browserSessionId;}
    function desktopInputButton(e){return e.button===2?2:1;}
    ${queue}\n${handlers}`, context);
  const event = (type, x = 500, y = 500, pointerType = 'mouse', pointerId = 1) => ({
    type, clientX: x, clientY: y, pointerType, pointerId, button: 0,
    target: { closest: () => null }, currentTarget: {setPointerCapture(){},releasePointerCapture(){}},
    preventDefault(){}, stopPropagation(){},
  });
  return { sent, context, event, run: code => vm.runInContext(code, context),
    down: e => context.handleBrowserInputPointerDown(e),
    move: e => context.handleBrowserInputPointerMove(e),
    up: e => context.handleBrowserInputPointerUp(e),
    flush: () => vm.runInContext('browserInputQueue', context),
  };
}

test('mouse click is one atomic activation, including rapid repeated clicks', async () => {
  const h = harness();
  for (let i=0;i<30;i++) {h.down(h.event('pointerdown'));h.up(h.event('pointerup'));}
  await h.flush();
  assert.equal(h.sent.length,30);
  assert.ok(h.sent.every(e=>e.type==='tap'));
});

test('touch jitter never emits a mouse drag, cancel never activates', async () => {
  const h=harness();
  h.down(h.event('pointerdown',500,500,'touch'));
  h.move(h.event('pointermove',502,502,'touch'));
  h.up(h.event('pointercancel',502,502,'touch'));
  await h.flush(); assert.equal(h.sent.length,0);
  h.down(h.event('pointerdown',500,500,'touch'));
  h.move(h.event('pointermove',502,502,'touch'));
  h.up(h.event('pointerup',502,502,'touch'));
  await h.flush(); assert.deepEqual(h.sent.map(e=>e.type),['tap']);
});

test('drag release outside letterboxed image is delivered and clamped', async () => {
  const h=harness(); h.down(h.event('pointerdown'));
  h.move(h.event('pointermove',600,500)); h.up(h.event('pointerup',1100,100));
  await h.flush(); assert.deepEqual(h.sent.map(e=>e.type),['down','drag','up']);
  assert.equal(h.sent.at(-1).x,1); assert.equal(h.sent.at(-1).y,0);
});

test('pinch and touch scrolling cannot accidentally activate a link', async () => {
  const h=harness(); h.down(h.event('pointerdown',500,500,'touch',1));
  h.down(h.event('pointerdown',600,500,'touch',2));
  h.up(h.event('pointerup',600,500,'touch',2));h.up(h.event('pointerup',500,500,'touch',1));
  h.down(h.event('pointerdown',500,500,'touch',1));h.move(h.event('pointermove',500,400,'touch',1));
  h.up(h.event('pointerup',500,400,'touch',1));
  await h.flush();assert.deepEqual(h.sent.map(e=>e.type),['scroll']);
});

test('coordinate mapping respects letterboxing and zoom', () => {
  const h=harness(); assert.equal(h.context.browserInputPointFromClient(500,10),null);
  assert.equal(h.context.browserInputPointFromClient(500,500).y,0.5);
  h.run('browserZoom.scale=2;browserZoom.panX=100');
  assert.equal(h.context.browserInputPointFromClient(600,500).x,0.5);
});

test('network operations remain ordered under delay; stale session events are discarded', async () => {
  let release; const calls=[];
  const h=harness(async (url,payload)=>{calls.push(payload.type); if(calls.length===1) await new Promise(r=>release=r); return {ok:true};});
  h.context.postBrowserInput({type:'down'});h.context.postBrowserInput({type:'up'});
  await Promise.resolve(); assert.deepEqual(calls,['down']);
  release();await h.flush();assert.deepEqual(calls,['down','up']);
  h.context.postBrowserInput({type:'tap'});h.run("browserSessionId='replacement'");
  await h.flush();assert.equal(calls.length,2);
});

test('motion backlog is coalesced without dropping click boundaries', async () => {
  const h=harness();
  h.context.postBrowserInput({type:'move',x:1});h.context.postBrowserInput({type:'move',x:2});
  h.context.postBrowserInput({type:'tap'});h.context.postBrowserInput({type:'move',x:3});
  await h.flush();assert.deepEqual(h.sent.map(e=>e.type),['move','tap','move']);assert.equal(h.sent[0].x,2);
});

test('backend queue serializes asynchronous gestures and recovers after failure', async () => {
  const session={};const order=[];let release;
  const first=enqueueBrowserInput(session,async()=>{order.push('down');await new Promise(r=>release=r);order.push('up');});
  const second=enqueueBrowserInput(session,async()=>{order.push('next');throw new Error('test');});
  const third=enqueueBrowserInput(session,async()=>order.push('recovered'));
  await Promise.resolve();assert.deepEqual(order,['down']);release();
  await first;await assert.rejects(second,/test/);await third;
  assert.deepEqual(order,['down','up','next','recovered']);
});

test('Real Chrome input wrapper queues dispatch before it selects a CDP target', async () => {
  const renderer = fs.readFileSync(new URL('../src/lib/real-chrome-renderer.js', import.meta.url), 'utf8');
  const start = renderer.indexOf('export async function input(id, payload = {})');
  const end = renderer.indexOf('\n}\n', start) + 2;
  const calls = [];
  const session = { cdp: { ready: Promise.resolve(), call: async (...args) => { calls.push(args); return {}; } } };
  const context = vm.createContext({
    enqueueBrowserInput,
    get: () => session,
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    dispatchRealChromeInput: async (_session, payload) => { calls.push(['dispatch', payload.type]); return { ok: true }; },
  });
  const queueStart = renderer.indexOf('function queueRealChromeInput(');
  const queueEnd = renderer.indexOf('\n}\n', queueStart) + 2;
  vm.runInContext(renderer.slice(queueStart, queueEnd), context);
  vm.runInContext(renderer.slice(start, end).replace('export async function input', 'async function input'), context);
  context.input = vm.runInContext('input', context);
  await context.input('session', { type: 'tap' });
  assert.deepEqual(calls, [['dispatch', 'tap']]);
  assert.ok(start >= 0 && end > start);
  assert.match(renderer.slice(start, end), /queueRealChromeInput\(session, \(\) => dispatchRealChromeInput\(session, payload\)\)/);
});

test('Mac viewport preserves native display scale and scales only the JPEG capture', async () => {
  const renderer=fs.readFileSync(new URL('../src/lib/real-chrome-renderer.js',import.meta.url),'utf8');
  const start=renderer.indexOf('async function preparePage(');
  const end=renderer.indexOf('\n}\n',start)+2;
  const calls=[];const cdp={ready:Promise.resolve(),call:async(method,params)=>{calls.push({method,params});return {result:{value:2}};}};
  const ctx=vm.createContext({installFullscreenShim:async()=>{},installApneFlashGuard:async()=>{},REMOTE_BROWSER_BLOCKED_URLS:[],DESKTOP_USER_AGENT:'test',DEFAULT_WIDTH:1280,DEFAULT_HEIGHT:720,MIN_WIDTH:640,MIN_HEIGHT:360,MAX_WIDTH:1920,MAX_HEIGHT:1080});
  vm.runInContext(renderer.slice(start,end),ctx);
  await ctx.preparePage({width:1280,height:720,cdp});
  assert.equal(calls.find(c=>c.method==='Emulation.setDeviceMetricsOverride').params.deviceScaleFactor,0);
  assert.equal(cdp.captureScale,0.5);
});

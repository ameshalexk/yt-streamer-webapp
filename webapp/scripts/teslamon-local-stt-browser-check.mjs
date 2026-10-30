// Controlled Chrome integration. Real MediaRecorder -> local Whisper WASM ->
// mocked planner/candidate selector -> synthetic same-tab video frame progress.
// No mocked transcript; this is not authenticated production API verification.
// Usage: TESLAMON_STT_TEST_WAV=/absolute/generated-speech.wav node scripts/teslamon-local-stt-browser-check.mjs
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const fixture = process.env.TESLAMON_STT_TEST_WAV;
if (!fixture) throw new Error('Provide TESLAMON_STT_TEST_WAV (a controlled spoken WAV fixture).');
const modelId=process.env.TESLAMON_STT_MODEL_ID||'whisper-tiny.en';
assert.ok(['whisper-tiny.en','whisper-base.en'].includes(modelId));
const encoded = (await fs.readFile(fixture)).toString('base64');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const mime = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.wasm':'application/wasm', '.onnx':'application/octet-stream',
  '.json':'application/json', '.md':'text/plain' };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/__teslamon_local_stt_fixture__') {
    response.writeHead(200, { 'Content-Type':'text/html' });
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/teslamon-pet.css"></head><body><video id="fixturePlayer" muted playsinline style="width:320px;height:180px"></video><script type="module" src="/teslamon-pet.js"></script></body></html>');
    return;
  }
  const relative = url.pathname.endsWith('/') ? url.pathname.slice(1) + 'index.html' : url.pathname.slice(1);
  const full = path.resolve(root, decodeURIComponent(relative));
  if (!full.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
  try {
    let bytes = await fs.readFile(full);
    if (url.pathname === '/teslamon-pet.js') {
      bytes = Buffer.from(bytes.toString('utf8').replace(
        "['stream.ameshalex.com','teslamon-stage.ameshalex.com'].includes(location.hostname)&&location.protocol==='https:'",
        "['stream.ameshalex.com','teslamon-stage.ameshalex.com','127.0.0.1'].includes(location.hostname)&&['https:','http:'].includes(location.protocol)"
      ));
    }
    response.writeHead(200, { 'Content-Type':mime[path.extname(full)] || 'application/octet-stream' });
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({
  executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true, args:['--no-first-run','--use-fake-ui-for-media-stream']
});
const evidence = { origin, planTexts:[], selectionRequests:[], forbiddenUploads:[], modelRequests:[],
  errors:[], commands:[], checks:[] };

try {
  const context = await browser.newContext({ viewport:{width:390,height:844},
    permissions:['microphone'] });
  const page = await context.newPage();
  await page.addInitScript(({ encoded, modelId }) => {
    localStorage.setItem('ytStreamerTeslaMonSttModelV1',modelId);
    const state = window.__teslamonFixture = { micCalls:0, workerCount:0, loadCount:0,
      inferences:0, workerResults:[], pcm:[], tracks:[], videoFrames:0,
      searchCalls:0, playCalls:0, mediaId:null, mode:'buffered_mjpeg' };
    const nativeWorker = window.Worker;
    window.Worker = class extends nativeWorker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('/games/voice-worker.js')) {
          state.workerCount++;
          this.addEventListener('message', event => {
            if (event.data?.type === 'result') state.workerResults.push(event.data.text);
          });
          const originalPost = this.postMessage.bind(this);
          this.postMessage = (message, transfer) => {
            if (message.type === 'load') state.loadCount++;
            if (message.type === 'transcribe') {
              state.inferences++;
              state.pcm.push({ length:message.audio.length, peak:Math.max(...message.audio.slice(0,1000).map(Math.abs)) });
            }
            return originalPost(message, transfer);
          };
        }
      }
    };
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0)).buffer;
    let decodedPromise;
    navigator.mediaDevices.getUserMedia = async () => {
      state.micCalls++;
      const audioContext = new AudioContext({ sampleRate:48000 });
      void audioContext.resume().catch(() => {});
      if (!decodedPromise) decodedPromise = audioContext.decodeAudioData(bytes.slice(0));
      const clip = await decodedPromise;
      const lead = 48000;
      const buffer = audioContext.createBuffer(1, clip.length + lead + 48000, 48000);
      buffer.getChannelData(0).set(clip.getChannelData(0), lead);
      const source = audioContext.createBufferSource();
      const target = audioContext.createMediaStreamDestination();
      source.buffer = buffer; source.connect(target);
      source.start(audioContext.currentTime + 0.05);
      state.tracks.push(...target.stream.getTracks());
      return target.stream;
    };
    window.YTStreamerMediaAgent = {
      async execute(tool, args) {
        const player = document.querySelector('#fixturePlayer');
        if (tool === 'search_media') {
          state.searchCalls++;
          return { status:'completed', result:{ results:[
            { media_id:'abcDEF12345', title:'Fixture space video' },
            { media_id:'zzzzzzzzzzz', title:'Decoy video' }
          ] } };
        }
        if (tool === 'play_media') {
          state.playCalls++;
          state.mediaId = args.media_id;
          if (state.drawTimer) clearInterval(state.drawTimer);
          const canvas = document.createElement('canvas');
          canvas.width = 320; canvas.height = 180;
          const ctx = canvas.getContext('2d');
          let step = 0;
          state.drawTimer = setInterval(() => {
            ctx.fillStyle = step++ % 2 ? '#2277cc' : '#22cc77';
            ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.fillStyle='#fff';ctx.fillText('Frame '+step,15,40);
          }, 50);
          player.srcObject = canvas.captureStream(20);
          const countFrame = () => {
            if (!player.isConnected) return;
            state.videoFrames++;
            player.requestVideoFrameCallback(countFrame);
          };
          player.requestVideoFrameCallback(countFrame);
          await player.play();
          return { status:'completed' };
        }
        if (tool === 'request_fullscreen') return { status:'needs_user_gesture' };
        if (tool === 'pause') { player.pause();return { status:'completed' }; }
        if (tool === 'resume') { await player.play();return { status:'completed' }; }
        if (tool === 'get_player_state') return { status:'completed', state:this.get_player_state() };
        return { status:'unsupported' };
      },
      get_player_state() {
        const player = document.querySelector('#fixturePlayer');
        return { media_id:state.mediaId,
          playback_phase:state.mediaId ? (player.paused ? 'paused' : 'playing') : 'idle',
          mode:state.mode, rendered_frames:state.videoFrames, fullscreen_kind:'none' };
      }
    };
  }, { encoded, modelId });

  page.on('pageerror', error => evidence.errors.push(String(error)));
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes('/games/models/')) evidence.modelRequests.push(pathname);
  });
  await page.route('**/api/teslamon/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === '/api/teslamon/capabilities')
      return route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({codexAvailable:true,localTranscription:false}) });
    if (url.pathname === '/api/teslamon/plan') {
      const body = req.postDataJSON();
      evidence.planTexts.push(body.text);
      return route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({status:'ok',tool:'search_and_play',args:{query:'space and time documentary'}})});
    }
    if (url.pathname === '/api/teslamon/select-candidate') {
      const body = req.postDataJSON();
      evidence.selectionRequests.push({text:body.text,query:body.query,candidateCount:body.candidates?.length});
      return route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({status:'selected',index:0})});
    }
    evidence.forbiddenUploads.push(url.pathname);
    return route.fulfill({status:410,contentType:'application/json',
      body:JSON.stringify({status:'failed',code:'unsupported'})});
  });
  await page.goto(origin + '/__teslamon_local_stt_fixture__', { waitUntil:'domcontentloaded' });
  await page.locator('#tmAura').waitFor({state:'visible',timeout:7000});
  await page.locator('#tmAura').press('Escape');
  await page.locator('#tmAura').waitFor({state:'hidden',timeout:3000});
  await page.locator('#tmFace').click();
  try {
    await page.waitForFunction(() => !document.querySelector('#tmMic')?.disabled, null, { timeout:15000 });
  } catch (error) {
    console.error('STT INIT DEBUG',JSON.stringify(await page.evaluate(() => ({
      pet:!!document.querySelector('#teslamonPet'),
      status:document.querySelector('#tmState')?.textContent,
      mic:document.querySelector('#tmMic')?.outerHTML,
      wake:document.querySelector('#tmWakeState')?.textContent,
      ready:typeof window.YTStreamerMediaAgent?.execute,
      secure:window.isSecureContext, mediaRecorder:typeof window.MediaRecorder,
      worker:typeof window.Worker, wasm:typeof window.WebAssembly
    })),null,2),evidence);
    throw error;
  }
  const toggle = page.locator('#tmWakeToggle');
  if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click();
  await page.waitForTimeout(350);
  async function holdAndWait() {
    const previous = evidence.planTexts.length;
    if(!await page.locator('#tmPanel').isVisible())await page.locator('#tmFace').click();
    await page.locator('#tmMic').scrollIntoViewIfNeeded();
    const box = await page.locator('#tmMic').boundingBox();
    await page.mouse.move(box.x+box.width/2, box.y+box.height/2);
    await page.mouse.down();
    await page.waitForFunction(() => /Recording audio|Requesting microphone/.test(document.querySelector('#tmState')?.textContent || ''), null, { timeout:10000 });
    await page.waitForTimeout(4800);
    await page.mouse.up();
    const deadline = Date.now() + Number(process.env.TESLAMON_STT_WAIT_MS||120000);
    while (evidence.planTexts.length <= previous && Date.now() < deadline) {
      await page.waitForTimeout(250);
    }
    if(evidence.planTexts.length<=previous)console.error('NO PLAN DEBUG',JSON.stringify({evidence,ui:await page.evaluate(()=>({status:document.querySelector('#tmState')?.textContent,input:document.querySelector('#tmText')?.value,panelHidden:document.querySelector('#tmPanel')?.hidden,selectedModel:document.querySelector('#tmSttModel')?.value,modelState:document.querySelector('#tmSttModelState')?.textContent,results:window.__teslamonFixture.workerResults,loads:window.__teslamonFixture.loadCount,inferences:window.__teslamonFixture.inferences}))},null,2));
    assert.ok(evidence.planTexts.length > previous,
      'a real Whisper result must reach the signed planner after recording');
    try {
      await page.waitForFunction(() => /Video playing in this tab|Playing in this tab/.test(
        document.querySelector('#tmState')?.textContent || ''), null, {timeout:18000});
    } catch (error) {
      console.error('STT PLAYBACK DEBUG',JSON.stringify({
        planTexts:evidence.planTexts,forbidden:evidence.forbiddenUploads,
        page:await page.evaluate(() => ({
          status:document.querySelector('#tmState')?.textContent,
          playback:window.YTStreamerMediaAgent.get_player_state(),
          fixture:window.__teslamonFixture.workerResults,
          searches:window.__teslamonFixture.searchCalls,
          plays:window.__teslamonFixture.playCalls,
          videoTime:document.querySelector('#fixturePlayer')?.currentTime
        }))
      },null,2));
      throw error;
    }
    return await page.locator('#tmState').innerText();
  }
  assert.equal(await page.locator('#tmSttModel').inputValue(),modelId);
  const firstStatus = await holdAndWait();
  evidence.commands.push({ firstStatus, state:await page.evaluate(() => window.YTStreamerMediaAgent.get_player_state()) });
  assert.ok(evidence.planTexts.length >= 1, 'real Whisper transcript must reach the planner');
  assert.ok(evidence.selectionRequests.length >= 1, 'contextual candidate selection route must be exercised');
  assert.equal(evidence.selectionRequests[0].candidateCount,2,'fixture selects from the actual filtered search candidates');
  assert.match(evidence.planTexts[0], /video|space|time|fabric/i,
    'planner receives the complete natural sentence, not a game trick');
  await page.waitForFunction(() => window.__teslamonFixture.videoFrames > 5 &&
    document.querySelector('#fixturePlayer').currentTime > 0.25, null, {timeout:12000});
  const firstFrames = await page.evaluate(() => window.__teslamonFixture.videoFrames);

  const secondStatus = await holdAndWait();
  evidence.commands.push({ secondStatus, state:await page.evaluate(() => window.YTStreamerMediaAgent.get_player_state()) });
  assert.ok(evidence.planTexts.length >= 2, 'second recording must reach planner');
  const result = await page.evaluate(async () => {
    const f = window.__teslamonFixture;
    const cache = await caches.open('transformers-cache');
    const entries = (await cache.keys()).map(request => request.url);
    return { micCalls:f.micCalls, workerCount:f.workerCount, loadCount:f.loadCount,
      inferences:f.inferences, workerResults:f.workerResults, pcm:f.pcm,
      videoFrames:f.videoFrames, firstVideoFrameCount:null, framesAdvanced:f.videoFrames>0,
      tracksEnded:f.tracks.every(track => track.readyState === 'ended'), modelEntries:
      entries.filter(url => url.includes('/games/models/')).length };
  });
  evidence.result = {modelId, ...result, firstFrames };
  assert.ok(evidence.modelRequests.filter(url=>url.endsWith('.onnx')).every(url=>url.includes(modelId==='whisper-base.en'?'whisper-base-en-95bf40a':'whisper-tiny-en-79fb389')),'only selected model weights requested');
  assert.equal(result.workerCount, 1, 'one Whisper worker for multiple recordings on a page');
  assert.equal(result.loadCount, 1, 'model initialized only once');
  assert.equal(result.inferences, 2, 'each PTT clip was actually transcribed');
  assert.equal(result.modelEntries >= 7, true, 'one shared CacheStorage model');
  assert.equal(result.videoFrames > firstFrames, true, 'observable selected-tab video frames continue advancing');
  assert.deepEqual(evidence.forbiddenUploads, [], 'no server transcription or unrelated API calls');
  assert.deepEqual(evidence.errors, [], 'no browser JS errors');
  evidence.checks.push('real MediaRecorder > mono decode > Whisper WASM > planner > selected video frame progress');
  await page.close();

  // A new game page on the same origin sees all seven saved model entries.
  const game = await context.newPage();
  const modelRequestsBefore = evidence.modelRequests.length;
  await game.goto(origin+'/games/',{waitUntil:'domcontentloaded'});
  const cacheInfo = await game.evaluate(async () => {
    const cache = await caches.open('transformers-cache');
    const entries = (await cache.keys()).map(request => request.url);
    return { cachedFiles:entries.filter(url => url.includes('/games/models/')).length };
  });
  assert.ok(cacheInfo.cachedFiles >= 7, 'game accesses the same-origin saved model cache');
  evidence.gameCache = { ...cacheInfo, modelRequestsAfterNavigation:evidence.modelRequests.length-modelRequestsBefore };
  await game.close();
  console.log(JSON.stringify(evidence,null,2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

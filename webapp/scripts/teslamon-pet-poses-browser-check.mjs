// Chrome rendering smoke for the draggable TeslaMon puppy status/pose assets.
// Real browser CSS checks; no user profile, microphone, network or media playback.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const mime={'.js':'text/javascript','.css':'text/css','.mjs':'text/javascript'};
const server=http.createServer(async(req,res)=>{
  const requested=new URL(req.url,'http://127.0.0.1');
  if(requested.pathname==='/'){
    res.writeHead(200,{'content-type':'text/html'});
    return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/teslamon-pet.css"><script type="module" src="/teslamon-pet.js"></script>');
  }
  const full=path.resolve(dir,decodeURIComponent(requested.pathname.slice(1)));
  if(!full.startsWith(dir+path.sep)){res.writeHead(403);return res.end();}
  try{
    let data=await fs.readFile(full);
    if(path.basename(full)==='teslamon-pet.js')
      data=Buffer.from(data.toString('utf8').replace(
        "['stream.ameshalex.com','teslamon-stage.ameshalex.com'].includes(location.hostname)&&location.protocol==='https:'",
        "['stream.ameshalex.com','teslamon-stage.ameshalex.com','127.0.0.1'].includes(location.hostname)&&['https:','http:'].includes(location.protocol)"
      ));
    res.writeHead(200,{'content-type':mime[path.extname(full)]||'application/octet-stream'});
    res.end(data);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin='http://127.0.0.1:'+server.address().port;
const captureDir=process.env.TESLAMON_CAPTURE_DIR;
if(captureDir)await fs.mkdir(captureDir,{recursive:true});
const browser=await chromium.launch({
  executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,args:['--no-first-run']
});
const snapshot=async page=>page.evaluate(()=>{
  const pet=document.querySelector('#teslamonPet');
  const css=(s,p)=>getComputedStyle(pet.querySelector(s),p);
  return {
    motion:pet.dataset.motion,
    badge:css('#tmFace','::after').content,
    color:css('#tmFace','::after').backgroundColor,
    sit:Number(css('.tm-pose-sit').opacity),
    stand:Number(css('.tm-pose-stand').opacity),
    running:css('.tm-puppy').animationName,
    leg:css('.tm-run-leg-front').animationName,
    speed:css('.tm-speed-lines').opacity,
    accessible:pet.querySelector('#tmFace')?.getAttribute('aria-label'),
  };
});
try{
  for(const [viewport,reducedMotion] of [
    [{width:390,height:844},'no-preference'],
    [{width:1280,height:720},'no-preference'],
    [{width:390,height:844},'reduce']
  ]){
    const context=await browser.newContext({viewport,reducedMotion});
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    await page.route('**/*',route=>{
      const requested=new URL(route.request().url());
      if(requested.origin!==origin)return route.abort();
      if(requested.pathname.startsWith('/api/'))
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({codexAvailable:false,localTranscription:false})});
      return route.continue();
    });
    await page.goto(origin,{waitUntil:'domcontentloaded',timeout:20000});
    await page.waitForSelector('#tmFace');
    let state=await snapshot(page);
    assert.equal(state.motion,'sitting','default posture');
    assert.equal(state.badge,'"MIC OFF"','orange badge is always visible while off');
    assert.equal(state.color,'rgb(182, 107, 35)');
    assert.match(state.accessible,/TeslaMon puppy/);
    if(captureDir&&reducedMotion==='no-preference'&&viewport.width===390)
      await page.locator('#tmFace').screenshot({path:path.join(captureDir,'sitting-off.png')});

    await page.evaluate(()=>{const pet=document.querySelector('#teslamonPet');pet.dataset.mic='on';pet.dataset.wake='listening';});
    state=await snapshot(page);
    assert.equal(state.badge,'"MIC ON"');
    assert.equal(state.color,'rgb(20, 121, 77)');
    assert.equal(state.motion,'sitting','passive wake word scanning does not stand all day');
    if(captureDir&&reducedMotion==='no-preference'&&viewport.width===390)
      await page.locator('#tmFace').screenshot({path:path.join(captureDir,'sitting-on.png')});

    await page.evaluate(()=>{const pet=document.querySelector('#teslamonPet');pet.dataset.motion='alert';pet.dataset.wake='recording';});
    await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.tm-pose-stand')).opacity)>.995);
    state=await snapshot(page);
    assert.equal(state.stand,1,'standing art is visible when Jarvis wakes');
    assert.ok(state.sit<.005,'sitting art is hidden while standing');
    assert.equal(state.badge,'"REC"');
    assert.equal(state.color,'rgb(179, 35, 52)');
    if(captureDir&&reducedMotion==='no-preference'&&viewport.width===390)
      await page.locator('#tmFace').screenshot({path:path.join(captureDir,'standing-rec.png')});

    await page.evaluate(()=>{const pet=document.querySelector('#teslamonPet');pet.dataset.motion='running';pet.dataset.wake='processing';});
    state=await snapshot(page);
    assert.equal(state.stand,1,'standing legs remain visible in run animation');
    assert.ok(Number(state.speed)>.3,'running motion streaks are visible');
    if(captureDir&&reducedMotion==='no-preference'&&viewport.width===390)
      await page.locator('#tmFace').screenshot({path:path.join(captureDir,'running.png')});
    if(reducedMotion==='reduce'){
      assert.equal(state.running,'none');
      assert.equal(state.leg,'none');
    }else{
      assert.equal(state.running,'tm-puppy-run');
      assert.equal(state.leg,'tm-run-front');
    }

    await page.evaluate(()=>{const pet=document.querySelector('#teslamonPet');pet.dataset.motion='sitting';pet.dataset.mic='off';pet.dataset.wake='off';});
    await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.tm-pose-sit')).opacity)>.995);
    state=await snapshot(page);
    assert.equal(state.sit,1,'puppy sits down when idle again');
    assert.equal(state.badge,'"MIC OFF"');
    assert.deepEqual(errors,[],'page has no JavaScript errors');
    console.log('PASS pet status and poses',viewport.width+'x'+viewport.height,reducedMotion);
    await context.close();
  }
}finally{
  await browser.close();
  await new Promise(done=>server.close(done));
}

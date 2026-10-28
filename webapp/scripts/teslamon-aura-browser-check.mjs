// Aura browser integration: isolated Chrome fixture, no production auth or microphone.
// Tests flag persistence, wake handoff, full-viewport layout, and tap-to-exit.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript',
  '.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.wasm':'application/wasm'};
const fakeHandsFree=String.raw`
export function createTeslaMonHandsFree({onState}={}){
  let enabled=false,state='off';
  const emit=update=>{state=update.state;onState?.(update);};
  globalThis.__auraWake=keyword=>emit({state:'recording',keyword,message:'Wake phrase detected'});
  globalThis.__auraProcessing=()=>emit({state:'processing',message:'Transcribing locally'});
  return {enable(){enabled=true;emit({state:'listening',message:'Listening for Hey Jarvis'});return Promise.resolve(true);},
    disable(){enabled=false;emit({state:'off',message:'Off'});},
    suspend(){return false;},resume(){return true;},
    get enabled(){return enabled;},get state(){return state;}};
}
`;
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  if(pathname==='/teslamon-handsfree.js'){
    res.writeHead(200,{'content-type':'text/javascript'});res.end(fakeHandsFree);return;
  }
  if(pathname.startsWith('/api/')){
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(pathname==='/api/teslamon/capabilities'?{codexAvailable:true,localTranscription:true}:
      pathname==='/api/teslamon/plan'?{status:'ha_done',action:'light_checked'}:
      pathname==='/api/playlists'?[]:{ok:true,items:[]}));
    return;
  }
  const target=path.resolve(root,decodeURIComponent(pathname==='/'?'index.html':pathname.slice(1)));
  if(!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{
    let bytes=await fs.readFile(target);
    if(pathname==='/teslamon-pet.js')bytes=Buffer.from(bytes.toString('utf8').replace(
      "['stream.ameshalex.com','teslamon-stage.ameshalex.com'].includes(location.hostname)&&location.protocol==='https:'",
      "['stream.ameshalex.com','teslamon-stage.ameshalex.com','127.0.0.1'].includes(location.hostname)&&['https:','http:'].includes(location.protocol)"
    ));
    res.writeHead(200,{'content-type':mime[path.extname(target)]||'application/octet-stream'});
    res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,args:['--no-first-run','--use-fake-ui-for-media-stream']});
const results=[],errors=[];
try{
  for(const [width,height] of [[320,568],[390,844],[844,390],[1280,800]]){
    for(const ui of ['classic','new']){
      const context=await browser.newContext({viewport:{width,height},isMobile:true,hasTouch:true});
      const page=await context.newPage();
      page.on('pageerror',error=>errors.push(ui+' '+width+' '+error.message));
      await page.addInitScript(()=>{
        window.YTStreamerMediaAgent={
          execute:async()=>({status:'completed',state:{playback_phase:'idle',fullscreen_kind:'none'}}),
          get_player_state:()=>({playback_phase:'idle',fullscreen_kind:'none'})
        };
        navigator.mediaDevices.getUserMedia=async()=>{throw new Error('No fixture mic');};
      });
      const plans=[];
      page.on('request',req=>{if(new URL(req.url()).pathname==='/api/teslamon/plan')plans.push(req.postDataJSON());});
      await page.goto(origin+'/?ui='+ui,{waitUntil:'domcontentloaded'});
      await page.locator('#tmAuraToggle').waitFor({state:'attached'});
      assert.equal(await page.locator('#tmAuraToggle').isChecked(),true,'Aura defaults on');
      assert.equal(await page.locator('#tmAura').isHidden(),true,'not shown until wake/preview');
      await page.evaluate(()=>window.__auraWake('hey_jarvis'));
      await page.locator('#tmAura').waitFor({state:'visible'});
      assert.equal(await page.locator('#tmAura').getAttribute('data-phase'),'listening');
      const measure=await page.evaluate(()=>{
        const node=document.querySelector('#tmAura'),r=node.getBoundingClientRect();
        const header=document.querySelector('#tmAura .ta-header').getBoundingClientRect();
        const footer=document.querySelector('#tmAura .ta-footer').getBoundingClientRect();
        return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},
          inside:header.top>=-1&&footer.bottom<=innerHeight+1,
          overflow:document.documentElement.scrollWidth-innerWidth};
      });
      assert.ok(Math.abs(measure.rect.x)<=1&&Math.abs(measure.rect.y)<=1,
        ui+' '+width+' Aura not viewport aligned '+JSON.stringify(measure));
      assert.ok(Math.abs(measure.rect.width-width)<=1&&Math.abs(measure.rect.height-height)<=1,
        ui+' '+width+' Aura not fullscreen '+JSON.stringify(measure));
      assert.ok(measure.inside,ui+' '+width+' header/footer clipped '+JSON.stringify(measure));
      assert.ok(measure.overflow<=2,ui+' '+width+' horizontal overflow '+JSON.stringify(measure));
      await page.locator('#tmAura').tap({position:{x:width/2,y:height/2}});
      assert.equal(await page.locator('#tmAura').isHidden(),true,'tap exits Aura');
      assert.equal(await page.evaluate(()=>document.querySelector('#tmWakeToggle').getAttribute('aria-pressed')),
        'true','tap does not disable mic');
      // An in-progress command must still auto-submit after the visual has exited.
      await page.evaluate(()=>{
        const input=document.querySelector('#tmText');
        input.value='turn on the kitchen lights';
        input.dispatchEvent(new Event('input',{bubbles:true}));
      });
      await page.waitForFunction(()=>document.querySelector('#tmState')?.textContent?.includes('Home Assistant light'),null,{timeout:6500});
      assert.equal(plans.length,1,'voice command survives dismissed overlay');
      await page.locator('#tmFace').click();
      await page.locator('#tmAuraToggle').uncheck();
      assert.equal(await page.locator('#tmAuraPreview').isDisabled(),true);
      assert.equal(await page.locator('#tmAuraToggleState').innerText(),'Off');
      await page.reload({waitUntil:'domcontentloaded'});
      await page.locator('#tmAuraToggle').waitFor({state:'attached'});
      assert.equal(await page.locator('#tmAuraToggle').isChecked(),false,'flag persisted off');
      await page.evaluate(()=>window.__auraWake('alexa'));
      assert.equal(await page.locator('#tmAura').isHidden(),true,'legacy wake used when Aura off');
      await page.locator('#tmAuraToggle').check();
      await page.locator('#tmAuraPreview').click();
      assert.equal(await page.locator('#tmAura').isVisible(),true,'preview opens without a wake');
      assert.equal(await page.locator('#tmAura').getAttribute('data-phase'),'standby');
      await page.locator('#tmAura').press('Escape');
      assert.equal(await page.locator('#tmAura').isHidden(),true,'Escape exits Aura');
      results.push({ui,width,height,measure,plans:plans.length});
      await context.close();
    }
  }
  assert.deepEqual(errors,[],'page JavaScript errors');
  console.log(JSON.stringify({passed:results.length,results},null,2));
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}

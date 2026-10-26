// Actual Streamer classic/new UI with TeslaMon panel at required Chrome-emulated sizes.
// No live microphone, no server changes, no Tesla/iPhone acceptance claim.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript',
  '.svg':'image/svg+xml','.json':'application/json','.wasm':'application/wasm'};
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  if(pathname.startsWith('/api/')){
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(pathname==='/api/teslamon/capabilities'?{codexAvailable:true,localTranscription:false}:pathname==='/api/playlists'?[]:{ok:true,items:[]}));
    return;
  }
  const target=path.resolve(root,decodeURIComponent(pathname==='/'?'index.html':pathname.slice(1)));
  if(!target.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
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
const sizes=[[320,568],[375,812],[390,844],[430,932],[768,1024],[1024,768],[844,390]];
const results=[],errors=[];
const evidence=path.resolve(root,'../docs/teslamon-stt-selector-evidence-20261025');
await fs.mkdir(evidence,{recursive:true});
try{
  for(const [width,height] of sizes){
    for(const mode of ['classic','new']){
      const page=await browser.newPage({viewport:{width,height},isMobile:true,hasTouch:true,deviceScaleFactor:2});
      page.on('pageerror',error=>errors.push(mode+' '+width+':'+String(error)));
      await page.addInitScript(()=>{
        window.YTStreamerMediaAgent={
          execute:async tool=>tool==='get_player_state'?{status:'completed',state:{playback_phase:'idle',fullscreen_kind:'none'}}:{status:'completed'},
          get_player_state:()=>({playback_phase:'idle',fullscreen_kind:'none'})
        };
        navigator.mediaDevices.getUserMedia=async()=>{
          throw new DOMException('Fixture permission denied','NotAllowedError');
        };
      });
      await page.goto(origin+'/?ui='+mode,{waitUntil:'domcontentloaded'});
      await page.locator('#tmFace').waitFor({timeout:12000});
      await page.locator('#tmFace').click();
      await page.locator('#tmSttModel').selectOption('whisper-base.en');
      await page.locator('#tmSttModel').scrollIntoViewIfNeeded();
      const result=await page.evaluate(()=>{
        const pet=document.querySelector('#teslamonPet'),panel=document.querySelector('#tmPanel');
        const rect=panel.getBoundingClientRect();
        const style=getComputedStyle(pet);
        const inset={left:parseFloat(style.getPropertyValue('--tm-safe-left'))||0,
          right:parseFloat(style.getPropertyValue('--tm-safe-right'))||0,
          top:parseFloat(style.getPropertyValue('--tm-safe-top'))||0,
          bottom:parseFloat(style.getPropertyValue('--tm-safe-bottom'))||0};
        const buttons=[...pet.querySelectorAll('button')].filter(button=>
          button.getBoundingClientRect().width>0&&button.getBoundingClientRect().height>0);
        const targets=[...buttons,...pet.querySelectorAll('.tm-wake-options label'),pet.querySelector('#tmSttModel')];
        const small=targets.map(button=>({id:button.id||button.dataset.tm,
          width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}))
          .filter(item=>item.width<43.5||item.height<43.5);
        return {overflowX:document.documentElement.scrollWidth-innerWidth,
          panel:{x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom,
            width:rect.width,height:rect.height,scrollHeight:panel.scrollHeight},
          inset,small,buttons:buttons.length,voiceButton:document.querySelector('#tmMic')?.textContent,
          controlMode:document.querySelector('#tmWakeToggle')?.textContent,
          sttValue:document.querySelector('#tmSttModel')?.value,
          sttRect:(()=>{const r=document.querySelector('#tmSttModel').getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height};})(),
          wakeOptions:[...pet.querySelectorAll('.tm-wake-options input')].map(input=>({value:input.value,checked:input.checked}))};
      });
      assert.ok(result.overflowX<=2,mode+' '+width+' document horizontal overflow '+JSON.stringify(result));
      assert.deepEqual(result.small,[],mode+' '+width+' controls smaller than 44px');
      assert.ok(result.panel.x>=result.inset.left-1 && result.panel.right<=width-result.inset.right+1,
        mode+' '+width+' panel outside horizontal safe area '+JSON.stringify(result));
      assert.ok(result.panel.y>=result.inset.top-1 && result.panel.bottom<=height-result.inset.bottom+1,
        mode+' '+width+' panel outside vertical safe area '+JSON.stringify(result));
      assert.equal(result.sttValue,'whisper-base.en');
      assert.ok(result.sttRect.left>=result.panel.x-1&&result.sttRect.right<=result.panel.right+1,'selector inside panel');
      assert.equal(result.wakeOptions.length,4);
      assert.ok(result.wakeOptions.every(option=>option.checked));
      if(mode==='classic'&&[320,390].includes(width))await page.screenshot({path:path.join(evidence,`${width}-stt-selector.png`)});
      results.push({width,height,mode,...result});
      await page.close();
    }
  }
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(evidence,'layout.json'),JSON.stringify({kind:'Chrome viewport emulation; not real iPhone/Tesla',results},null,2)+'\n');
  console.log(JSON.stringify({passed:results.length,results:results.map(item=>({
    width:item.width,height:item.height,mode:item.mode,
    panel:item.panel,buttons:item.buttons,overflowX:item.overflowX
  }))},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}

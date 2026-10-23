import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

// Isolated Chrome emulation, not an authenticated production session or
// physical iPhone/Tesla check. All requests are served from this checkout.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const origin='https://stream.ameshalex.com';
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript',
  '.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')){
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:true,items:[],data:[]}));return;
  }
  const target=path.resolve(root,decodeURIComponent(url.pathname.slice(1)||'index.html'));
  if(!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{const body=await fs.readFile(target);
    res.writeHead(200,{'content-type':mime[path.extname(target)]||'application/octet-stream','cache-control':'no-store'});
    res.end(body);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
let browser;
try{
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:true,args:['--no-first-run','--no-default-browser-check']});
  for(const [width,height] of [[390,844],[844,390]]){
    const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});
    try{
      const page=await context.newPage();
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.origin!==origin){await route.abort();return;}
        try{const response=await route.fetch({url:base+url.pathname+url.search,timeout:6500});
          await route.fulfill({response});}catch{await route.abort();}
      });
      const plans=[];
      await page.route('**/api/teslamon/plan',async route=>{
        plans.push(JSON.parse(route.request().postData()||'{}'));
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'unsupported',code:'unsupported_voice_command'})});
      });
      await page.goto(origin+'/?ui=classic',{waitUntil:'domcontentloaded',timeout:16000});
      await page.locator('#tmFace').click();
      await page.locator('#tmPanel').waitFor({state:'visible'});
      // One paste-like insertion should auto-dispatch through Codex with no Send click.
      await page.locator('#tmText').fill('play MKBHD video');
      await page.waitForFunction(()=>document.querySelector('#tmText').value==='play MKBHD video');
      await page.waitForFunction(()=>document.querySelector('#tmState').textContent.includes('Codex')||document.querySelector('#tmState').textContent.includes('TeslaMon'),{timeout:5000}).catch(()=>{});
      await page.waitForTimeout(2200);
      assert.equal(plans.length,1,'the first settled text draft is sent exactly once');
      assert.equal(plans[0].text,'play MKBHD video');
      await page.waitForTimeout(600);
      assert.equal(plans.length,1,'input does not auto-loop after a rejected plan');
      await page.locator('#tmText').fill('pause');
      await page.locator('#tmSend').click();
      await page.waitForFunction(()=>document.querySelector('#tmState').textContent.length>0);
      assert.equal(plans.length,2,'manual Send is immediate and cancels auto-send');
      await page.waitForTimeout(2300);
      assert.equal(plans.length,2,'manual Send does not re-submit');
      // Force native fullscreen to reject, as it does on some browsers. The
      // existing player must switch to in-page fullscreen on a real pet tap.
      await page.evaluate(()=>{
        document.querySelector('#screen').requestFullscreen=()=>Promise.reject(
          Object.assign(new Error('not allowed'),{name:'NotAllowedError'}));
      });
      await page.locator('button[data-tm="request_fullscreen"]').click();
      await page.waitForFunction(()=>globalThis.YTStreamerMediaAgent?.get_player_state?.().fullscreen_kind==='in_page');
      assert.equal(await page.locator('#screen').evaluate(el=>el.classList.contains('synthetic-fullscreen')),true);
      assert.match(await page.locator('#tmState').innerText(),/Fullscreen enabled/i);
      await page.locator('button[data-tm="exit_fullscreen"]').click();
      await page.waitForFunction(()=>globalThis.YTStreamerMediaAgent?.get_player_state?.().fullscreen_kind==='none');
      assert.equal(await page.locator('#screen').evaluate(el=>el.classList.contains('synthetic-fullscreen')),false);
      assert.match(await page.locator('#tmState').innerText(),/Fullscreen exited/i);
      console.log('PASS TeslaMon Fullscreen/Exit via browser adapter',width+'x'+height);
    }finally{await context.close();}
  }
}finally{
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
}

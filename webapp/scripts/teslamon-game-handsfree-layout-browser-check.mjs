// Chrome emulation only: game hands-free control and safe-area responsive layout.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css',
  '.json':'application/json','.wasm':'application/wasm','.onnx':'application/octet-stream'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  const relative=url.pathname.endsWith('/')?url.pathname.slice(1)+'index.html':url.pathname.slice(1);
  const target=path.resolve(root,decodeURIComponent(relative));
  if(!target.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  try{const bytes=await fs.readFile(target);res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream'});res.end(bytes);}
  catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-first-run']});
const sizes=[[320,568],[375,812],[390,844],[430,932],[768,1024],[1024,768],[844,390]];
const report=[];
try{
  for(const [width,height] of sizes){
    const ctx=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,hasTouch:true,isMobile:true});
    const page=await ctx.newPage();
    await page.goto(origin+'/games/',{waitUntil:'load'});
    const check=await page.evaluate(()=>{
      const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const controls=[...document.querySelectorAll('button')].map(node=>({
        text:node.textContent.trim(),rect:rect(node),pressed:node.getAttribute('aria-pressed')
      }));
      return{docWidth:document.documentElement.scrollWidth,innerWidth:innerWidth,
        controls,secondary:rect(document.querySelector('.secondary')),
        game:rect(document.querySelector('#game')),
        status:document.querySelector('#status')?.textContent,
        toggle:document.querySelector('#handsFreeToggle')?.textContent};
    });
    assert.equal(check.docWidth<=width,true,'horizontal overflow at '+width+'x'+height);
    assert.equal(check.controls.length,8,'unexpected control count');
    for(const item of check.controls){
      assert.ok(item.rect.height>=44,'small '+item.text+' at '+width+'x'+height);
      assert.ok(item.rect.width>=44,'narrow '+item.text+' at '+width+'x'+height);
      assert.ok(item.rect.x>=-1&&item.rect.right<=width+1,'offscreen '+item.text+' at '+width+'x'+height);
    }
    assert.match(check.toggle,/Off/);
    assert.ok(check.secondary.bottom<=height+2,'secondary controls below screen at '+width+'x'+height);
    report.push({size:width+'x'+height,buttons:check.controls.length,
      secondary:check.secondary,docWidth:check.docWidth});
    await ctx.close();
  }
  console.log(JSON.stringify({passed:report.length,report},null,2));
}finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));
}

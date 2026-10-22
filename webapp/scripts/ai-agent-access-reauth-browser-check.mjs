// Real-Chrome check: AI panel must expose a top-level Cloudflare reauth path,
// and expired Access AJAX should yield a useful prompt, never an invisible OTP.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const home=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const client=await fs.readFile(path.join(home,'public/ai-media-agent-production.js'),'utf8');
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
try{
 for(const [name,width,height,optIn] of [['iPhone narrow',320,740,true],
     ['iPhone regular',390,844,true],['Access 302 fallback',390,844,true],['Desktop manual sign-in',1100,780,false]]){
  const context=await browser.newContext({viewport:{width,height},isMobile:width<500,hasTouch:width<500});
  if(optIn)await context.addInitScript(()=>localStorage.setItem('ytStreamerAiMediaOptInV1','1'));
  let bootstraps=0,header=null;
  await context.route('https://stream.ameshalex.com/**',async route=>{
   const req=route.request();const url=new URL(req.url());
   if(url.pathname==='/api/ai-agent/bootstrap'){
    bootstraps++;header=req.headers()['x-requested-with'];
    if(name==='Access 302 fallback')await route.fulfill({status:302,headers:{location:'https://ameshalex.cloudflareaccess.com/cdn-cgi/access/login/stream.ameshalex.com'}});
    else await route.fulfill({status:401,contentType:'application/json',body:'{"error":"signed_access_required"}'});
   }else if(url.pathname==='/ai-media-agent-production.js'){
    await route.fulfill({status:200,contentType:'application/javascript',body:client});
   }else if(url.pathname==='/cdn-cgi/access/logout'){
    await route.fulfill({status:200,contentType:'text/html',body:'<html><title>Cloudflare Access logout fixture</title><h1>Cloudflare session ended</h1><a href="/">Sign in again</a></html>'});
   }else if(url.pathname==='/'){
    await route.fulfill({status:200,contentType:'text/html',body:'<html><body><main>YT Streamer</main><script src="/ai-media-agent-production.js"></script></body></html>'});
   }else await route.fulfill({status:404,body:'not found'});
  });
  const page=await context.newPage();
  await page.goto('https://stream.ameshalex.com/');
  const signIn=page.locator('#aiMediaProductionSignIn');
  await signIn.waitFor({state:'visible',timeout:5000});
  assert.equal(await signIn.innerText(),'Sign out & sign in');
  assert.equal(new URL(await signIn.getAttribute('href'),'https://stream.ameshalex.com/').pathname,'/cdn-cgi/access/logout');
  if(optIn){
   await page.waitForFunction(()=>/authorization rejected|session or network verification failed/.test(document.querySelector('#aiMediaProductionStatus')?.textContent||''));
   assert.equal(header,'XMLHttpRequest','Cloudflare AJAX 401 hint must be set');
   assert.ok(bootstraps>=1,'signed bootstrap should be attempted');
  }else assert.equal(bootstraps,0,'disabled AI must not attempt authentication');
  const overflows=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  assert.equal(overflows,false,'auth controls must not overflow small phone screens');
  await signIn.click();
  await page.waitForURL(u=>new URL(u).pathname==='/cdn-cgi/access/logout',{timeout:5000});
  assert.match(await page.locator('h1').innerText(),/Cloudflare session ended/);
  console.log('PASS '+name+': real Cloudflare logout navigation, full-page navigation, auth handling, responsive');
  await context.close();
 }
}finally{await browser.close();}

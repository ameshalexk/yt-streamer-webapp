// CI-only responsive acceptance for the TeslaMon pet. Uses an isolated loopback
// fixture and fixture player UI; it never authenticates or launches media jobs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if(process.env.CI!=='true'){
  console.log('SKIP: TeslaMon mobile browser check runs only in CI. Use the signed-profile manual browser procedure for local acceptance.');
  process.exit(0);
}
if(!process.env.CHROME_PATH){
  console.error('CHROME_PATH is required in CI and must point to the workflow-provided Google Chrome binary.');
  process.exit(2);
}

const {chromium}=await import('playwright-core');
const scriptDir=path.dirname(fileURLToPath(import.meta.url));
const webappDir=path.resolve(scriptDir,'..');
const fixture=path.join(scriptDir,'teslamon-browser-fixture.mjs');
const outputDir=process.env.TESLAMON_MOBILE_OUTPUT_DIR||
  await fs.mkdtemp(path.join(os.tmpdir(),'teslamon-mobile-'));
await fs.mkdir(outputDir,{recursive:true});

function startFixture(){
  const child=spawn(process.execPath,[fixture],{cwd:webappDir,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const ready=new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>reject(new Error('Fixture startup timed out. '+stderr)),10000);
    const inspect=()=>{
      const line=stdout.split('\n').find(value=>value.trim());
      if(line){clearTimeout(deadline);try{resolve(JSON.parse(line).url);}catch(error){reject(error);}}
    };
    child.stdout.on('data',inspect);
    child.once('error',error=>{clearTimeout(deadline);reject(error);});
    child.once('exit',code=>{
      clearTimeout(deadline);
      if(code!==0)reject(new Error(`Fixture exited before ready (${code}). ${stderr}`));
    });
    inspect();
  });
  return {child,ready,get stderr(){return stderr;}};
}

async function stopFixture(child){
  if(child.exitCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill('SIGTERM');
  await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,2000))]);
  if(child.exitCode===null){child.kill('SIGKILL');await exited;}
}

const fixtureProcess=startFixture();
let browser;
const results=[];
try{
  const fixtureUrl=await fixtureProcess.ready;
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH,
    headless:true,args:['--no-sandbox']});
  for(const [width,height] of [[320,568],[375,812],[390,844],[430,932],[768,1024],[844,390]]){
    for(const ui of ['classic','new']){
      const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:2,
        isMobile:true,hasTouch:true});
      const apiCalls=[];
      page.on('request',request=>{
        const url=new URL(request.url());
        if(url.hostname!=='127.0.0.1')return;
        if(url.pathname.startsWith('/api/'))apiCalls.push(url.pathname);
      });
      await page.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.hostname==='127.0.0.1')return route.continue();
        return route.abort();
      });
      try{
        await page.goto(fixtureUrl+'?ui='+ui,{waitUntil:'domcontentloaded'});
        await page.waitForSelector('#teslamonPet',{timeout:10000});
        await page.locator('#tmFace').click();
        await page.locator('#tmPanel').waitFor({state:'visible'});
        await page.waitForFunction(()=>document.querySelector('#tmDevices')?.options.length>=3);

        const handle=page.locator('#tmHandle');
        const beforeMove=await handle.boundingBox();
        assert.ok(beforeMove&&beforeMove.width>=44&&beforeMove.height>=44,
          `${ui} ${width}x${height}: drag handle is below 44px`);
        await handle.focus();await page.keyboard.press('ArrowLeft');
        const afterMove=await handle.boundingBox();
        assert.ok(afterMove&&afterMove.x<beforeMove.x,
          `${ui} ${width}x${height}: keyboard movement did not move the handle`);
        await page.locator('#tmResetPosition').click();

        // Reveal the optional checkbox only in this synthetic page to validate its
        // configured hit area; the fixture never enables or calls a model endpoint.
        const modelHit=await page.evaluate(()=>{
          const label=document.querySelector('#tmModelLabel');
          const checkbox=document.querySelector('#tmModelOptIn');
          const wasHidden=label.hidden;label.hidden=false;
          label.scrollIntoView({block:'nearest'});
          const labelBox=label.getBoundingClientRect();
          const panelBox=document.querySelector('#tmPanel').getBoundingClientRect();
          const checkboxStyle=getComputedStyle(checkbox);
          const answer={labelWidth:labelBox.width,labelHeight:labelBox.height,
            checkboxWidth:parseFloat(checkboxStyle.width),checkboxHeight:parseFloat(checkboxStyle.height),
            scrollReachable:labelBox.top>=panelBox.top-1&&labelBox.bottom<=panelBox.bottom+1};
          label.hidden=wasHidden;return answer;
        });
        assert.ok(modelHit.labelWidth>=44&&modelHit.labelHeight>=44&&
          modelHit.checkboxWidth>=24&&modelHit.checkboxHeight>=24&&modelHit.scrollReachable,
          `${ui} ${width}x${height}: optional model checkbox hit area is too small ${JSON.stringify(modelHit)}`);
        await page.locator('#tmPanel').evaluate(el=>{el.scrollTop=0;});

        const controls=page.locator('#tmPanel button:visible, #tmPanel select:visible, #tmPanel input:visible');
        const controlCount=await controls.count();
        for(let i=0;i<controlCount;i++){
          const control=controls.nth(i);
          if(await control.getAttribute('id')==='tmModelOptIn')continue;
          await control.scrollIntoViewIfNeeded();
          const box=await control.boundingBox();
          assert.ok(box&&box.width>=44&&box.height>=44,
            `${ui} ${width}x${height}: control ${await control.getAttribute('id')} is below 44px (${JSON.stringify(box)})`);
          const panelBox=await page.locator('#tmPanel').boundingBox();
          assert.ok(panelBox&&box.y>=panelBox.y-1&&box.y+box.height<=panelBox.y+panelBox.height+1,
            `${ui} ${width}x${height}: control ${await control.getAttribute('id')} cannot be scrolled into the panel viewport`);
        }
        await page.locator('#tmPanel').evaluate(el=>{el.scrollTop=0;});

        await page.locator('#tmDevices').selectOption('fixture-tab-a');
        await page.waitForFunction(()=>document.querySelector('#tmState')?.textContent.includes('Browser selected'));
        await page.getByRole('button',{name:'Pause',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('#tmState')?.textContent.includes('Paused'));

        // This is a UI-only fixture state transition: no media/job API is called.
        await page.waitForFunction(()=>typeof window.beginNewPlaybackQuality==='function'&&
          typeof window.setMode==='function',{timeout:10000});
        await page.evaluate(()=>{
          window.setMode('recommended');
          document.querySelector('#recommendationsView').style.minHeight='1200px';
          document.querySelector('#recommendationsView').scrollIntoView({block:'end'});
          window.beginNewPlaybackQuality();
          const screen=document.querySelector('#screen');
          document.querySelector('#nowPlaying').textContent='Fixture video selected from recommendations';
          screen.classList.add('playing','mjpeg-buffered-mode');
        });
        await page.waitForTimeout(250);
        const player=await page.evaluate(()=>{
          const screen=document.querySelector('#screen');
          const bounds=screen.getBoundingClientRect();
          const quality=document.querySelector('#playerQualityBtn');
          const q=quality.getBoundingClientRect();
          return {top:bounds.top,bottom:bounds.bottom,visible:bounds.bottom>0&&bounds.top<innerHeight,
            qualityVisible:getComputedStyle(quality).display!=='none'&&q.width>0&&q.height>0,
            width:document.documentElement.scrollWidth,viewport:innerWidth};
        });
        assert.ok(player.visible&&player.top<height*.6,
          `${ui} ${width}x${height}: player was not revealed ${JSON.stringify(player)}`);
        assert.ok(player.qualityVisible,
          `${ui} ${width}x${height}: Quality is not visible with the player`);
        assert.ok(player.width<=player.viewport+2,
          `${ui} ${width}x${height}: document has horizontal overflow ${JSON.stringify(player)}`);

        const closePet=page.locator('#tmClose');
        const closeBox=await closePet.boundingBox();
        assert.ok(closeBox&&closeBox.width>=44&&closeBox.height>=44,
          `${ui} ${width}x${height}: pet Close control is not a 44px reachable target`);
        await closePet.click();
        await page.locator('#tmPanel').waitFor({state:'hidden'});
        const petPanelClosedForPlayerQuality=await page.locator('#tmPanel').isHidden();
        assert.equal(petPanelClosedForPlayerQuality,true,
          `${ui} ${width}x${height}: pet panel must be dismissed for player Quality access`);

        await page.locator('#playerQualityBtn').click();
        assert.equal(await page.locator('#playerQualityPanel').isVisible(),true,
          `${ui} ${width}x${height}: Quality panel did not open`);
        const playerScreenshot=path.join(outputDir,`teslamon-${ui}-${width}x${height}-player-quality.png`);
        await page.screenshot({path:playerScreenshot,fullPage:false});
        await page.locator('#playerQualityCloseBtn').click();

        await page.locator('#tmFace').click();
        await page.locator('#tmPanel').waitFor({state:'visible'});
        await page.waitForFunction(()=>document.querySelector('#tmDevices')?.options.length>=3);

        const pageMetrics=await page.evaluate(modelHitArea=>{
          const bounds=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
          const pet=document.querySelector('#teslamonPet'),panel=document.querySelector('#tmPanel');
          const p=bounds(pet),q=bounds(panel);
          return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,
            pet:p,panel:q,panelWithinViewport:q.x>=-1&&q.y>=-1&&q.x+q.width<=innerWidth+1&&q.y+q.height<=innerHeight+1,
            panelScrollHeight:panel.scrollHeight,panelClientHeight:panel.clientHeight,
            handle:bounds(document.querySelector('#tmHandle')),modelHitArea,
            player:bounds(document.querySelector('#screen')),quality:bounds(document.querySelector('#playerQualityBtn'))};
        },modelHit);
        assert.ok(pageMetrics.panelWithinViewport,
          `${ui} ${width}x${height}: pet panel overflows viewport ${JSON.stringify(pageMetrics)}`);
        assert.ok(pageMetrics.documentWidth<=width+2,
          `${ui} ${width}x${height}: document has horizontal overflow ${JSON.stringify(pageMetrics)}`);
        const metrics={ui,width,height,player,petPanelClosedForPlayerQuality,
          layout:pageMetrics,apiCalls:[...apiCalls],playerScreenshot};
        assert.ok(!apiCalls.includes('/api/teslamon/transcribe')&&!apiCalls.includes('/api/teslamon/interpret'),
          `${ui} ${width}x${height}: unexpected transcription/model request ${apiCalls.join(',')}`);
        assert.ok(apiCalls.includes('/api/teslamon/command'),
          `${ui} ${width}x${height}: fixture pause command did not run`);
        const screenshot=path.join(outputDir,`teslamon-${ui}-${width}x${height}-pet-open.png`);
        await page.screenshot({path:screenshot,fullPage:false});
        metrics.petOpenScreenshot=screenshot;results.push(metrics);
        console.log(`PASS ${ui} ${width}x${height}: controls, fixture pause; Quality tested with pet dismissed; ${playerScreenshot}`);
      }catch(error){
        const failureShot=path.join(outputDir,`teslamon-${ui}-${width}x${height}-failure.png`);
        await page.screenshot({path:failureShot,fullPage:false}).catch(()=>{});
        throw error;
      }finally{await page.close();}
    }
  }
  const metricsPath=path.join(outputDir,'teslamon-mobile-metrics.json');
  await fs.writeFile(metricsPath,JSON.stringify({scenarios:results},null,2)+'\n');
  console.log(`${results.length}/12 CI responsive scenarios passed. Metrics: ${metricsPath}`);
}finally{
  try{if(browser)await browser.close();}
  finally{
    try{await stopFixture(fixtureProcess.child);}
    finally{
      const metricsPath=path.join(outputDir,'teslamon-mobile-metrics.json');
      await fs.writeFile(metricsPath,JSON.stringify({scenarios:results},null,2)+'\n');
    }
  }
}

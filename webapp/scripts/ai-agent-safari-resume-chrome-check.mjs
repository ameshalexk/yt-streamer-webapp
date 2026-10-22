// Chrome acceptance for the temporary Safari-compatible foreground video page.
// iOS Safari physical browser still requires a separate manual test.
import assert from "node:assert/strict";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {chromium} from "playwright-core";
const exec=promisify(execFile);
const dir=path.dirname(fileURLToPath(import.meta.url));
const port="18432";
const directory=await fs.mkdtemp(path.join(os.homedir(),".yt-safari-resume-e2e-"));
let proc;
async function launch(){
 proc=spawn(process.execPath,[path.join(dir,"ai-agent-safari-pause-resume-preview.mjs")],{
  env:{...process.env,YT_SAFARI_TEST_HOST:"192.168.50.211",YT_SAFARI_TEST_PORT:port,YT_SAFARI_TEST_CONTROL_DIR:directory},
  cwd:path.dirname(dir),stdio:["ignore","pipe","pipe"]});
 return new Promise((resolve,reject)=>{
  let err="",buf="";
  proc.stderr.on("data",data=>{err+=String(data);});
  proc.stdout.on("data",data=>{
   buf+=String(data);
   const line=buf.split("\n")[0];
   if(!line)return;
   try{const payload=JSON.parse(line);if(payload.status==="ready")resolve(payload);}
   catch{}
  });
  proc.once("exit",code=>reject(Error("preview exited "+code+": "+err)));
  setTimeout(()=>reject(Error("preview timed out "+err)),100000).unref();
 });
}
async function cli(socket,action,args={}){
 try{
  const r=await exec(process.execPath,[path.join(dir,"ai-agent-mac-control-cli.mjs"),
   "--socket",socket,"--action",action,"--args",JSON.stringify(args)],{timeout:11000});
  return JSON.parse(r.stdout);
 }catch(ex){
  if(ex.stdout)return JSON.parse(ex.stdout);
  throw ex;
 }
}
let browser;
try{
 const preview=await launch();
 const range=await fetch("http://192.168.50.211:"+port+"/clip.mp4",
  {headers:{"Range":"bytes=0-99"}});
 assert.equal(range.status,206);
 assert.equal(Number(range.headers.get("content-length")),100);
 browser=await chromium.launch({executablePath:
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless:true,args:["--no-sandbox"]});
 const page=await browser.newPage();
 await page.goto(preview.url,{waitUntil:"domcontentloaded",timeout:20000});
 await page.waitForFunction(()=>document.querySelector("#status")?.textContent?.startsWith("Paired."),
  null,{timeout:7000}).catch(async ex=>{
   console.log("BROWSER_STATUS",await page.locator("#status").textContent());
   console.log("BROWSER_LOCATION",page.url());
   console.log("LIST_DEVICES",await cli(preview.controller_socket,"list_devices"));
   throw ex;
  });
 await page.locator("#localPlay").click();
 await page.waitForFunction(()=>document.getElementById("clip").currentTime>1.1,
  null,{timeout:12000});
 await page.locator("#localPause").click();
 const paused=await page.locator("#clip").evaluate(v=>({
  paused:v.paused,time:v.currentTime,source:v.currentSrc
 }));
 assert.ok(paused.paused,"video was manually paused");
 assert.ok(paused.time>1,"video started before pause");
 const listed=await cli(preview.controller_socket,"list_devices");
 assert.equal(listed.ok,true);
 assert.equal(listed.result.devices.length,1);
 const device_id=listed.result.devices[0].device_id;
 // ChatGPT authorizes just the Resume action; no Safari DOM approval.
 assert.equal(await page.locator("#approve").count(),0);
 const sendAt=performance.now();
 const resumed=await cli(preview.controller_socket,"resume_paired_preview");
 const latencyMs=Math.round(performance.now()-sendAt);
 assert.equal(resumed.ok,true,JSON.stringify(resumed));
 assert.equal(resumed.result.status,"completed");
 assert.equal(resumed.result.state.paused,false);
 const after=await page.locator("#clip").evaluate(v=>({
  paused:v.paused,time:v.currentTime,source:v.currentSrc
 }));
 assert.equal(after.source,paused.source,"video source was not replaced");
 assert.ok(after.time>paused.time+0.16,"existing player timeline actually advanced");
 assert.ok(latencyMs<6500,"resume command was synchronous, not a future poll");
 const readback=await cli(preview.controller_socket,"list_devices");
 assert.equal(readback.result.devices[0].state.paused,false);
 assert.ok(readback.result.devices[0].state.position_seconds>=paused.time+0.16);
 // Simulate iOS discarding/reloading the same Safari tab. Its fragment is
 // deliberately removed after pairing, so recovery MUST work from tab-scoped
 // sessionStorage without copying the private link into the address bar.
 await page.reload({waitUntil:"domcontentloaded"});
 await page.waitForFunction(()=>document.querySelector("#status")?.textContent?.startsWith("Paired."),
  null,{timeout:12000});
 const relisted=await cli(preview.controller_socket,"list_devices");
 assert.equal(relisted.result.devices.length,1);
 const newDevice=relisted.result.devices[0].device_id;
 assert.notEqual(newDevice,device_id,"reloaded Safari tab creates a new scoped connection");
 // Reload should auto reconnect with its private paired tab session, and
 // direct ChatGPT Resume should work again without any browser button.
 await page.locator("#localPlay").click();
 await page.waitForFunction(()=>document.querySelector("#clip").currentTime>0.6,
  null,{timeout:10000});
 await page.locator("#localPause").click();
 const restored=await page.locator("#clip").evaluate(v=>({
  paused:v.paused,time:v.currentTime,source:v.currentSrc
 }));
 assert.equal(restored.paused,true);
 const again=await cli(preview.controller_socket,"resume_paired_preview");
 assert.equal(again.result.status,"completed");
 assert.equal(again.result.state.paused,false);
 assert.ok(again.result.state.position_seconds>=restored.time+0.16);
 console.log(JSON.stringify({result:"PASS",browser:await browser.version(),
  previewType:"standalone Safari-compatible native H264+AAC MP4",
  localPauseAtSeconds:Number(paused.time.toFixed(2)),
  remoteResumeAtSeconds:Number(after.time.toFixed(2)),
  resumeCommandRoundtripMs:latencyMs,
  sameSource:true,timelineAdvanced:true,remoteBrowserAcknowledged:true,
  reloadRecovery:true,noBrowserApproval:true,oneToolInvocationPerResume:true,
  restoredAtSeconds:Number(restored.time.toFixed(2)),
  resumedAfterReloadAtSeconds:Number(again.result.state.position_seconds.toFixed(2)),
  output:"same existing player advances without browser approval or per-device lookup"
 },null,2));
}finally{
 await browser?.close().catch(()=>{});
 if(proc&&!proc.killed){
  const done=new Promise(r=>proc.once("exit",r));
  proc.kill("SIGTERM");
  await Promise.race([done,new Promise(r=>setTimeout(r,4000))]);
  if(proc.exitCode===null)proc.kill("SIGKILL");
 }
 await fs.rm(directory,{recursive:true,force:true});
}

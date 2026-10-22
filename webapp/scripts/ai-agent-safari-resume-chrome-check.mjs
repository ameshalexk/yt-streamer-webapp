// Chrome acceptance for the temporary Safari-compatible foreground video page.
// iOS Safari physical browser still requires a separate manual test.
import assert from "node:assert/strict";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import path from "node:path";
import os from "node:os";
import {chromium} from "playwright-core";
const exec=promisify(execFile);
const dir=path.dirname(fileURLToPath(import.meta.url));
const port="18431";
let proc;
async function launch(){
 proc=spawn(process.execPath,[path.join(dir,"ai-agent-safari-pause-resume-preview.mjs")],{
  env:{...process.env,YT_SAFARI_TEST_HOST:"192.168.50.211",YT_SAFARI_TEST_PORT:port},
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
 const request=await cli(preview.controller_socket,"request_browser_approval",
  {device_id,actions:["get_player_state","resume"]});
 assert.equal(request.result.status,"pending_browser_approval");
 await page.locator("#approve").waitFor();
 const pending=await cli(preview.controller_socket,"claim_browser_approval",
  {request_id:request.result.request_id});
 assert.equal(pending.result.status,"pending_browser_approval");
 await page.locator("#approve").click();
 const grant=await cli(preview.controller_socket,"claim_browser_approval",
  {request_id:request.result.request_id});
 assert.equal(grant.result.status,"approved");
 const scope={device_id,approval_id:grant.result.approval_id};
 const stateBefore=await cli(preview.controller_socket,"get_player_state",scope);
 assert.equal(stateBefore.result.state.paused,true);
 const sendAt=performance.now();
 const resumed=await cli(preview.controller_socket,"resume",scope);
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
 const readback=await cli(preview.controller_socket,"get_player_state",scope);
 assert.equal(readback.result.state.paused,false);
 assert.ok(readback.result.state.position_seconds>=paused.time+0.16);
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
 const revoked=await cli(preview.controller_socket,"resume",scope);
 assert.equal(revoked.result.status,"unauthorized","old connection grant not reused");
 await page.waitForFunction(()=>document.querySelector("#clip").readyState>=1&&
  document.querySelector("#clip").currentTime>=1.0,null,{timeout:9000});
 const restored=await page.locator("#clip").evaluate(v=>({
  paused:v.paused,time:v.currentTime,source:v.currentSrc
 }));
 assert.equal(restored.paused,true);
 assert.ok(restored.time>=paused.time-0.4,"paused video playhead recovered after reload");
 const second=await cli(preview.controller_socket,"request_browser_approval",{
  device_id:newDevice,actions:["get_player_state","resume"]
 });
 assert.equal(second.result.status,"pending_browser_approval");
 const pending2=await cli(preview.controller_socket,"claim_browser_approval",{
  request_id:second.result.request_id
 });
 assert.equal(pending2.result.status,"pending_browser_approval",
  "no silent reapproval across reload");
 await page.locator("#approve").click();
 const allowed2=await cli(preview.controller_socket,"claim_browser_approval",{
  request_id:second.result.request_id
 });
 assert.equal(allowed2.result.status,"approved");
 const again=await cli(preview.controller_socket,"resume",{
  device_id:newDevice,approval_id:allowed2.result.approval_id
 });
 assert.equal(again.result.status,"completed");
 assert.equal(again.result.state.paused,false);
 assert.ok(again.result.state.position_seconds>=restored.time+0.16);
 console.log(JSON.stringify({result:"PASS",browser:await browser.version(),
  previewType:"standalone Safari-compatible native H264+AAC MP4",
  localPauseAtSeconds:Number(paused.time.toFixed(2)),
  remoteResumeAtSeconds:Number(after.time.toFixed(2)),
  resumeCommandRoundtripMs:latencyMs,
  sameSource:true,timelineAdvanced:true,remoteBrowserAcknowledged:true,
  reloadRecovery:true,oldGrantRevoked:true,reloadRequiresFreshConsent:true,
  restoredAtSeconds:Number(restored.time.toFixed(2)),
  resumedAfterReloadAtSeconds:Number(again.result.state.position_seconds.toFixed(2)),
  output:"real playable video, no seek reset, reapproval after reconnection"
 },null,2));
}finally{
 await browser?.close().catch(()=>{});
 if(proc&&!proc.killed){
  const done=new Promise(r=>proc.once("exit",r));
  proc.kill("SIGTERM");
  await Promise.race([done,new Promise(r=>setTimeout(r,4000))]);
  if(proc.exitCode===null)proc.kill("SIGKILL");
 }
}

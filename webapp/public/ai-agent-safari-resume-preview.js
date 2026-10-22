// Temporary iPhone Safari foreground video-resume test. No production changes.
(()=>{
"use strict";
const $=id=>document.getElementById(id);
const video=$("clip"),status=$("status"),clock=$("clock");
// Persist the pairing proof ONLY within the current Safari tab for recovery
// when iOS reloads a suspended page. No permanent cookies/localStorage.
const supplied=new URLSearchParams(location.hash.slice(1)).get("pair");
let remembered=null;
try{remembered=sessionStorage.getItem("yt-safari-demo-pair");}catch{}
const token=supplied||remembered;
if(supplied&&/^[-_a-zA-Z0-9]{30,60}$/.test(supplied)){
 try{sessionStorage.setItem("yt-safari-demo-pair",supplied);}catch{}
}
history.replaceState(null,"",location.pathname);
const uuid=x=>typeof x==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
let ws=null,device=null,heartbeat=null;
let retryTimer=null,retryMs=400,retired=false;
function state(){
 const active=!video.paused&&!video.ended&&video.readyState>=2;
 return {title:"Safari live resume clip",media_id:"SafariDemo01",
  mode:"native_video",playback_phase:video.readyState===0?"idle":video.paused?"paused":active?"playing":"buffering",
  paused:video.paused,position_seconds:Number.isFinite(video.currentTime)?video.currentTime:0,
  duration_seconds:Number.isFinite(video.duration)?video.duration:0,observed_at:new Date().toISOString()};
}
const send=x=>ws?.readyState===WebSocket.OPEN?(ws.send(JSON.stringify(x)),true):false;
function display(){
 const s=state();
 clock.textContent="Time "+s.position_seconds.toFixed(2)+" seconds — "+(s.paused?"PAUSED":"PLAYING");
 $("frame").textContent=JSON.stringify(s,null,2);
}
async function resume(){
 if(!video.paused)return {status:"completed"};
 if(video.ended)return {status:"failed",error:"video_ended"};
 const before=video.currentTime;
 if(Number.isFinite(video.duration)&&video.duration-before<0.8)
  return {status:"failed",error:"too_near_end"};
 try{await video.play();}
 catch(ex){return {status:"needs_user_gesture",error:String(ex?.name||"play_denied")};}
 // Proof requires the SAME video element's CURRENT TIME to advance.
 const deadline=performance.now()+4600;
 while(performance.now()<deadline){
  if(!video.paused&&video.currentTime>=before+0.16)
   return {status:"completed"};
  await new Promise(done=>setTimeout(done,80));
 }
 return {status:"failed",error:"timeline_not_advancing"};
}
async function onCommand(f){
 if(!uuid(f.command_id)||f.device_id!==device||
   !["resume","pause","get_player_state"].includes(f.action))return;
 let result;
 try{
  if(f.action==="resume")result=await resume();
  else if(f.action==="pause"){video.pause();result={status:video.paused?"completed":"failed"};}
  else result={status:"completed"};
 }
 catch(ex){result={status:"failed",error:String(ex?.message||"unknown").slice(0,100)};}
 display();
 send({kind:"ack",command_id:f.command_id,status:result.status,state:state(),error:result.error});
 status.textContent=result.status==="completed"?
  "Remote "+f.action+" confirmed. Video time: "+video.currentTime.toFixed(2)+"s":
  "Resume unavailable: "+(result.error||result.status);
}
$("localPlay").addEventListener("click",async event=>{
 if(!event.isTrusted)return;
 try{await video.play();status.textContent="Started on iPhone. Pause locally, then ask ChatGPT to resume.";}
 catch(ex){status.textContent="Safari could not start: "+String(ex?.name||"unknown");}
});
$("localPause").addEventListener("click",event=>{
 if(!event.isTrusted)return;
 video.pause();status.textContent="Paused on iPhone at "+video.currentTime.toFixed(2)+"s.";
});
if(typeof token!=="string"||!/^[-_a-zA-Z0-9]{30,60}$/.test(token)){
 status.textContent="Open the private pairing link supplied by ChatGPT.";return;
}
function connect(){
 if(retired||document.visibilityState==="hidden"||
    ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING))return;
 clearTimeout(retryTimer);retryTimer=null;
 let socket;
 try{socket=new WebSocket(location.origin.replace(/^http/,"ws")+"/control");}
 catch{scheduleReconnect();return;}
 ws=socket;
 status.textContent="Connecting to Mac Control preview...";
 socket.addEventListener("open",()=>{
  if(ws!==socket)return;
  send({kind:"pair",proof:token,label:"iPhone Safari resume preview"});
 });
 socket.addEventListener("message",event=>{
  if(ws!==socket)return;
 let f;try{f=JSON.parse(event.data);}catch{ws.close();return;}
 if(f.kind==="registered"){
  if(!uuid(f.device_id)){ws.close();return;}
  device=f.device_id;retryMs=400;
  status.textContent="Paired. Ready for a single ChatGPT Resume command.";
  clearInterval(heartbeat);
  const beat=()=>send({kind:"heartbeat",state:state()});
  beat();heartbeat=setInterval(beat,1000);
 }else if(f.kind==="command")void onCommand(f);
 });
 socket.addEventListener("close",()=>{
  if(ws!==socket)return;
  disconnect();ws=null;
  if(!retired)scheduleReconnect();
 });
 socket.addEventListener("error",()=>{
  if(ws===socket)status.textContent="Connection interrupted; retrying when Safari is active.";
 });
}
function disconnect(){
 clearInterval(heartbeat);heartbeat=null;device=null;status.textContent="Disconnected; automatically reconnecting when Safari is visible.";
}
function scheduleReconnect(){
 if(retired||retryTimer||document.visibilityState==="hidden")return;
 const delay=retryMs;
 retryMs=Math.min(5000,Math.round(retryMs*1.6));
 retryTimer=setTimeout(()=>{retryTimer=null;connect();},delay);
}
function reconnectOnReturn(){
 if(retired||document.visibilityState==="hidden")return;
 if(!ws||ws.readyState===WebSocket.CLOSED||ws.readyState===WebSocket.CLOSING){
  if(ws?.readyState===WebSocket.CLOSING)ws=null;
  clearTimeout(retryTimer);retryTimer=null;connect();
 }
}
document.addEventListener("visibilitychange",reconnectOnReturn);
addEventListener("focus",reconnectOnReturn);
addEventListener("pageshow",reconnectOnReturn);
addEventListener("pagehide",()=>{
 // Do not permanently disable the tab: bfcache restoration must reconnect.
 clearTimeout(heartbeat);heartbeat=null;
 clearTimeout(retryTimer);retryTimer=null;
 ws?.close();ws=null;disconnect();
});
const SAVE_KEY="yt-safari-demo-position";
function savePosition(){
 if(!Number.isFinite(video.currentTime)||video.currentTime<=0)return;
 try{sessionStorage.setItem(SAVE_KEY,String(video.currentTime));}catch{}
}
video.addEventListener("loadedmetadata",()=>{
 // iOS can discard a backgrounded tab; restore the previous paused playhead.
 const saved=Number((()=>{try{return sessionStorage.getItem(SAVE_KEY);}catch{return null;}})());
 if(Number.isFinite(saved)&&saved>0&&saved+0.7<video.duration&&video.currentTime<0.15)
  video.currentTime=saved;
 display();
});
video.addEventListener("timeupdate",()=>{savePosition();display();});
video.addEventListener("pause",()=>{savePosition();display();});
video.addEventListener("ended",()=>{
 try{sessionStorage.removeItem(SAVE_KEY);}catch{}
 display();
});
["play","loadedmetadata"].forEach(name=>video.addEventListener(name,display));
connect();
display();
})();

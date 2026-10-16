import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

class Node {
  constructor() { this.disabled=true; this.hidden=false; this.listeners={}; this.title=""; this.href=""; this.textContent=""; }
  addEventListener(kind,action) {this.listeners[kind]=action;}
  async tap() {return await this.listeners.click?.();}
}
test("Classic and New share one player control; VLC remains optional and keeps playback state",async()=>{
  const root=path.resolve("public");
  const html=await fs.readFile(path.join(root,"index.html"),"utf8");
  assert.equal((html.match(/id="castVlcBtn"/g)||[]).length,1);
  assert.match(html,/data-ui-mode="classic"/);
  assert.match(html,/data-ui-mode="new"/);
  assert.match(html,/src="\/vlc-cast\.js/);
  const names=["castVlcBtn","castVlcPanel","castVlcStatus","castVlcOpen","castVlcCopy","castVlcShare","castVlcStop","castVlcRefresh","castVlcClose"];
  const nodes=Object.fromEntries(names.map(id=>[id,new Node()]));
  const calls=[];
  let copied="";
  const context={
    document:{getElementById:id=>nodes[id]},window:{},URL,
    location:{origin:"https://stream.example"},
    navigator:{clipboard:{writeText:async value=>{copied=value;}},share:async()=>{}},
    fetch:async(url,options)=>{
      calls.push({url,options});
      if(options.method==="POST")return {ok:true,status:201,json:async()=>({
        id:"abcdefghijklmnop",url:"https://stream.example/cast/media/abcdefghijklmnop/ticket123/index.m3u8",
        expiresAt:"2026-10-11T22:00:00Z"})};
      return {ok:true,status:204};
    },
  };
  vm.runInNewContext(await fs.readFile(path.join(root,"vlc-cast.js"),"utf8"),context);
  assert.ok(context.window.ytStreamerVlcCast);
  context.window.ytStreamerVlcCast.setSource({mjpegUrl:"/stream/item/saved-video?fps=24"}, {isLive:false});
  assert.equal(nodes.castVlcBtn.disabled,false);
  await nodes.castVlcBtn.tap();
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,"/api/cast/sessions");
  assert.equal(JSON.parse(calls[0].options.body).id,"saved-video");
  assert.match(nodes.castVlcOpen.href,/^vlc-x-callback:\/\/x-callback-url\/stream\?url=/);
  assert.equal(nodes.castVlcOpen.hidden,false);
  assert.equal(nodes.castVlcRefresh.disabled,false);
  assert.match(nodes.castVlcStatus.textContent,/seek|pause/i);
  await nodes.castVlcCopy.tap();
  assert.match(copied,/https:\/\/stream\.example\/cast\/media/);
  await nodes.castVlcStop.tap();
  assert.equal(calls[1].options.method,"DELETE");
  assert.equal(nodes.castVlcPanel.hidden,true);
  await nodes.castVlcClose.tap();
  assert.equal(nodes.castVlcPanel.hidden,true);
  context.window.ytStreamerVlcCast.setSource({mjpegUrl:"/stream/url?url=https%3A%2F%2Fexample.com"}, {});
  assert.equal(nodes.castVlcBtn.disabled,true);
  context.window.ytStreamerVlcCast.setSource(null);
  assert.equal(nodes.castVlcBtn.disabled,true);
});

test("New UI adds reachable VLC cast quick action linked to shared player button",async()=>{
  const src=await fs.readFile(path.resolve("public/modern-ui.js"),"utf8");
  assert.match(src,/quick\("Cast \/ VLC", "modern-cast-vlc", "#castVlcBtn"\)/);
  assert.match(src,/castQuickButton\.disabled/);
  assert.match(src,/quickBar\.insertBefore\(castQuickButton, quickBar\.firstChild\)/);
  const css=await fs.readFile(path.resolve("public/styles.css"),"utf8");
  assert.match(css,/html\[data-ui='new'\] #castVlcPanel:not\(\[hidden\]\)/);
});

test("temporary reconnect failure preserves existing VLC link; confirmed expiry clears it",async()=>{
  const src=await fs.readFile(path.resolve("public/vlc-cast.js"),"utf8");
  const names=["castVlcBtn","castVlcPanel","castVlcStatus","castVlcOpen","castVlcCopy",
    "castVlcShare","castVlcStop","castVlcRefresh","castVlcClose"];
  const nodes=Object.fromEntries(names.map(id=>[id,new Node()]));
  let checkFailure="offline";
  const context={
    document:{getElementById:id=>nodes[id],addEventListener(){}},
    window:{},URL,location:{origin:"https://stream.example"},
    navigator:{clipboard:{writeText:async()=>{}},share:async()=>{}},
    fetch:async(_url,options)=>{
      if(options.method==="POST")return {ok:true,status:201,json:async()=>({
        id:"abcdefghijklmnop",url:"https://cast.example/cast/media/abcdefghijklmnop/".concat("a".repeat(43),"/index.m3u8"),
        expiresAt:"2026-10-12T04:00:00Z",seekable:true,mode:"vod",idleMinutes:45
      })};
      if(options.method==="GET"){
        if(checkFailure==="offline") throw Error("network unavailable");
        if(checkFailure==="expired")return {ok:false,status:404,json:async()=>({error:"session no longer exists"})};
        return {ok:true,status:200,json:async()=>({status:"ready",seekable:true,mode:"vod"})};
      }
      return {ok:true,status:204};
    }
  };
  vm.runInNewContext(src,context);
  context.window.ytStreamerVlcCast.setSource({mjpegUrl:"/stream/item/saved-video"});
  await nodes.castVlcBtn.tap();
  const previousHref=nodes.castVlcOpen.href;
  await nodes.castVlcRefresh.tap();
  assert.equal(nodes.castVlcOpen.hidden,false,"network loss must preserve VLC deep link");
  assert.equal(nodes.castVlcOpen.href,previousHref);
  assert.equal(nodes.castVlcStop.disabled,false);
  assert.match(nodes.castVlcStatus.textContent,/preserved/);
  checkFailure="working";
  await nodes.castVlcRefresh.tap();
  assert.match(nodes.castVlcStatus.textContent,/Session active/);
  checkFailure="expired";
  await nodes.castVlcRefresh.tap();
  assert.equal(nodes.castVlcOpen.hidden,true,"confirmed 404 must clear expired URL");
  assert.equal(nodes.castVlcStop.disabled,true);
});

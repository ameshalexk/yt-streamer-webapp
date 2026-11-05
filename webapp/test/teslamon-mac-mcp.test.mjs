import test from 'node:test';
import assert from 'node:assert/strict';
import {createMacCommandService,callMac} from '../src/lib/teslamon-mac-mcp.js';
import {validateDevicePlan} from '../src/lib/teslamon-device-plan.js';
import {parseTeslaMonDeviceUrl} from '../public/teslamon-device-url.js';
import {parseTeslaMonVideoUrl} from '../public/teslamon-video-url.js';
const identity='c'.repeat(64),other='d'.repeat(64),session='12345678-1234-1234-1234-123456789abc';
function fixture(reply,{now=()=>0}={}){
  const calls=[];
  const call=async(name,args)=>{
    calls.push({name,args});
    return {
      system_info:{success:true,macos:{product_version:'27.0.1'},architecture:'arm64',uptime:{human:'1d'},disk:{available_gib:8.4}},
      network_status:{success:true,default_route:{interface:'en0'},interfaces:[{name:'en0',addresses:[{family:'IPv4',address:'192.168.1.2'}]}],dns_servers:['1.1.1.1']},
      window_list:{success:true,windows:[{application:'Safari',title:'Private page'},{application:'Safari',title:'Another private page'},{application:'Notes',title:'Private note'}]},
      app_is_installed:{success:true,installed:true},launchd_status:{success:true,state:'running'},
      app_open:{success:true},window_focus:{success:true}
    }[name];
  };
  return {calls,api:createMacCommandService({planner:{plan:async()=>reply},call,now})};
}
test('mac namespace protects video and other site routes',()=>{
  assert.deepEqual(parseTeslaMonDeviceUrl('/mac/open%20Safari'),{provider:'mac',text:'open Safari'});
  assert.deepEqual(parseTeslaMonDeviceUrl('/mac/Open+Safari'),{provider:'mac',text:'Open Safari'});
  assert.equal(parseTeslaMonVideoUrl('/mac/openSafari'),null);
  assert.equal(parseTeslaMonVideoUrl('/%256dac%252fopenSafari'),null);
  assert.equal(parseTeslaMonDeviceUrl('/mac/%2Fapi%2Fsecrets'),null);
  assert.equal(parseTeslaMonDeviceUrl('/retro'),null);
  assert.equal(parseTeslaMonVideoUrl('/playlatestvideo'),'playlatestvideo');
});
test('Mac planner rejects tools from other domains or invalid values',()=>{
  assert.equal(validateDevicePlan({op:'mac_info',target:'',value:null},{provider:'mac'}).status,'ok');
  assert.equal(validateDevicePlan({op:'terminal_run',target:'any',value:null},{provider:'mac'}).status,'failed');
  assert.equal(validateDevicePlan({op:'light_on',target:'light.kitchen',value:null},{provider:'mac'}).status,'failed');
  assert.equal(validateDevicePlan({op:'mac_info',target:'anything',value:null},{provider:'mac'}).status,'failed');
  assert.equal(validateDevicePlan({op:'mac_app_open',target:'Safari',value:75},{provider:'mac'}).status,'failed');
});
test('Mac read-only info filters personal fields and never executes actions',async()=>{
  const {api,calls}=fixture({status:'ok',op:'mac_info',target:'',value:null,write:false});
  const r=await api.plan('mac status',session,identity);
  assert.match(r.message,/macOS 27.0.1/);
  assert.deepEqual(calls.map(x=>x.name),['system_info']);
});
test('window query omits private titles',async()=>{
  const {api,calls}=fixture({status:'ok',op:'mac_windows',target:'',value:null,write:false});
  const r=await api.plan('open apps',session,identity);
  assert.match(r.message,/Safari, Notes/);
  assert.doesNotMatch(r.message,/Private note|Private page/);
  assert.equal(calls[0].name,'window_list');
});
test('Mac write requires one-use approval for exact signed identity',async()=>{
  const {api,calls}=fixture({status:'ok',op:'mac_app_open',target:'Safari',value:null,write:true});
  const p=await api.plan('open Safari',session,identity);
  assert.equal(p.status,'confirm_required');assert.equal(calls.length,0);
  assert.equal((await api.confirm(p.id,session,other)).code,'confirmation_expired');
  assert.equal(calls.length,0);
  const next=await api.plan('open Safari',session,identity);
  assert.equal((await api.confirm(next.id,session,identity)).status,'ok');
  assert.deepEqual(calls,[{name:'app_open',args:{name:'Safari'}}]);
  assert.equal((await api.confirm(next.id,session,identity)).code,'confirmation_expired');
});
test('unallowlisted Mac apps never execute and focus needs confirmation',async()=>{
  const bad=fixture({status:'ok',op:'mac_app_open',target:'Terminal',value:null,write:true});
  assert.equal((await bad.api.plan('open Terminal',session,identity)).status,'unsupported');
  assert.equal(bad.calls.length,0);
  const focus=fixture({status:'ok',op:'mac_window_focus',target:'Google Chrome',value:null,write:true});
  const proposal=await focus.api.plan('focus Chrome',session,identity);
  assert.equal(focus.calls.length,0);
  await focus.api.confirm(proposal.id,session,identity);
  assert.deepEqual(focus.calls,[{name:'window_focus',args:{application:'Google Chrome',confirm:true}}]);
});
test('expiry and malformed service names fail without MCP calls',async()=>{
  let clock=0;
  const {api,calls}=fixture({status:'ok',op:'mac_app_open',target:'Notes',value:null,write:true},{now:()=>clock});
  const p=await api.plan('open Notes',session,identity);clock+=90001;
  assert.equal((await api.confirm(p.id,session,identity)).code,'confirmation_expired');
  assert.equal(calls.length,0);
  const label=fixture({status:'ok',op:'mac_launchd_status',target:'not-a-valid/label',value:null,write:false});
  assert.equal((await label.api.plan('service',session,identity)).code,'invalid_launch_agent');
  assert.equal(label.calls.length,0);
});
test('Mac MCP blocks unknown tool names before connection',async()=>{
  await assert.rejects(callMac('terminal_run',{command:'echo'}),/disallowed_mac_tool/);
});

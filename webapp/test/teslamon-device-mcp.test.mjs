import test from 'node:test';
import assert from 'node:assert/strict';
import {createHACommandService,callHA} from '../src/lib/teslamon-device-mcp.js';
import {validateDevicePlan} from '../src/lib/teslamon-device-plan.js';
import {parseTeslaMonDeviceUrl} from '../public/teslamon-device-url.js';
import {parseTeslaMonVideoUrl} from '../public/teslamon-video-url.js';
const identity='a'.repeat(64),other='b'.repeat(64),session='12345678-1234-1234-1234-123456789abc';
const fixtures={
  search_entities:{success:true,items:[{entity_id:'light.kitchen_main',friendly_name:'Kitchen main',state:'off'}],has_more:false},
  get_entity_state:{success:true,entity_id:'light.kitchen_main',friendly_name:'Kitchen main',state:'off'},
  list_areas:{success:true,items:[{name:'Kitchen'},{name:'Office'}]},
  control_light:{success:true}
};
function service(reply,{time=()=>0,fixturesByName=fixtures}={}){
  const calls=[];
  const api=createHACommandService({planner:{plan:async()=>reply},now:time,
    call:async(name,args)=>{calls.push({name,args});return fixturesByName[name]||{success:true}}});
  return {api,calls};
}
test('explicit HA namespace and encoded Unicode; never repurpose web routes or video URLs',()=>{
  assert.deepEqual(parseTeslaMonDeviceUrl('/ha/turn%20on%20Kitchen'),{provider:'ha',text:'turn on Kitchen'});
  assert.deepEqual(parseTeslaMonDeviceUrl('/ha/'+encodeURIComponent('വീട്ട്')),{provider:'ha',text:'വീട്ട്'});
  for(const url of ['/ha','/ha/','/ha/a%2Fb','/ha/%00turn','/retro','/retrotv/','/api/teslamon/ha-plan']){
    assert.equal(parseTeslaMonDeviceUrl(url),null,url);
  }
  assert.equal(parseTeslaMonVideoUrl('/ha/turnofflights'),null);
  assert.equal(parseTeslaMonVideoUrl('/%2568a%252Fturnofflights'),null);
  assert.equal(parseTeslaMonVideoUrl('/playlatestvideo'),'playlatestvideo');
});
test('allowlist validation rejects device credentials and arbitrary Codex commands',()=>{
  assert.equal(validateDevicePlan({op:'terminal_run',target:'ls',value:null}).status,'failed');
  assert.equal(validateDevicePlan({op:'thermostat_temp',target:'climate.office',value:10}).status,'failed');
  assert.equal(validateDevicePlan({op:'light_on',target:'light.kitchen',value:80}).status,'failed');
  assert.equal(validateDevicePlan({op:'state',target:'lights/../../secrets',value:null}).status,'failed');
  assert.equal(validateDevicePlan({op:'light_on',target:'Kitchen light',value:null}).write,true);
});
test('read-only plan calls only safe HA search/state tools',async()=>{
  const {api,calls}=service({status:'ok',op:'state',target:'kitchen main',value:null,write:false});
  const r=await api.plan('check kitchen light',session,identity);
  assert.equal(r.status,'ok');assert.match(r.message,/Kitchen main: off/);
  assert.deepEqual(calls.map(x=>x.name),['search_entities','get_entity_state']);
});
test('sensors and other HA entities can be queried but not controlled',async()=>{
  const {api,calls}=service({status:'ok',op:'state',target:'sensor.office_temperature',value:null,write:false},
    {fixturesByName:{...fixtures,get_entity_state:{success:true,entity_id:'sensor.office_temperature',state:'74',unit_of_measurement:'°F'}}});
  assert.match((await api.plan('office temperature',session,identity)).message,/74 °F/);
  assert.deepEqual(calls.map(c=>c.name),['get_entity_state']);
});
test('signed, allowlisted HA write executes hands-free exactly once per request',async()=>{
  const {api,calls}=service({status:'ok',op:'light_on',target:'Kitchen main',value:null,write:true});
  assert.equal((await api.plan('turn on kitchen main',session,other)).status,'ok');
  assert.deepEqual(calls.map(x=>x.name),['search_entities','control_light']);
  assert.deepEqual(calls.at(-1).args,{entity_id:'light.kitchen_main',action:'turn_on',confirm:true});
  assert.equal(typeof api.confirm,'undefined','no separate HA approval endpoint');
  assert.equal((await api.plan('turn on kitchen main','invalid-session',identity)).code,'invalid_device_request');
  assert.equal(calls.filter(x=>x.name==='control_light').length,1,'bad session did not change devices');
});
test('ambiguous targets and failed writes never report completion',async()=>{
  const multi=service({status:'ok',op:'light_off',target:'Kitchen',value:null,write:true},
    {fixturesByName:{...fixtures,search_entities:{items:[
      {entity_id:'light.one',state:'on'},{entity_id:'light.two',state:'off'}],has_more:false}}});
  assert.equal((await multi.api.plan('turn off kitchen',session,identity)).code,'ambiguous_entity');
  assert.equal(multi.calls.some(x=>x.name==='control_light'),false);
  const failed=service({status:'ok',op:'light_on',target:'light.kitchen_main',value:null,write:true},
    {fixturesByName:{...fixtures,control_light:{success:false}}});
  assert.equal((await failed.api.plan('turn on kitchen',session,identity)).code,'device_change_not_confirmed');
  assert.equal(failed.calls.filter(x=>x.name==='control_light').length,1);
});
test('room-wide lights execute without a second click and never use generic service calls',async()=>{
  const {api,calls}=service({status:'ok',op:'area_light_off',target:'Kitchen',value:null,write:true});
  const result=await api.plan('turn off kitchen lights',session,identity);
  assert.equal(result.status,'ok');
  assert.match(result.message,/lights in Kitchen/);
  assert.deepEqual(calls,[{name:'control_light',args:{area:'Kitchen',action:'turn_off',confirm:true}}]);
});

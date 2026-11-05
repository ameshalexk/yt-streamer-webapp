import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Writable,PassThrough} from 'node:stream';
import {createDevicePlanner,validateUrlRoute} from '../src/lib/teslamon-device-plan.js';

function fakeModel(output,calls){
  return (binary,args,opts)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({write(chunk,_enc,cb){calls.push({prompt:String(chunk),args,binary,opts});cb();}});
    child.kill=()=>queueMicrotask(()=>child.emit('close',null));
    queueMicrotask(()=>{
      child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}})+'\n');
      child.stdout.write(JSON.stringify({type:'turn.completed'})+'\n');
      child.stdout.end();child.emit('close',0);
    });
    return child;
  };
}
function router(reply){const calls=[];return {calls,client:createDevicePlanner({provider:'route',
  binary:'/safe/codex',workspace:'/private/isolated',supported:true,binaryExists:()=>true,
  launch:fakeModel(reply,calls)})};}

test('URL router validates an exact bounded five-route schema',()=>{
  assert.deepEqual(validateUrlRoute({route:'ha',text:'turn on game room lights',message:''}),
    {status:'ok',route:'ha',text:'turn on game room lights'});
  assert.deepEqual(validateUrlRoute({route:'video',text:'pause video',message:''}),
    {status:'ok',route:'video',text:'pause video'});
  assert.deepEqual(validateUrlRoute({route:'answer',text:'',message:'Four.'}),
    {status:'ok',route:'answer',message:'Four.'});
  assert.equal(validateUrlRoute({route:'unsupported',text:'',message:'No Tesla tool connected.'}).status,'unsupported');
  for(const invalid of [
    {route:'terminal',text:'ls',message:''},
    {route:'ha',text:'turn on lights',message:'Already done'},
    {route:'answer',text:'run command',message:'Done'},
    {route:'mac',text:'x',message:''},
    {route:'ha',text:'turn on lights',message:'',shell:'curl'},
    {route:'answer',text:'',message:'A'.repeat(501)}
  ]) assert.equal(validateUrlRoute(invalid).code,'invalid_url_route');
});

test('model router has a separate strict schema and no MCP or device tools',async()=>{
  const {client,calls}=router({route:'ha',text:'turn on game room lights',message:''});
  assert.deepEqual(await client.plan('turnonnthegameroomlights'),
    {status:'ok',route:'ha',text:'turn on game room lights'});
  assert.equal(calls.length,1);
  assert.match(calls[0].prompt,/no spaces|word boundaries/i);
  assert.match(calls[0].args.join(' '),/teslamon-url-route.schema.json/);
  assert.ok(calls[0].args.includes('--ignore-user-config'));
  assert.ok(calls[0].args.includes('read-only'));
  assert.doesNotMatch(calls[0].args.join(' '),/mcp_servers|danger-full-access|exec sudo/);
});

test('model cannot turn untrusted URL text into shell or device actions',async()=>{
  const {client}=router({route:'unsupported',text:'',message:'Not supported through this URL.'});
  assert.equal((await client.plan('run curl to unlock my door')).status,'unsupported');
  assert.equal((await client.plan('a\nb')).code,'invalid_device_request');
});

test('general read-only question is returned as text, never a tool invocation',async()=>{
  const {client}=router({route:'answer',text:'',message:'Two plus two is four.'});
  assert.deepEqual(await client.plan('whatis2plus2'),
    {status:'ok',route:'answer',message:'Two plus two is four.'});
});

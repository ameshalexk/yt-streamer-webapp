import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createTeslaMonCodex,validateCodexPlan} from '../src/lib/teslamon-codex-cli.js';

const SESSION='d65d564b-4d87-4197-a528-d557602f7777';
const ID='b'.repeat(64);
const THREAD='346c1081-bdf3-4b5d-9d4e-6b89ec86ab92';
const fakeProcess=(responses,record)=>{
  let turn=0;
  return (exe,args,opts)=>{
    record.push({exe,args,opts});
    const child=new EventEmitter();
    child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{queueMicrotask(()=>child.emit('close',null));};
    child.stdin=new Writable({write(_part,_enc,cb){cb();},
      final(cb){cb();queueMicrotask(()=>{
        const answer=responses[turn++]||{tool:'pause',query:''};
        const emit=o=>child.stdout.write(JSON.stringify(o)+'\n');
        emit({type:'thread.started',thread_id:THREAD});
        emit({type:'turn.started'});
        if(answer.disallowed)emit({type:'item.completed',item:{type:'command_execution'}});
        else emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(answer)}});
        emit({type:'turn.completed'});
        child.stdout.end();child.emit('close',0);
      });}});
    return child;
  };
};
const client=(responses,record)=>createTeslaMonCodex({
  binary:'/private/test-codex',workspace:'/private/test-workspace',
  isSupportedPlatform:true,binaryExists:()=>true,
  launch:fakeProcess(responses,record),timeoutMs:15000
});
test('Codex plan validator strictly permits six current-tab playback commands',()=>{
  assert.deepEqual(validateCodexPlan({tool:'pause',query:''}),
    {status:'ok',tool:'pause',args:{}});
  assert.deepEqual(validateCodexPlan({tool:'search_and_play',query:'MKBHD'}),{
    status:'ok',tool:'search_and_play',args:{query:'MKBHD'}});
  for(const p of [
    {tool:'shell',query:''},
    {tool:'search_and_play',query:'https://example.org'},
    {tool:'pause',query:'unsupported argument'},
    {tool:'pause',query:'',shell:true},
    {tool:'search_and_play',query:'x'}
  ])assert.notEqual(validateCodexPlan(p).status,'ok');
});
test('Codex CLI receives prompt ONLY on stdin and invokes read-only/no-config',async()=>{
  const calls=[];const t=client([{tool:'pause',query:''}],calls);
  assert.equal(t.available,true);
  const result=await t.plan('Pause please; none of this goes into argv',SESSION,ID);
  assert.deepEqual(result,{status:'ok',tool:'pause',args:{}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].args.includes('--ignore-user-config'),true);
  assert.equal(calls[0].args.includes('read-only'),true);
  assert.equal(calls[0].args.includes('--json'),true);
  assert.equal(calls[0].args.some(x=>x.includes('Pause please')),false);
  assert.equal(calls[0].opts.env.CODEX_HOME.endsWith('/.codex'),true);
});
test('Separate turns resume bounded Codex conversation without passing text in args',async()=>{
  const calls=[];const t=client([{tool:'pause',query:''},{tool:'resume',query:''}],calls);
  await t.plan('pause',SESSION,ID);
  await t.plan('resume',SESSION,ID);
  assert.equal(calls.length,2);
  assert.equal(calls[1].args.includes('resume'),true);
  assert.equal(calls[1].args.includes(THREAD),true);
  assert.equal(calls[1].args.includes('--ignore-user-config'),true);
  assert.equal(calls[1].args.includes('sandbox_mode="read-only"'),true);
});
test('Disallowed Codex tool output never becomes a playback action',async()=>{
  const calls=[];const t=client([{disallowed:true}],calls);
  assert.equal((await t.plan('run a shell',SESSION,ID)).code,'codex_disallowed_tool');
});
test('Invalid session, identity or multiline input never starts CLI',async()=>{
  const calls=[];const t=client([],calls);
  assert.equal((await t.plan('pause','xxx',ID)).code,'invalid_codex_request');
  assert.equal((await t.plan('pause',SESSION,'admin')).code,'invalid_codex_request');
  assert.equal((await t.plan('pause\nresume',SESSION,ID)).code,'invalid_codex_request');
  assert.equal(calls.length,0);
});
test('HA never starts Mac-specific Codex process',async()=>{
  const t=createTeslaMonCodex({isSupportedPlatform:false,binaryExists:()=>true,
    binary:'/bin/codex',workspace:'/tmp'});
  assert.equal(t.available,false);
  assert.equal((await t.plan('pause',SESSION,ID)).status,'unavailable');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeslaMonModelPlanner} from '../src/lib/teslamon-model-planner.js';

const output=(proposal)=>({
  ok:true,async json(){return {status:'completed',
    output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(proposal)}]}]
  }; }
});
test('optional parser is unavailable without explicitly configured credentials',async()=>{
  const planner=createTeslaMonModelPlanner({apiKey:'',model:''});
  assert.equal(planner.available,false);
  const result=await planner.interpret('pause');
  assert.equal(result.code,'model_not_configured');
});
test('optional model sees no tools and cannot select owner, target or execute',async()=>{
  let count=0;
  const planner=createTeslaMonModelPlanner({
    apiKey:'dummy-key-for-isolated-test',model:'gpt-4o-mini',
    fetchImpl:async(uri,options)=>{
      count++;
      assert.equal(uri,'https://api.openai.com/v1/responses');
      assert.equal(options.method,'POST');
      const body=JSON.parse(options.body);
      assert.deepEqual(body.tools,[]);
      assert.equal(body.store,false);
      assert.equal(body.text.format.strict,true);
      assert.equal(body.text.format.type,'json_schema');
      assert.equal(body.input[1].content,'please pause');
      return output({tool:'pause',query:null});
    }
  });
  const result=await planner.interpret('please pause');
  assert.deepEqual(result,{status:'ok',tool:'pause',args:{}});
  assert.equal(count,1);
});
test('model output is denied if tool outside six-action allowlist',async()=>{
  for(const tool of ['shell','tesla_unlock','file_write','home_assistant']){
    const planner=createTeslaMonModelPlanner({
      apiKey:'dummy-key-for-isolated-test',model:'gpt-4o-mini',
      fetchImpl:async()=>output({tool,query:null})
    });
    const result=await planner.interpret('please do that');
    assert.equal(result.status,'failed');
  }
});
test('model search must be a bounded YouTube title phrase, not arbitrary URL',async()=>{
  for(const proposal of [
    {tool:'search_and_play',query:'https://example.com/video'},
    {tool:'search_and_play',query:'x'},
    {tool:'search_and_play',query:'x'.repeat(130)},
    {tool:'pause',query:'impersonate'},
    {tool:'none',query:null}
  ]){
    const planner=createTeslaMonModelPlanner({
      apiKey:'dummy-key-for-isolated-test',model:'gpt-4o-mini',
      fetchImpl:async()=>output(proposal)
    });
    const result=await planner.interpret('Do something else');
    assert.equal(result.status,'failed');
  }
  const allowed=createTeslaMonModelPlanner({
    apiKey:'dummy-key-for-isolated-test',model:'gpt-4o-mini',
    fetchImpl:async()=>output({tool:'search_and_play',query:'MKBHD latest video'})
  });
  assert.deepEqual(await allowed.interpret('play the latest Marques Brownlee video'),
    {status:'ok',tool:'search_and_play',args:{query:'MKBHD latest video'}});
});
test('invalid HTTP results do not trigger any execution',async()=>{
  const planner=createTeslaMonModelPlanner({
    apiKey:'dummy-key-for-isolated-test',model:'gpt-4o-mini',
    fetchImpl:async()=>({ok:false})
  });
  assert.equal((await planner.interpret('pause')).code,'model_request_failed');
  assert.equal((await planner.interpret('x')).code,'invalid_text');
});

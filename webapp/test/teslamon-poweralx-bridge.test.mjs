import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const src=fileURLToPath(new URL('../src/lib/teslamon-poweralx-bridge.py',import.meta.url));
// Allow cold-start scheduling delays on busy macOS CI runners; no network or model is loaded.
const BRIDGE_TEST_TIMEOUT_MS=15000;
function run(script){
  const r=spawnSync('/usr/bin/python3',['-c',
    'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("bridge",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); '+script,
    src],{timeout:BRIDGE_TEST_TIMEOUT_MS,encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
  assert.equal(r.status,0,`bridge isolated validator check failed: ${r.error?.message || r.stderr || 'unknown error'}`);
  return JSON.parse(r.stdout.trim());
}
test('existing-worker result binds recording ID and SHA, extracts English transcript',()=>{
  const result=run('p={"id":"fixed","sha256":"abc","final":True,"status":"complete","segments":[{"language":"en","original":"play MKBHD"},{"language":"ml","original":"മലയാളം","english":"video"},{"language":"unclear","original":"ignore"}]}; print(json.dumps({"text":m.validate_response(p,"fixed","abc")}))');
  assert.deepEqual(result,{text:'play MKBHD video'});
});
test('PowerALX bridge refuses mismatched or incomplete transcript data',()=>{
  const reply=run('p={"id":"other","sha256":"abc","final":True,"status":"complete","segments":[]}; e=[]; p2={"id":"fixed","sha256":"abc","final":False,"status":"incomplete","segments":[]};\nfor data in [p,p2]:\n try: m.validate_response(data,"fixed","abc")\n except m.TranscribeFailed as x: e.append(str(x))\nprint(json.dumps({"errors":e}))');
  assert.deepEqual(reply.errors,['poweralx_result_identity_mismatch','poweralx_result_incomplete']);
});
test('No Mac model load: Python helper validates arguments before any worker transport',()=>{
  const p=spawnSync('/usr/bin/python3',[src,'--mime','text/html','--worker-root',
    'C:\\Users\\Amesh\\life-recorder-worker','--release','phase1-20260912-b',
    '--ssh-host','poweralx'],{input:Buffer.alloc(0),encoding:'utf8',timeout:BRIDGE_TEST_TIMEOUT_MS});
  assert.equal(p.status,0);
  assert.deepEqual(JSON.parse(p.stdout.trim()),
    {status:'failed',code:'invalid_configuration'});
});

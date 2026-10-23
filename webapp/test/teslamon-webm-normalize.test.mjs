import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('Safari WebM normalizer preserves audio length and yields seekable M4A',()=>{
  const run=spawnSync('python3',['-m','unittest','discover','-s','test',
    '-p','teslamon_webm_normalize_test.py'],{
    cwd:process.cwd(),encoding:'utf8',timeout:25000
  });
  assert.equal(run.status,0,run.error?.message||run.stderr||'PowerALX audio regression');
});

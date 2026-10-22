import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('Safari audio packet probe and rejection coverage (no Mac ASR)', () => {
  const run=spawnSync('python3',['-m','unittest','discover','-s','test',
    '-p','teslamon_poweralx_bridge_test.py'],{cwd:process.cwd(),encoding:'utf8',timeout:20000});
  assert.equal(run.status,0,run.error?.message||run.stderr||'Python audio tests failed');
});

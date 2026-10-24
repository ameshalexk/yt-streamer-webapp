import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeslaMonAutoSend} from '../public/teslamon-auto-send.js';

function setup() {
  let clock = 0, nextId = 0;
  const jobs = new Map(), sent = [];
  let value = '', busy = false;
  const timers = {
    setTimeout(fn, wait) { const id = ++nextId; jobs.set(id, {at:clock+wait, fn}); return id; },
    clearTimeout(id) { jobs.delete(id); },
  };
  function advance(ms) {
    const end = clock + ms;
    while (true) {
      const due = [...jobs].filter(([, job]) => job.at <= end)
        .sort((a,b) => a[1].at-b[1].at)[0];
      if (!due) break;
      clock = due[1].at;
      jobs.delete(due[0]);
      due[1].fn();
    }
    clock = end;
  }
  const autosend = createTeslaMonAutoSend({
    readText:()=>value,send:text=>sent.push(text),canSend:()=>!busy,timers,
  });
  return {autosend,sent,advance,setText:text=>{value=text;autosend.changed();},
    setBusy:x=>{busy=x;}};
}

test('pasted complete sentence sends exactly once after two seconds',()=>{
  const x=setup();
  x.setText('play the latest MKBHD video');
  x.advance(1999);assert.deepEqual(x.sent,[]);
  x.advance(1);assert.deepEqual(x.sent,['play the latest MKBHD video']);
  x.advance(6000);assert.equal(x.sent.length,1);
});

test('every typed or dictated text change restarts quiet-time countdown',()=>{
  const x=setup();
  x.setText('play');
  x.advance(1700);
  x.setText('play MKBHD');
  x.advance(1999);assert.deepEqual(x.sent,[]);
  x.advance(1);assert.deepEqual(x.sent,['play MKBHD']);
});

test('manual submit cancels pending automatic duplicate',()=>{
  const x=setup();
  x.setText('fullscreen');
  x.advance(900);
  x.autosend.cancel();
  x.advance(5000);assert.deepEqual(x.sent,[]);
});

test('IME composition and empty text never trigger premature dispatch',()=>{
  const x=setup();
  x.autosend.compositionStart();
  x.setText('partly composed');
  x.advance(3000);assert.deepEqual(x.sent,[]);
  x.autosend.compositionEnd();
  x.advance(2000);assert.deepEqual(x.sent,['partly composed']);
  x.setText('  ');
  x.advance(4000);assert.equal(x.sent.length,1);
});

test('queued text waits for Codex busy state, then flushes once',()=>{
  const x=setup();
  x.setBusy(true);
  x.setText('turn off the kitchen lights');
  x.advance(5000);assert.deepEqual(x.sent,[]);
  x.setBusy(false);assert.equal(x.autosend.flush(),true);
  assert.deepEqual(x.sent,['turn off the kitchen lights']);
  assert.equal(x.autosend.flush(),false);
});

test('editing a waiting draft resets the timer before it is submitted',()=>{
  const x=setup();
  x.setBusy(true);
  x.setText('play a video');
  x.advance(2200);
  x.setBusy(false);
  x.setText('play MKBHD video');
  assert.equal(x.autosend.flush(),false);
  x.advance(2000);
  assert.deepEqual(x.sent,['play MKBHD video']);
});

test('disposing the pet cancels the pending submission',()=>{
  const x=setup();
  x.setText('pause');
  x.autosend.dispose();
  x.advance(4000);
  assert.deepEqual(x.sent,[]);
});
